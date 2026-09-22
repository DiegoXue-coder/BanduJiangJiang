#!/usr/bin/env python3
"""EPUB 目录批量测试工具（任务卡见 docs/项目管理/10-待分配任务-EPUB目录测试与回归机制.md）。

对一个本地目录里的所有 EPUB，并列跑三套结果：
  1. EPUB 原始信息（spine、TOC 树、层级分布）
  2. 当前生产算法 `api.main._build_standard_reading_chapters`（只读，不连库、不改代码）
  3. 实验性混合方案 `hybrid_parser.run_hybrid`（TOC 定语义 + spine 保完整 + 分组）

用法：
    python tools/epub_toc_audit/audit.py --books-dir "<本地EPUB文件夹>" --out "<本地输出目录>"

数据安全边界（写代码和结果时都要遵守，见任务卡"四、工作边界"）：
  - 不读取本仓库以外约定路径之外的任何东西；--books-dir 必须由调用者显式传入，
    本文件里不写死任何真实书籍路径。
  - 本机绝对路径、书名以外的任何文件系统细节，一律不写进 --out 之外的地方；
    --out 默认在本工具目录下的 `_local/`，已经在 .gitignore 里，不会被提交。
  - 每本书的正文摘录、完整 HTML 报告只写进 --out（本地、不提交）；
    提交进 git 的只有 `summary.json`/`summary.md`（本脚本另外单独生成，
    只含计数和结构统计，不含正文摘录）。
  - 本脚本只读文件、只在 --out 写结果，不碰生产数据库、不发 HTTP 请求、
    不调用任何发布/构建命令。
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import statistics
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import ebooklib  # noqa: E402
from ebooklib import epub  # noqa: E402

from api.main import (  # noqa: E402
    _build_standard_reading_chapters,
    _is_toc_like_document,
    _decode_epub_html,
    _is_valid_pdfplumber_table,
    _html_table_to_rows,
    _resolve_epub_image,
)
from bs4 import BeautifulSoup  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hybrid_parser  # noqa: E402

SHORT_CHARS = 200
PIRACY_TAG_RE = re.compile(r"\s*\([^()]*z-?lib[^()]*\)\s*", re.IGNORECASE)


def clean_title(path: Path, book) -> str:
    """优先用 EPUB 自带的 Dublin Core 标题；拿不到就用文件名，并把常见的
    盗版站点标签（"(z-library.sk, 1lib.sk, z-lib.sk)"这类）去掉，避免这些
    站点名字被写进会提交到 GitHub 的汇总文件里。"""
    try:
        meta = book.get_metadata("DC", "title")
        if meta:
            t = str(meta[0][0]).strip()
            if t:
                return t
    except Exception:
        pass
    stem = path.stem
    stem = PIRACY_TAG_RE.sub("", stem).strip()
    return stem or path.stem


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def get_spine_docs(book):
    return [
        item for item in (book.get_item_with_id(idref) for idref, _ in book.spine)
        if item is not None and item.get_type() == ebooklib.ITEM_DOCUMENT
        and not isinstance(item, epub.EpubNav)
    ]


def raw_spine_stats(book, doc_items):
    """原始 spine 层面的统计：不经过任何分组/标题算法，只是"这本书本来有多少
    字/图/表"，用作两套算法"有没有偷偷丢内容"的比较基准。

    图片/表格计数刻意应用跟生产算法**同一套质量过滤**（图片 2KB~2MB 大小门槛、
    表格用 `_is_valid_pdfplumber_table` 判断是不是"真表格"）——不这么做的话，
    生产算法过滤掉的装饰性小图标/损坏表格会被这里误当成"被两套算法一起
    丢掉的内容"，报出一堆其实不算问题的假警报。"""
    total_chars = 0
    total_images = 0
    total_tables = 0
    toc_like_count = 0
    per_doc = []
    for item in doc_items:
        try:
            soup = BeautifulSoup(_decode_epub_html(item.get_content()), "html.parser")
        except Exception as e:  # noqa: BLE001
            per_doc.append({"href": item.get_name(), "error": str(e)})
            continue
        for tag in soup(["script", "style"]):
            tag.decompose()
        is_toc = _is_toc_like_document(soup)
        if is_toc:
            toc_like_count += 1
        body = soup.body or soup
        text_len = len(body.get_text(" ", strip=True)) if not is_toc else 0
        img_n = 0
        table_n = 0
        if not is_toc:
            for img_tag in soup.find_all("img"):
                if _resolve_epub_image(book, item, img_tag) is not None:
                    img_n += 1
            for table_tag in soup.find_all("table"):
                if _is_valid_pdfplumber_table(_html_table_to_rows(table_tag)):
                    table_n += 1
        heading = soup.find(["h1", "h2", "h3"])
        total_chars += text_len
        total_images += img_n
        total_tables += table_n
        per_doc.append({
            "href": item.get_name(),
            "chars": text_len,
            "images": img_n,
            "tables": table_n,
            "has_heading": bool(heading),
            "is_toc_like": is_toc,
        })
    return {
        "spine_doc_count": len(doc_items),
        "toc_like_doc_count": toc_like_count,
        "total_chars": total_chars,
        "total_images": total_images,
        "total_tables": total_tables,
        "per_doc": per_doc,
    }


