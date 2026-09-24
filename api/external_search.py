"""外部查证（AI 质量第二阶段 MVP）。

给"当前页正文/划线"这条书内证据链之外，补一条"现实世界事实"证据链：问题看起来
是在问书本之外的现实事实（作者近况、时效性数据等）、且书内又没有依据时，去查
一下通义千问（DashScope 原生接口，带 `enable_search`）,把它搜到的结构化来源
（带链接）交给主模型（DeepSeek）自己组织最终回答，不直接把千问自己写的答案
展示给用户——这样语气、安全规则仍然统一由 DeepSeek 那一套负责，呼应
`docs/项目管理/14-方案讨论-外部资源联网查证.md`"不是换模型"那条澄清。

选型依据、真实对比测试结果见 `docs/项目管理/14-方案讨论-外部资源联网查证.md`
和 `docs/项目管理/15-任务卡-外部查证MVP.md`：千问在实测里明显强于博查（原始
搜索排名前10仍搜不到相关内容），所以选它，不是巧合。

本模块独立于 `api/main.py`，只做纯函数+一个网络调用，方便单测、也方便跟其他
同时在改 `main.py` 的人减少冲突。
"""

import os
from urllib.parse import urlparse

import httpx

# DashScope 原生接口地址。优先用产品负责人开通的"业务空间专属域名"（性能更好、
# 官方共享域名 dashscope.aliyuncs.com 将于 2026-09-30 起停止支持新特性，仍可用但
# 不建议新业务再用），没配就退回官方共享域名，保证没配专属域名时功能仍然可用。
DASHSCOPE_BASE_URL = (
    os.environ.get("DASHSCOPE_BASE_URL", "").rstrip("/")
    or "https://dashscope.aliyuncs.com/api/v1"
)
DASHSCOPE_SEARCH_MODEL = os.environ.get("DASHSCOPE_SEARCH_MODEL", "qwen-flash")
# 2026-09-24真机复测实测：千问联网搜索（返回10条来源那种）经常要6.7~6.9秒，
# 原来设的6秒超时几乎每次都卡在临界点被打断，表现成"总是搜不到"，误以为是
# 千问不稳定——其实是自己的超时设短了。改成12秒留够余量，仍然是"几秒级"，
# 不会让用户觉得卡死；触发条件本身已经过滤了大部分问题，只有少数会走这条路。
EXTERNAL_SEARCH_TIMEOUT_S = float(os.environ.get("EXTERNAL_SEARCH_TIMEOUT_S", "12"))

# ── 触发判断（MVP：规则+关键词，不是模型自主决定要不要查）──────────────────
# 真正"模型自己判断该不该查"需要接 DeepSeek 的工具调用做两轮对话，风险和工作量
# 都更大，MVP先用便宜可靠的规则版，命中现实世界/时效性信号才触发；正式版可以
# 升级成工具调用，见15号任务卡"待确认"部分之外的后续方向。
_TIME_SENSITIVE_HINTS = ("现在", "最近", "目前", "最新", "近期", "如今", "现状", "今年", "去年")
_REAL_WORLD_HINTS = (
    "作者", "现实中", "真实存在", "历史上", "新闻", "报道", "官方", "数据是", "规模", "统计",
    "创始人", "创办人", "谁创办", "成立于", "营收", "收入", "利润", "财报", "市值", "总部",
    "首席执行官", "CEO", "员工数", "市场份额",
)
# 2026-09-24真机实测发现的真bug：听书页打断提问时，context永远带着当前正在念
# 的那句(selection非空)，导致available_evidence_type变成user_selection——原来
# 要求"必须是insufficient_context/general_knowledge才触发"这条限制，会让所有
# 听书场景的现实世界问题永远查不到（用户问"作者现在在干什么"，AI只会说"需要
# 联网查证才能回答"，但从来没有真的去查）。改成不看available_evidence_type，
# 只看问题本身的信号；同时新增一份"书内指代词"名单，命中"这段/这句/这里/原文/
# 书中"这类明确指向当前文本的说法就不触发，避免真正在问书内内容时被现实世界
# 关键词(比如"作者现在这段话什么意思"里的"作者""现在")误触发。
_BOOK_ANCHORED_HINTS = ("这段", "这句", "这里", "这一段", "这一句", "原文", "书中", "书里", "上文", "上面这")


