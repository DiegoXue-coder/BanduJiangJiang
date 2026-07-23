# -*- coding: utf-8 -*-
"""跨书关联检测自动化校验工具（阶段八，见 docs/项目管理/05-验收标准.md）。

范围声明：这不是"离线算相似度、看一份文字报告"的工具（那种做法在
api/eval/run_eval.py 已经有先例，本来更省事）——验收标准明确要求结果必须能
在 App 里被用户亲眼看到，所以这里改用真实的生产接口（/app/books/{id}/highlights、
/ask、/history），把 DeepSeek 生成的候选文字对存成真实的划线+问答记录。跑完
直接打开 App 的"划线复盘"页——划线/问答tab能看到新增的记录，关联主题tab能
看到当前的相似度阈值有没有把"应该关联"和"不应该关联"这两类正确分开。

用 DeepSeek 生成候选对，而不是从库里已有的真实划线里挑，是因为今天真机测试
已经证实：现在账号里的划线/问答样本量太小，跨书概念重叠本来就少，现有语料
不够测——这个工具的目的就是专门造一批"明确应该关联"/"明确不应该关联"的对照组，
不是模拟真实用户行为。

运行前提：
1. EXTENSION_SECRET 环境变量——生产环境用来验证 /app 接口请求的 HMAC 日签名
   密钥，本地 api/.env 里没有这个值（只在 Railway 生产环境配置），需要额外
   提供才能跑，不然所有请求都会 401。
2. DEEPSEEK_API_KEY——已经在本地 api/.env 里，用于生成候选文字对+生成问答
   的"回答"部分。

用法：
    cd api && python eval/relation_validation.py [--pairs 4] [--dry-run]
    --dry-run 只打印 DeepSeek 生成的候选对，不实际调用任何写接口，先过一眼
    候选内容像不像样再决定要不要真的写进生产库。
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

import httpx
from openai import OpenAI

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

API_BASE = os.environ.get("RELATION_VALIDATION_API_BASE", "https://bandujiangjiang-production.up.railway.app")
MODEL = "deepseek-v4-flash"


def _ext_token() -> str:
    secret = os.environ.get("EXTENSION_SECRET", "")
    if not secret:
        print("缺少 EXTENSION_SECRET 环境变量——这个是生产环境的鉴权密钥，"
              "本地 .env 里没有，需要额外提供才能调用真实接口。")
        sys.exit(1)
    today = datetime.date.today().isoformat()
    return hmac.new(secret.encode(), today.encode(), hashlib.sha256).hexdigest()[:32]


def _session() -> httpx.Client:
    return httpx.Client(headers={"X-Extension-Token": _ext_token()}, timeout=30.0)


def get_library(session: httpx.Client) -> list[dict]:
    resp = session.get(f"{API_BASE}/app/books")
    resp.raise_for_status()
    return resp.json()  # [{id, title, author, added_at}, ...]


def generate_candidate_pairs(ds: OpenAI, book_titles: list[str], n_pairs: int) -> list[dict]:
    """让 DeepSeek 生成候选文字对。一半 relation="yes"（不同书里明显讨论同一
    概念的真实原文片段）、一半 relation="no"（毫不相关的主题）。只让模型在
    书库里真实存在的这几本书之间选，保证后面能匹配上真实的 book_id。"""
    prompt = f"""你是古籍研究专家。书库里现在有这些书：{"、".join(book_titles)}。

请生成 {n_pairs} 组"跨书文字对"，用于测试一个"划线关联检测"功能准不准。
每组必须来自两本不同的书，给出真实存在的原文片段（不超过80字，不要编造，
必须是这两本古籍里真实能找到的句子）。

一半的组要满足 relation="yes"——两段话明确在讨论同一个概念/主题（比如都在
讲"修身""义利之辨""仁""道法自然"这类），一个熟悉古籍的人一眼就能看出关联；
另一半 relation="no"——两段话主题毫不相关，一个熟悉古籍的人一眼就能看出
没有关联。

只输出一个JSON数组，每个元素格式：
{{"relation": "yes"或"no", "shared_concept": "关联点是什么（relation=no时留空字符串）",
  "a": {{"book_title": "书名（必须完全匹配书库列表里的书名）", "text": "原文片段"}},
  "b": {{"book_title": "书名（必须完全匹配书库列表里的书名，且跟a不同）", "text": "原文片段"}}}}