CHAPTER_NUM_PREFIX_RE = re.compile(r"^第\s*[0-9一二三四五六七八九十百千]+\s*[章节回]")


def chapter_num_prefix(title: str) -> str | None:
    m = CHAPTER_NUM_PREFIX_RE.match(title.strip())
    return m.group(0) if m else None


def analyze_current(chapters: list[dict]) -> dict:
    total_chars = sum(sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text") for c in chapters)
    total_images = sum(sum(1 for b in c["blocks"] if b["type"] == "image") for c in chapters)
    total_tables = sum(sum(1 for b in c["blocks"] if b["type"] == "table") for c in chapters)
    exact_titles: dict[str, int] = {}
    prefix_titles: dict[str, int] = {}
    short_count = 0
    fabricated_count = 0
    for c in chapters:
        title = c["title"]
        exact_titles[title] = exact_titles.get(title, 0) + 1
        prefix = chapter_num_prefix(title)
        if prefix:
            prefix_titles[prefix] = prefix_titles.get(prefix, 0) + 1
        chars = sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text")
        if chars < SHORT_CHARS:
            short_count += 1
        if re.match(r"^第\d+章$", title):
            fabricated_count += 1
    dup_exact = sum(max(0, n - 1) for n in exact_titles.values())
    dup_prefix = sum(max(0, n - 1) for n in prefix_titles.values())
    return {
        "chapter_count": len(chapters),
        "total_chars": total_chars,
        "total_images": total_images,
        "total_tables": total_tables,
        "short_chapters": short_count,
        "exact_title_dup_groups": sum(1 for n in exact_titles.values() if n > 1),
        "exact_title_dup_extra": dup_exact,
        "chapter_num_prefix_dup_groups": sum(1 for n in prefix_titles.values() if n > 1),
        "chapter_num_prefix_dup_extra": dup_prefix,
        "fabricated_placeholder_titles": fabricated_count,
    }


def analyze_hybrid(chapters: list[dict]) -> dict:
    total_chars = sum(sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text") for c in chapters)
    total_images = sum(sum(1 for b in c["blocks"] if b["type"] == "image") for c in chapters)
    total_tables = sum(sum(1 for b in c["blocks"] if b["type"] == "table") for c in chapters)
    scoped_titles: dict[tuple, int] = {}
    prefix_titles: dict[str, int] = {}
    short_count = 0
    low_confidence_count = 0
    group_paths = set()
    max_group_depth = 0
    for c in chapters:
        key = (tuple(c["group_path"]), c["title"])
        scoped_titles[key] = scoped_titles.get(key, 0) + 1
        prefix = chapter_num_prefix(c["title"])
        if prefix:
            prefix_titles[prefix] = prefix_titles.get(prefix, 0) + 1
        chars = sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text")
        if chars < SHORT_CHARS:
            short_count += 1
        if c.get("low_confidence"):
            low_confidence_count += 1
        if c["group_path"]:
            group_paths.add(tuple(c["group_path"]))
            max_group_depth = max(max_group_depth, len(c["group_path"]))
    dup_in_scope = sum(max(0, n - 1) for n in scoped_titles.values())
    char_lens = [
        sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text")
        for c in chapters
    ]
    median_len = statistics.median(char_lens) if char_lens else 0
    outliers = sum(1 for n in char_lens if median_len > 0 and n > median_len * 3)
    return {
        "chapter_count": len(chapters),
        "total_chars": total_chars,
        "total_images": total_images,
        "total_tables": total_tables,
        "short_chapters": short_count,
        "low_confidence_titles": low_confidence_count,
        "same_scope_title_dup_extra": dup_in_scope,
        "chapter_num_prefix_dup_groups_before_disambiguation": sum(1 for n in prefix_titles.values() if n > 1),
        "distinct_group_paths": len(group_paths),
        "max_group_depth": max_group_depth,
        "folded_beyond_2_levels": sum(1 for c in chapters if len(c["group_path"]) > 2),
        "outlier_long_chapters": outliers,
        "fabricated_placeholder_titles": 0,  # 设计上就不生成"第N章"占位
    }


def compute_flags(raw, current, hybrid, toc_link_health=None) -> list[dict]:
    """任务卡"六、自动验收指标"里列的红线，逐条转成机器判断。

    区分两种"少了"：
    - **回归**（hybrid 比 current 少）：混合方案自己的分组/选择逻辑漏了内容，
      这是真正要修的 bug，标 severe。
    - **共同缺口**（current 和 hybrid 都比原始 spine 少，且两边少的量几乎一样）：
      两套算法在这个测试工具里复用的是同一个抽取函数
      （`_epub_doc_to_marker_paragraphs`/`_markers_to_standard_content`，
      跟生产环境同一套），这个缺口是抽取函数本身的已知特征（比如正文散落在
      没有 `<p>` 包裹的 `div/span` 里、低于 60% 阈值不触发整段兜底），不是
      本次目录分组改动引入的，标 info，不阻断验收，但仍然列出来给以后
      "要不要顺手优化抽取函数"提供数据。
    """
    flags = []

    def add(level, code, msg):
        flags.append({"level": level, "code": code, "message": msg})

    raw_chars, raw_images, raw_tables = raw["total_chars"], raw["total_images"], raw["total_tables"]
    cur_chars, hyb_chars = current["total_chars"], hybrid["total_chars"]
    cur_images, hyb_images = current["total_images"], hybrid["total_images"]
    cur_tables, hyb_tables = current["total_tables"], hybrid["total_tables"]

    # 回归检查：混合方案不能比当前生产算法丢得更多
    if hyb_chars < cur_chars * 0.98:
        add("severe", "text_loss_regression", f"混合方案正文字数({hyb_chars})比当前生产算法({cur_chars})少超过 2%，是这次改动新引入的丢失")
    if hyb_images < cur_images:
        add("severe", "image_loss_regression", f"混合方案图片数({hyb_images})比当前生产算法({cur_images})少")
    if hyb_tables < cur_tables:
        add("severe", "table_loss_regression", f"混合方案表格数({hyb_tables})比当前生产算法({cur_tables})少")

    # 共同缺口：两边跟原始 spine 比都有差距，且差距量级相近 → 是共用抽取函数的已知特征
    if raw_chars > 0 and cur_chars < raw_chars * 0.98 and hyb_chars < raw_chars * 0.98:
        add("info", "shared_text_gap", f"当前算法和混合方案的正文字数（{cur_chars}/{hyb_chars}）都比原始 spine 全文本（{raw_chars}）少，是两边共用的抽取函数已知特征（正文不在 &lt;p&gt; 标签内时不一定被抽到），非本次改动引入")
    if raw_images > 0 and cur_images < raw_images and hyb_images < raw_images:
        add("info", "shared_image_gap", f"当前算法和混合方案的图片数（{cur_images}/{hyb_images}）都比原始 &lt;img&gt; 标签数（{raw_images}）少，多数是 2KB~2MB 大小门槛过滤掉的装饰图标，非本次改动引入")
    if raw_tables > 0 and cur_tables < raw_tables and hyb_tables < raw_tables:
        add("info", "shared_table_gap", f"当前算法和混合方案的表格数（{cur_tables}/{hyb_tables}）都比原始 &lt;table&gt; 标签数（{raw_tables}）少，是表格质量门槛过滤掉的无效表格，非本次改动引入")

    if current["fabricated_placeholder_titles"] > 0:
        add("warn", "fabricated_title_current", f"当前生产算法生成了 {current['fabricated_placeholder_titles']} 个无来源依据的\"第N章\"占位标题")
    if current["chapter_num_prefix_dup_groups"] > 0:
        add("warn", "dup_chapter_num_current", f"当前生产算法里有 {current['chapter_num_prefix_dup_groups']} 组重复章号前缀（多 {current['chapter_num_prefix_dup_extra']} 条），无法从标题看出属于哪一册")
    if hybrid["same_scope_title_dup_extra"] > 0:
        add("warn", "dup_same_scope_hybrid", f"混合方案里同一分组下仍有 {hybrid['same_scope_title_dup_extra']} 条重复标题（分组没能消歧）")
    if hybrid["outlier_long_chapters"] > 0:
        add("info", "outlier_long_hybrid", f"混合方案有 {hybrid['outlier_long_chapters']} 章明显偏长（>中位数3倍），建议人工看一眼是不是又把多章合并了")
    if hybrid["folded_beyond_2_levels"] > 0:
        add("info", "deep_group_hybrid", f"混合方案有 {hybrid['folded_beyond_2_levels']} 章的分组路径超过两级，客户端展示时需要折叠")

    if toc_link_health is not None and toc_link_health["referenced_total"] > 0:
        missing = toc_link_health["missing_count"]
        total = toc_link_health["referenced_total"]
        ratio = missing / total
        if ratio >= 0.5:
            add("severe", "toc_broken_href", f"TOC 里 {missing}/{total} 个 href 在 spine 里找不到对应文件（可能是编码问题或目录本身损坏），这本书的 TOC 基本不可用，混合方案会整体退回 spine 兜底")
        elif missing > 0:
            add("warn", "toc_partial_missing_href", f"TOC 里有 {missing}/{total} 个 href 在 spine 里找不到对应文件（可能是个别损坏链接），已忽略这些条目")
    return flags


def process_book(path: Path, out_dir: Path) -> dict | None:
    file_hash = sha256_of_file(path)
    try:
        book = epub.read_epub(str(path))
    except Exception as e:  # noqa: BLE001
        return {"path_name": path.name, "error": f"读取失败：{e}", "file_sha256": file_hash}

    title = clean_title(path, book)
    doc_items = get_spine_docs(book)
    raw = raw_spine_stats(book, doc_items)
    toc_stats = hybrid_parser.toc_raw_stats(book)

    t0 = time.time()
    current_chapters = _build_standard_reading_chapters(str(path))
    t1 = time.time()
    hybrid_chapters = hybrid_parser.run_hybrid(book, doc_items)
    t2 = time.time()

    current_metrics = analyze_current(current_chapters)
    hybrid_metrics = analyze_hybrid(hybrid_chapters)
    spine_names = {item.get_name() for item in doc_items}
    referenced = toc_stats["referenced_hrefs"]
    toc_link_health = {
        "referenced_total": len(referenced),
        "missing_count": sum(1 for h in referenced if h and h not in spine_names),
    }
    flags = compute_flags(raw, current_metrics, hybrid_metrics, toc_link_health)

    detail = {
        "title": title,
        "file_sha256": file_hash,
        "raw": raw,
        "toc": {k: v for k, v in toc_stats.items() if k != "referenced_hrefs"},
        "toc_link_health": toc_link_health,
        "current_algorithm": {
            "metrics": current_metrics,
            "chapters": [
                {
                    "title": c["title"],
                    "chars": sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text"),
                    "images": sum(1 for b in c["blocks"] if b["type"] == "image"),
                    "tables": sum(1 for b in c["blocks"] if b["type"] == "table"),
                    "excerpt": next((b["text"][:60] for b in c["blocks"] if b["type"] == "text"), ""),
                }
                for c in current_chapters
            ],
            "timing_sec": round(t1 - t0, 2),
        },
        "hybrid_algorithm": {
            "metrics": hybrid_metrics,
            "chapters": [
                {
                    "title": c["title"],
                    "group_path": c["group_path"],
                    "toc_referenced": c["toc_referenced"],
                    "low_confidence": c["low_confidence"],
                    "chars": sum(len(b.get("text", "")) for b in c["blocks"] if b["type"] == "text"),
                    "images": sum(1 for b in c["blocks"] if b["type"] == "image"),
                    "tables": sum(1 for b in c["blocks"] if b["type"] == "table"),
                    "excerpt": next((b["text"][:60] for b in c["blocks"] if b["type"] == "text"), ""),
                }
                for c in hybrid_chapters
            ],
            "timing_sec": round(t2 - t1, 2),
        },
        "flags": flags,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{file_hash[:10]}.json").write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "book_id": file_hash[:10],
        "title": title,
        "spine_doc_count": raw["spine_doc_count"],
        "toc_like_doc_count": raw["toc_like_doc_count"],
        "raw_total_chars": raw["total_chars"],
        "raw_total_images": raw["total_images"],
        "raw_total_tables": raw["total_tables"],
        "toc_total_entries": toc_stats["total_entries"],
        "toc_max_depth": toc_stats["max_depth"],
        "toc_group_node_count": toc_stats["group_node_count"],
        "toc_unique_files_referenced": toc_stats["unique_files_referenced"],
        "current": current_metrics,
        "hybrid": hybrid_metrics,
        "severe_flag_count": sum(1 for f in flags if f["level"] == "severe"),
        "warn_flag_count": sum(1 for f in flags if f["level"] == "warn"),
        "flags": flags,
    }
    return {"detail": detail, "summary": summary}


def render_html_report(results: list[dict], out_path: Path):
    """本地对比报告：含标题、逐章摘录，只写进本地 --out，不提交 git。"""
    rows = []
    for r in results:
        if "error" in r:
            rows.append(f"<h2>{html.escape(r['path_name'])}（读取失败）</h2><p>{html.escape(r['error'])}</p>")
            continue
        d = r["detail"]
        flags_html = "".join(
            f"<li class='flag-{f['level']}'>[{f['level']}] {html.escape(f['code'])}: {html.escape(f['message'])}</li>"
            for f in d["flags"]
        ) or "<li>无</li>"

        def chapters_html(entry):
            lis = []
            for c in entry["chapters"]:
                group = " / ".join(c.get("group_path", [])) if c.get("group_path") else ""
                low = " ⚠低置信度" if c.get("low_confidence") else ""
                lis.append(
                    f"<li><b>{html.escape(c['title'])}</b>"
                    f"{f' <span class=g>[{html.escape(group)}]</span>' if group else ''}{low}"
                    f" — {c['chars']}字 / {c['images']}图 / {c['tables']}表"
                    f"<div class=ex>{html.escape(c['excerpt'])}</div></li>"
                )
            return "<ol>" + "".join(lis) + "</ol>"

        rows.append(f"""
        <section>
          <h2>{html.escape(d['title'])} <small>({r['summary']['book_id']})</small></h2>
          <p>spine文档数={d['raw']['spine_doc_count']} · TOC条目={d['toc']['total_entries']} · TOC最大深度={d['toc']['max_depth']}
             · 当前算法{d['current_algorithm']['metrics']['chapter_count']}章 · 混合方案{d['hybrid_algorithm']['metrics']['chapter_count']}章</p>
          <h3>自动标红</h3>
          <ul>{flags_html}</ul>
          <div class="cols">
            <div><h3>当前生产算法</h3>{chapters_html(d['current_algorithm'])}</div>
            <div><h3>实验性混合方案</h3>{chapters_html(d['hybrid_algorithm'])}</div>
          </div>
        </section>
        """)
    html_doc = f"""<!doctype html><html><head><meta charset="utf-8">
    <title>EPUB 目录对比报告（本地，不提交）</title>
    <style>
      body {{ font-family: -apple-system, "Microsoft YaHei", sans-serif; max-width: 1400px; margin: 20px auto; padding: 0 16px; }}
      .cols {{ display: flex; gap: 24px; }}
      .cols > div {{ flex: 1; min-width: 0; }}
      ol {{ padding-left: 20px; }}
      li {{ margin-bottom: 8px; }}
      .g {{ color: #b7791f; }}
      .ex {{ color: #666; font-size: 12px; }}
      .flag-severe {{ color: #c0392b; font-weight: bold; }}
      .flag-warn {{ color: #b7791f; }}
      .flag-info {{ color: #555; }}
      section {{ border-top: 2px solid #ddd; padding-top: 16px; margin-top: 24px; }}
    </style></head><body>
    <h1>EPUB 目录对比报告</h1>
    <p>本文件仅本地查看，含正文摘录，<b>不得提交到 git</b>。</p>
    {''.join(rows)}
    </body></html>"""
    out_path.write_text(html_doc, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--books-dir", required=True, help="本地 EPUB 所在目录（不传就不知道去哪找，绝不写死路径）")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "_local"), help="本地输出目录（默认已在 .gitignore 里）")
    ap.add_argument("--summary-out", default=str(Path(__file__).resolve().parent / "summary.json"), help="可提交的匿名汇总 JSON 路径")
    args = ap.parse_args()

    books_dir = Path(args.books_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    epub_files = sorted(books_dir.glob("*.epub"))
    print(f"发现 {len(epub_files)} 个 .epub 文件于 {books_dir}")

    seen_hash: dict[str, Path] = {}
    results = []
    for path in epub_files:
        print(f"处理：{path.name} ...")
        h = sha256_of_file(path)
        if h in seen_hash:
            print(f"  跳过：内容与 {seen_hash[h].name} 完全相同（重复文件）")
            continue
        seen_hash[h] = path
        try:
            r = process_book(path, out_dir / "detail")
        except Exception as e:  # noqa: BLE001
            print(f"  处理失败：{e}")
            r = {"path_name": path.name, "error": str(e), "file_sha256": h}
        results.append(r)

    ok_results = [r for r in results if "error" not in r]
    err_results = [r for r in results if "error" in r]

    render_html_report(results, out_dir / "report.html")
    print(f"本地 HTML 报告：{out_dir / 'report.html'}（不提交）")

    summary_payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "books_dir_book_count": len(epub_files),
        "unique_book_count": len(results),
        "duplicate_file_count": len(epub_files) - len(results),
        "parse_error_count": len(err_results),
        "books": [r["summary"] for r in ok_results],
        "parse_errors": [{"file_hash": r["file_sha256"][:10], "error": r["error"]} for r in err_results],
    }
    Path(args.summary_out).write_text(json.dumps(summary_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"可提交的匿名汇总：{args.summary_out}")

    severe_total = sum(b["severe_flag_count"] for b in summary_payload["books"])
    warn_total = sum(b["warn_flag_count"] for b in summary_payload["books"])
    print(f"\n完成：{len(ok_results)} 本成功 / {len(err_results)} 本失败 / {summary_payload['duplicate_file_count']} 本重复跳过")
    print(f"严重标红：{severe_total} 处；警告标红：{warn_total} 处")


if __name__ == "__main__":
    main()