# 问题里出现"这本书/本书"这类模糊指代时，单独拿这句话去搜引擎搜不到东西——
# "这本书的作者现在在干什么"这句话本身没有任何具名实体，千问不知道"这本书"
# 指的是谁，实测会搜出完全不相关的结果（2026-09-24真机复测发现，问罗伯特·清崎
# 近况，搜索结果却是几个不相关的作家）。有书名/作者信息时，把它们拼进搜索
# 查询里再发给千问，不改变发给用户看的问题原文，只改这一次搜索请求本身。
_VAGUE_BOOK_REFERENCE_HINTS = ("这本书", "本书", "这本")
_VAGUE_CONVERSATION_REFERENCE_HINTS = (
    "这些", "这几家", "上述", "前面提到", "刚才提到", "他们", "它们", "其创始", "其营收",
)


def build_external_search_query(
    question: str, book_title: str, author: str, history: list[dict] | None = None,
) -> str:
    """给模糊指代的问题补上具体书名/作者再去搜；没有模糊指代或没有书名信息时
    原样返回问题，不画蛇添足。连续追问里的“这些/他们/上述”需要最近对话才能
    知道指的是谁，只把当前一句交给搜索服务会丢掉具名实体。"""
    text = question or ""
    prefixes: list[str] = []
    if book_title and any(h in text for h in _VAGUE_BOOK_REFERENCE_HINTS):
        author_part = f"，作者{author}" if author else ""
        prefixes.append(f"书籍背景：《{book_title}》{author_part}")

    if any(h in text for h in _VAGUE_CONVERSATION_REFERENCE_HINTS):
        recent_turns = []
        for turn in (history or [])[-4:]:
            role = turn.get("role")
            content = str(turn.get("content", "")).strip()
            if role not in ("user", "assistant") or not content:
                continue
            label = "用户" if role == "user" else "助手"
            recent_turns.append(f"{label}：{content[:600]}")
        if recent_turns:
            prefixes.append("最近对话：" + "\n".join(recent_turns))

    if not prefixes:
        return text
    return "\n".join(prefixes) + f"\n当前要查证的问题：{text}"


def should_trigger_external_search(question: str, style: str, available_evidence_type: str) -> bool:
    """苏格拉底模式(以书内文本讨论为主)整体不触发。**不看`available_evidence_type`**
    ——听书打断提问、划线提问这类场景 context 里几乎总是带着一段书内文字
    (`selection`非空)，`available_evidence_type`会是`user_selection`，如果拿它当
    触发条件的必要前提，会导致这些场景下的现实世界问题永远查不到（2026-09-24
    真机实测发现的真bug，见开发进度记录续二十九）。改成只看问题本身：带明确的
    "这段/这句/原文/书中"这类指代当前文本的说法就不触发（判断是在问书里写的
    内容，即使问题里同时出现"作者""现在"这类词）；否则命中现实世界/时效性信号
    就触发，不管当前有没有划线或页面正文。"""
    if style == "socratic":
        return False
    text = question or ""
    if any(h in text for h in _BOOK_ANCHORED_HINTS):
        return False
    return any(h in text for h in _TIME_SENSITIVE_HINTS) or any(h in text for h in _REAL_WORLD_HINTS)