不要输出任何其他内容。"""

    resp = ds.chat.completions.create(
        model=MODEL, max_tokens=2000, temperature=0.5,
        messages=[{"role": "user", "content": prompt}],
        extra_body={"thinking": {"type": "disabled"}},
    )
    raw = resp.choices[0].message.content.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw)


def generate_answer(ds: OpenAI, passage: str) -> str:
    """给这段原文生成一句简短解释，凑成一条真实的问答记录（不是空话，跟真实
    用户用"讲解"功能得到的回答是同一种调用方式，只是这里直接用非流式一次性拿结果）。"""
    resp = ds.chat.completions.create(
        model=MODEL, max_tokens=200, temperature=0.5,
        messages=[
            {"role": "system", "content": "你是读书助手，用2-3句白话讲清楚用户划线的这段古文在说什么，不超过100字。"},
            {"role": "user", "content": passage},
        ],
        extra_body={"thinking": {"type": "disabled"}},
    )
    return resp.choices[0].message.content.strip()


def save_pair_item(session: httpx.Client, ds: OpenAI, book_id: int, book_title: str, text: str) -> None:
    # 1. 真实划线（/app/books/{id}/highlights）——cfi_location 留空：这个工具
    #    测的是关联检测准不准，不是"跳转到原文"这个功能，没有必要为了凑一个
    #    看起来真实的CFI去解析EPUB定位具体位置，那是另一件事。
    r = session.post(f"{API_BASE}/app/books/{book_id}/highlights",
                      json={"cfiLocation": "", "highlightedText": text})
    r.raise_for_status()

    # 2. 真实问答记录（/history）——跟真实用户"划线→问AI"的行为一致，答案是
    #    真的调用 DeepSeek 生成的，不是随便拼一句占位符。
    answer = generate_answer(ds, text)
    r = session.post(f"{API_BASE}/history", json={
        "book_id": str(book_id), "book_title": book_title,
        "question": "讲解一下这段话", "answer": answer, "selection": text,
    })
    r.raise_for_status()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=4, help="生成几组文字对（一半yes一半no）")
    parser.add_argument("--dry-run", action="store_true", help="只打印候选对，不实际写入生产库")
    args = parser.parse_args()

    ds_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not ds_key:
        print("缺少 DEEPSEEK_API_KEY")
        sys.exit(1)
    ds = OpenAI(api_key=ds_key, base_url="https://api.deepseek.com")

    session = None
    library = []
    if not args.dry_run:
        session = _session()
        library = get_library(session)
        if not library:
            print("书库是空的，没有真实书本可以挂靠候选文字对，先导入几本书再跑这个工具")
            sys.exit(1)
    else:
        # --dry-run 不需要真实鉴权，用已知的书名列表跑一遍生成逻辑就够
        library = [{"id": 0, "title": t} for t in
                   ["论语", "大学", "中庸", "孟子", "道德经", "庄子", "墨子"]]

    title_to_id = {b["title"]: b["id"] for b in library}
    pairs = generate_candidate_pairs(ds, list(title_to_id.keys()), args.pairs)

    print(f"生成了 {len(pairs)} 组候选文字对：\n")
    for i, pair in enumerate(pairs, 1):
        tag = "【应关联】" if pair["relation"] == "yes" else "【不应关联】"
        print(f"{i}. {tag} 关联点: {pair.get('shared_concept') or '(无)'}")
        print(f"   A《{pair['a']['book_title']}》: {pair['a']['text']}")
        print(f"   B《{pair['b']['book_title']}》: {pair['b']['text']}\n")

    if args.dry_run:
        print("--dry-run 模式，没有写入任何数据。看着靠谱的话去掉这个参数重跑。")
        return

    saved, skipped = 0, []
    for i, pair in enumerate(pairs, 1):
        for side in ("a", "b"):
            item = pair[side]
            book_id = title_to_id.get(item["book_title"])
            if not book_id:
                skipped.append(f"第{i}组-{side}: 书名「{item['book_title']}」在书库里找不到匹配，跳过")
                continue
            try:
                save_pair_item(session, ds, book_id, item["book_title"], item["text"])
                saved += 1
                print(f"已保存 第{i}组-{side} 《{item['book_title']}》")
            except Exception as e:
                skipped.append(f"第{i}组-{side}: 保存失败 {e}")

    print(f"\n完成：成功保存 {saved} 条，跳过/失败 {len(skipped)} 条")
    for s in skipped:
        print(f"  - {s}")
    print("\n现在去 App 的「划线复盘」页看结果：划线/问答tab应该能看到刚生成的这些内容，"
          "关联主题tab里检查一下标了【应关联】的那些对有没有被正确识别出来、"
          "标了【不应关联】的有没有被误判成相关。")


if __name__ == "__main__":
    main()