# ── 来源可信度标注：纯域名规则匹配，不额外调用AI ────────────────────────────
_TRUSTED_DOMAIN_SUFFIXES = (
    ".gov.cn", ".edu.cn", ".gov", "who.int",
    "baike.baidu.com", "xinhuanet.com", "people.com.cn", "cctv.com",
    "chinanews.com.cn", "gmw.cn", "cnstock.com", "thepaper.cn",
    "jiemian.com", "caixin.com", "yicai.com", "stcn.com",
)


def label_source_trust(url: str) -> str:
    """域名命中信任名单标"较可信"，否则标"来源未知"——只是粗粒度分级，不是
    对内容本身事实核查，具体名单后续可以按实际来源分布持续补充。"""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return "来源未知"
    if any(host == d.lstrip(".") or host.endswith(d) for d in _TRUSTED_DOMAIN_SUFFIXES):
        return "较可信"
    return "来源未知"


EXTERNAL_SEARCH_MAX_ATTEMPTS = int(os.environ.get("EXTERNAL_SEARCH_MAX_ATTEMPTS", "2"))


async def fetch_external_evidence(client: httpx.AsyncClient, api_key: str, question: str) -> dict | None:
    """调千问查，最多重试一次。真实测试反复验证过：同一个问题不同时刻调用，
    有时候能拿到十条真实来源，有时候search_results就是空数组——不是问题
    本身没有信息，是这个搜索服务单次调用本身就有一定失败率(2026-09-24决策层
    多轮真机复测确认过，不是猜测)。第一次没拿到结果时马上重试一次，明显能
    提高命中率，成本是失败这条路径上多等几秒——只有第一次真的没查到才会
    触发这多出来的一次调用，成功路径完全不受影响。"""
    if not api_key:
        return None
    for attempt in range(EXTERNAL_SEARCH_MAX_ATTEMPTS):
        result = await _fetch_once(client, api_key, question)
        if result:
            return result
    return None


async def _fetch_once(client: httpx.AsyncClient, api_key: str, question: str) -> dict | None:
    try:
        resp = await client.post(
            f"{DASHSCOPE_BASE_URL}/services/aigc/text-generation/generation",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": DASHSCOPE_SEARCH_MODEL,
                "input": {"messages": [{"role": "user", "content": question}]},
                "parameters": {
                    "enable_search": True,
                    "search_options": {"enable_source": True, "enable_citation": True},
                    "result_format": "message",
                },
            },
            timeout=EXTERNAL_SEARCH_TIMEOUT_S,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception:
        return None

    output = data.get("output") or {}
    raw_sources = ((output.get("search_info") or {}).get("search_results") or [])
    if not raw_sources:
        return None
    sources = [
        {
            "index": item.get("index"),
            "title": item.get("title") or "",
            "url": item.get("url") or "",
            "site_name": item.get("site_name") or "",
            "trust": label_source_trust(item.get("url") or ""),
        }
        for item in raw_sources
        if item.get("url")
    ]
    if not sources:
        return None
    choices = output.get("choices") or []
    reference_text = ""
    if choices:
        reference_text = str(((choices[0] or {}).get("message") or {}).get("content") or "").strip()
    return {"reference_text": reference_text[:5000], "sources": sources}


def format_external_evidence_block(evidence: dict) -> str:
    """组装成独立的【外部查证】标签块，跟书内正文分开，格式跟现有
    context_block 里其它【】标签保持一致的风格（见 _build_book_context）。"""
    lines = [
        f"[{s['index']}] {s['title']}（{s['site_name']}，{s['trust']}）：{s['url']}"
        for s in evidence["sources"]
    ]
    reference_text = str(evidence.get("reference_text") or "").strip()
    sections = []
    if reference_text:
        sections.append(
            "【外部查证参考摘要，由搜索模型根据下列来源生成，不等于已经核实；"
            "只采用能被来源支持的内容】\n" + reference_text
        )
    sections.append(
        "【外部查证来源，仅供参考，需在回答中用[数字]标明引用哪一条，多条来源冲突要如实说明分歧】\n"
        + "\n".join(lines)
    )
    return "\n".join(sections)
