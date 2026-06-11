"""伴读讲讲 — FastAPI 后端（DeepSeek 对话 + SiliconFlow SenseVoice 语音识别）"""

import os
import io
import re
import time
import json
import asyncio
import sqlite3
import hashlib
from pathlib import Path
from collections import defaultdict

import numpy as np

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from openai import OpenAI
import edge_tts
import av
import httpx
from dotenv import load_dotenv

load_dotenv()

# ── API Key 解析（优先请求头，fallback 到 env，本地开发用）──────────

def _ds_key(request: Request) -> str:
    return request.headers.get("x-deepseek-key", "").strip() or os.environ.get("DEEPSEEK_API_KEY", "")

def _sf_key(request: Request) -> str:
    return request.headers.get("x-siliconflow-key", "").strip() or os.environ.get("SILICONFLOW_API_KEY", "")

def _wr_key(request: Request) -> str:
    return request.headers.get("x-weread-key", "").strip() or os.environ.get("WEREAD_API_KEY", "")

def _make_ds(key: str) -> OpenAI | None:
    if not key:
        return None
    return OpenAI(api_key=key, base_url="https://api.deepseek.com")

def _make_sf(key: str) -> OpenAI | None:
    if not key:
        return None
    return OpenAI(api_key=key, base_url="https://api.siliconflow.cn/v1")

# ── 知识库 SQLite ──────────────────────────────────────────────────

DB_PATH = Path(os.environ.get("DB_PATH", str(Path(__file__).parent / "history.db")))

def _get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

SIMILARITY_THRESHOLD = 0.72  # 余弦相似度阈值，低于此值不展示

def _init_db():
    with _get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS qa_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                book_id       TEXT DEFAULT '',
                book_title    TEXT DEFAULT '',
                chapter_title TEXT DEFAULT '',
                question      TEXT NOT NULL,
                answer        TEXT NOT NULL,
                selection     TEXT DEFAULT '',
                embedding     TEXT DEFAULT ''
            )
        """)
        # 旧表兼容：补加 embedding 列
        cols = [r[1] for r in conn.execute("PRAGMA table_info(qa_history)").fetchall()]
        if "embedding" not in cols:
            conn.execute("ALTER TABLE qa_history ADD COLUMN embedding TEXT DEFAULT ''")
        conn.commit()

_init_db()

def _cleanup_old_records():
    """删除 90 天前的问答记录，防止数据库无限增长。"""
    with _get_db() as conn:
        conn.execute(
            "DELETE FROM qa_history WHERE created_at < datetime('now', '-90 days')"
        )
        conn.commit()

# 启动时清理一次
try:
    _cleanup_old_records()
except Exception as e:
    print(f"[清理] 旧记录清理失败: {e}")

# ── 免费额度追踪 ────────────────────────────────────────────────────

FREE_DAILY_LIMIT = 20  # 每 IP 每天免费次数

def _init_usage_db():
    with _get_db() as conn:
        # 检测旧表结构（有 date 列），有则删除重建
        cols = [r[1] for r in conn.execute("PRAGMA table_info(usage_limits)").fetchall()]
        if "date" in cols:
            conn.execute("DROP TABLE usage_limits")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS usage_limits (
                ip  TEXT PRIMARY KEY,
                cnt INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.commit()

_init_usage_db()

def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    raw = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else "unknown"
    )
    # 对 IP 做单向哈希，不存明文（隐私合规）
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

# ── 速率限制（每 IP 每分钟最多 30 次 /ask）────────────────────────
_rate_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT   = 30   # 次
RATE_WINDOW  = 60   # 秒

def _check_rate_limit(ip: str) -> bool:
    """返回 True 表示允许，False 表示超限。"""
    now = time.time()
    hits = _rate_store[ip]
    # 清理窗口外的记录
    _rate_store[ip] = [t for t in hits if now - t < RATE_WINDOW]
    if len(_rate_store[ip]) >= RATE_LIMIT:
        return False
    _rate_store[ip].append(now)
    return True

def _check_and_increment_free(ip: str) -> tuple[bool, int]:
    """返回 (allowed, remaining)。allowed=False 时已超限，不计数。"""
    with _get_db() as conn:
        row = conn.execute(
            "SELECT cnt FROM usage_limits WHERE ip=?", (ip,)
        ).fetchone()
        cnt = row["cnt"] if row else 0
        if cnt >= FREE_DAILY_LIMIT:
            return False, 0
        new_cnt = cnt + 1
        conn.execute(
            "INSERT INTO usage_limits(ip, cnt) VALUES(?,?) "
            "ON CONFLICT(ip) DO UPDATE SET cnt=excluded.cnt",
            (ip, new_cnt)
        )
        conn.commit()
        return True, FREE_DAILY_LIMIT - new_cnt

def _get_remaining_free(ip: str) -> int:
    with _get_db() as conn:
        row = conn.execute(
            "SELECT cnt FROM usage_limits WHERE ip=?", (ip,)
        ).fetchone()
        cnt = row["cnt"] if row else 0
        return max(0, FREE_DAILY_LIMIT - cnt)

MEMORY_THRESHOLD = 0.65  # 语境记忆阈值，比跨书展示更宽松

async def _embed(text: str, sf: OpenAI | None = None) -> list[float]:
    """调用 SiliconFlow bge-m3 生成文本向量，失败时抛异常。"""
    c = sf or sf_client
    if not c:
        raise ValueError("SiliconFlow key not configured")
    resp = await asyncio.to_thread(
        lambda: c.embeddings.create(
            model="BAAI/bge-m3",
            input=text[:1000],
        )
    )
    return resp.data[0].embedding

app = FastAPI(title="伴读讲讲 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Chrome 扩展 origin 每次不同，保持 *
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    max_age=600,
)

# 全局 fallback client（本地开发用，env 有值时生效）
_env_ds_key = os.environ.get("DEEPSEEK_API_KEY", "")
_env_sf_key = os.environ.get("SILICONFLOW_API_KEY", "")
client    = _make_ds(_env_ds_key) if _env_ds_key else None
sf_client = _make_sf(_env_sf_key) if _env_sf_key else None

WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway"
_http          = httpx.AsyncClient(timeout=10.0)

# ── 请求模型 ───────────────────────────────────────────────────────

class BookContext(BaseModel):
    bookTitle: str = ""
    author: str = ""
    chapterTitle: str = ""
    pageText: str = ""
    selection: str = ""
    userHighlights: list[str] = []
    popularHighlights: list[str] = []

class AskRequest(BaseModel):
    question: str
    context: BookContext
    style: str = "simple"  # simple | academic | story | socratic
    history: list[dict] = []  # [{role: "user"/"assistant", content: "..."}]

class AskResponse(BaseModel):
    answer: str

class TTSRequest(BaseModel):
    text: str
    voice: str = "zh-CN-XiaoxiaoNeural"

class HistorySaveRequest(BaseModel):
    book_id: str = ""
    book_title: str = ""
    chapter_title: str = ""
    question: str
    answer: str
    selection: str = ""

# ── 系统 Prompt ────────────────────────────────────────────────────

SYSTEM_PROMPT = """你是"伴读讲讲"，一位亲切的读书陪伴助手。

你的任务：
- 用通俗易懂的语言解释书中的难点，就像朋友讲给朋友听
- 融合书中上下文和外部知识进行讲解
- 回答简洁，控制在 150 字以内（除非用户要求详细）
- 不要复读用户的问题，直接给出解释
- 语气自然，像说话一样，不要教科书式的表达

格式要求（必须严格遵守）：
- 禁止使用任何 Markdown 符号：不用星号、井号、反引号、横线列表
- 禁止使用 emoji 表情
- 直接用自然段落表达，需要分点时用"第一、第二"等中文序词

收到书本上下文时，优先结合书的内容和主题来讲解。
收到用户的历史划线时，说明用户已经关注过这些内容，解释时可以呼应或延伸。
收到热门划线时，若与问题相关，可以提及"很多读者也在这里停下来思考"。
收到用户的历史问答记录时，代表这是用户已有的认知基础——不要重复解释他已经懂的内容，可以在此基础上深入或建立连接。"""

async def _get_memory_context(question: str, limit: int = 3, sf: OpenAI | None = None) -> str:
    """从历史库检索与当前问题语义相关的问答，组装成 prompt 片段。"""
    try:
        q_vec = np.array(await _embed(question[:500], sf), dtype=np.float32)
    except Exception:
        return ""

    def _query():
        with _get_db() as conn:
            rows = conn.execute(
                "SELECT book_title, question, answer, embedding "
                "FROM qa_history WHERE embedding != '' ORDER BY created_at DESC LIMIT 300"
            ).fetchall()
            return [dict(r) for r in rows]

    candidates = await asyncio.to_thread(_query)
    if not candidates:
        return ""

    scored = []
    for rec in candidates:
        try:
            vec = np.array(json.loads(rec["embedding"]), dtype=np.float32)
            norm = np.linalg.norm(q_vec) * np.linalg.norm(vec)
            sim = float(np.dot(q_vec, vec) / (norm + 1e-8))
            if sim >= MEMORY_THRESHOLD:
                scored.append((sim, rec))
        except Exception:
            continue

    if not scored:
        return ""

    scored.sort(key=lambda x: x[0], reverse=True)
    lines = ["【用户的相关历史问答（代表其已有认知和关注点）】"]
    for _, rec in scored[:limit]:
        book = f"《{rec['book_title']}》" if rec["book_title"] else ""
        q_short = rec["question"][:60]
        a_short = rec["answer"][:80]
        lines.append(f"- {book}问：{q_short}　答摘：{a_short}")
    return "\n".join(lines) + "\n"

# ── TTS 清洗 ───────────────────────────────────────────────────────

def clean_for_tts(text: str) -> str:
    text = re.sub(r'\*+([^*\n]+)\*+', r'\1', text)
    text = re.sub(r'_+([^_\n]+)_+', r'\1', text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    text = re.sub(r'[\U0001F300-\U0001F9FF\U00002702-\U000027B0]+', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

# ── WebM → WAV 转换（SenseVoice 不接受 WebM，需转为 WAV）──────────

def _webm_to_wav(audio_bytes: bytes) -> bytes:
    in_io  = io.BytesIO(audio_bytes)
    out_io = io.BytesIO()
    resampler  = av.AudioResampler(format="s16", layout="mono", rate=16000)
    in_cont    = av.open(in_io)
    out_cont   = av.open(out_io, "w", format="wav")
    out_stream = out_cont.add_stream("pcm_s16le", rate=16000)
    try:
        for frame in in_cont.decode(audio=0):
            for rf in resampler.resample(frame):
                rf.pts = None
                for pkt in out_stream.encode(rf):
                    out_cont.mux(pkt)
        for rf in resampler.resample(None):
            rf.pts = None
            for pkt in out_stream.encode(rf):
                out_cont.mux(pkt)
        for pkt in out_stream.encode(None):
            out_cont.mux(pkt)
    finally:
        out_cont.close()
        in_cont.close()
    out_io.seek(0)
    return out_io.read()

# ── 微信读书 Skill API 工具 ────────────────────────────────────────

async def weread_call(api_name: str, weread_key: str = "", **params) -> dict:
    """调用微信读书 gateway，失败时返回空 dict 而不抛异常。"""
    key = weread_key or os.environ.get("WEREAD_API_KEY", "")
    if not key:
        return {}
    try:
        resp = await _http.post(
            WEREAD_GATEWAY,
            json={"api_name": api_name, **params},
            headers={"Authorization": f"Bearer {key}"},
        )
        data = resp.json()
        if data.get("errcode", 0) != 0:
            return {}
        return data
    except Exception:
        return {}


@app.get("/context/by-title")
async def get_context_by_title(q: str, request: Request):
    """用书名搜索 bookId，再拉完整上下文。"""
    wr_key = _wr_key(request)
    search = await weread_call("/store/search", weread_key=wr_key, keyword=q, scope=10, count=3)

    results = search.get("results", [])
    book_id = None
    for r in results:
        book_id = r.get("bookId") or (r.get("book") or {}).get("bookId")
        if book_id:
            break

    if not book_id:
        return {"bookTitle": "", "author": "", "chapterTitle": "", "pageText": "",
                "userHighlights": [], "popularHighlights": []}
    return await get_book_context(book_id, request)


@app.get("/context/current")
async def get_current_book_context(request: Request):
    """从书架找最近阅读的书，自动获取其上下文。"""
    wr_key = _wr_key(request)
    shelf = await weread_call("/shelf/sync", weread_key=wr_key)

    books = shelf.get("books", [])
    if not books:
        return {"bookTitle": "", "author": "", "chapterTitle": "", "pageText": "",
                "userHighlights": [], "popularHighlights": []}

    current = max(books, key=lambda b: b.get("readUpdateTime", 0))
    book_id = current["bookId"]
    return await get_book_context(book_id, request)


@app.get("/context/{book_id}")
async def get_book_context(book_id: str, request: Request):
    """并发拉取书籍信息、章节目录、阅读进度、用户划线、热门划线。"""
    if not re.fullmatch(r"\d{1,12}", book_id):
        raise HTTPException(status_code=400, detail="无效的 bookId")
    wr_key = _wr_key(request)
    book_info, chapter_info, progress, my_marks, hot_marks = await asyncio.gather(
        weread_call("/book/info",          weread_key=wr_key, bookId=book_id),
        weread_call("/book/chapterinfo",   weread_key=wr_key, bookId=book_id),
        weread_call("/book/getprogress",   weread_key=wr_key, bookId=book_id),
        weread_call("/book/bookmarklist",  weread_key=wr_key, bookId=book_id),
        weread_call("/book/bestbookmarks", weread_key=wr_key, bookId=book_id),
    )

    # 书名 / 作者
    book_title   = book_info.get("title", "")
    author       = book_info.get("author", "")

    # 当前章节标题
    chapters     = chapter_info.get("chapters", [])
    chapter_uid  = (progress.get("book") or {}).get("chapterUid") or \
                   (progress.get("timestamp") and None)
    current_chapter = ""
    if chapters:
        if chapter_uid:
            matched = next((c for c in chapters if c.get("chapterUid") == chapter_uid), None)
            current_chapter = matched["title"] if matched else chapters[0].get("title", "")
        else:
            current_chapter = chapters[0].get("title", "")

    # 用户划线（取最近 8 条，按时间倒序）
    raw_marks = my_marks.get("updated", [])
    raw_marks.sort(key=lambda m: m.get("createTime", 0), reverse=True)
    user_highlights = [m["markText"] for m in raw_marks[:8] if m.get("markText")]

    # 热门划线（取热度最高 5 条）
    hot_items = hot_marks.get("items", [])
    popular_highlights = [h["markText"] for h in hot_items[:5] if h.get("markText")]

    return {
        "bookTitle":          book_title,
        "author":             author,
        "chapterTitle":       current_chapter,
        "pageText":           "",
        "userHighlights":     user_highlights,
        "popularHighlights":  popular_highlights,
    }


# ── 路由 ───────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/history")
async def save_history(req: HistorySaveRequest, request: Request):
    sf = _make_sf(_sf_key(request))
    embed_text = f"{req.question} {req.answer}"
    try:
        embedding = await _embed(embed_text, sf)
        emb_json = json.dumps(embedding)
    except Exception as e:
        print(f"[Embedding] 保存时向量化失败: {e}")
        emb_json = ""

    def _save():
        with _get_db() as conn:
            conn.execute(
                "INSERT INTO qa_history "
                "(book_id, book_title, chapter_title, question, answer, selection, embedding) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (req.book_id, req.book_title, req.chapter_title,
                 req.question, req.answer, req.selection, emb_json),
            )
            conn.commit()
    await asyncio.to_thread(_save)
    return {"ok": True}

@app.get("/history")
async def get_history(book_id: str = "", limit: int = 50):
    def _query():
        with _get_db() as conn:
            if book_id:
                rows = conn.execute(
                    "SELECT id,created_at,book_id,book_title,chapter_title,question,answer,selection "
                    "FROM qa_history WHERE book_id = ? ORDER BY created_at DESC LIMIT ?",
                    (book_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id,created_at,book_id,book_title,chapter_title,question,answer,selection "
                    "FROM qa_history ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
    records = await asyncio.to_thread(_query)
    return {"records": records}

@app.get("/history/related")
async def get_related(q: str, request: Request, exclude_book_id: str = "", limit: int = 2):
    """用语义相似度从不同书中找相关历史问答。"""
    sf = _make_sf(_sf_key(request))
    try:
        q_vec = np.array(await _embed(q[:500], sf), dtype=np.float32)
    except Exception as e:
        print(f"[Embedding] 查询向量化失败: {e}")
        return {"records": []}

    def _query():
        with _get_db() as conn:
            if exclude_book_id:
                rows = conn.execute(
                    "SELECT id,book_id,book_title,chapter_title,question,answer,embedding "
                    "FROM qa_history WHERE embedding != '' AND book_id != ? "
                    "ORDER BY created_at DESC LIMIT 300",
                    (exclude_book_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id,book_id,book_title,chapter_title,question,answer,embedding "
                    "FROM qa_history WHERE embedding != '' ORDER BY created_at DESC LIMIT 300"
                ).fetchall()
            return [dict(r) for r in rows]

    candidates = await asyncio.to_thread(_query)
    if not candidates:
        return {"records": []}

    scored = []
    for rec in candidates:
        try:
            vec = np.array(json.loads(rec["embedding"]), dtype=np.float32)
            norm = np.linalg.norm(q_vec) * np.linalg.norm(vec)
            sim = float(np.dot(q_vec, vec) / (norm + 1e-8))
            if sim >= SIMILARITY_THRESHOLD:
                scored.append((sim, rec))
        except Exception:
            continue

    scored.sort(key=lambda x: x[0], reverse=True)
    results = [{k: v for k, v in r.items() if k != "embedding"}
               for _, r in scored[:limit]]
    return {"records": results}

@app.get("/free-quota")
async def free_quota(request: Request):
    """返回该 IP 今日剩余免费次数。"""
    ip = _get_client_ip(request)
    return {"remaining": _get_remaining_free(ip), "limit": FREE_DAILY_LIMIT}

@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest, request: Request):
    # 输入长度校验
    if len(req.question) > 2000:
        raise HTTPException(status_code=400, detail="问题太长，请控制在 2000 字以内")

    # 速率限制
    ip = _get_client_ip(request)
    if not _check_rate_limit(ip):
        raise HTTPException(status_code=429, detail="请求太频繁，请稍后再试")

    user_ds_key = request.headers.get("x-deepseek-key", "").strip()
    if user_ds_key:
        # 用户自带 Key，无限制
        ds = _make_ds(user_ds_key)
    else:
        # 走免费额度
        ip = _get_client_ip(request)
        allowed, remaining = await asyncio.to_thread(_check_and_increment_free, ip)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="今日免费次数已用完（每天20次）。请在扩展设置中填写自己的 DeepSeek API Key 继续使用。"
            )
        env_key = os.environ.get("DEEPSEEK_API_KEY", "")
        ds = _make_ds(env_key)
        if not ds:
            raise HTTPException(status_code=503, detail="免费服务暂时不可用，请填写自己的 API Key")
    if not ds:
        raise HTTPException(status_code=401, detail="缺少 DeepSeek API Key，请在扩展设置中填写")
    sf = _make_sf(_sf_key(request))
    ctx = req.context
    context_block = ""
    if ctx.bookTitle:
        author_part = f"（{ctx.author}）" if ctx.author else ""
        context_block += f"【书名】{ctx.bookTitle}{author_part}\n"
    if ctx.chapterTitle:
        context_block += f"【章节】{ctx.chapterTitle}\n"
    if ctx.selection:
        context_block += f"【划选段落】{ctx.selection}\n"
    elif ctx.pageText:
        context_block += f"【当前页面节选】{ctx.pageText[:800]}\n"
    if ctx.userHighlights:
        highlights_text = "；".join(ctx.userHighlights[:5])
        context_block += f"【用户在本书的历史划线（代表其关注点）】{highlights_text}\n"
    if ctx.popularHighlights:
        popular_text = "；".join(ctx.popularHighlights[:3])
        context_block += f"【本书热门划线（其他读者最常标注）】{popular_text}\n"

    # 注入语境记忆
    memory = await _get_memory_context(req.question, sf=sf)
    if memory:
        context_block += memory

    user_message = (context_block + f"\n用户问题：{req.question}") if context_block else req.question

    # 风格附加指令 / 苏格拉底多轮对话
    STYLE_SUFFIX = {
        "academic": "\n\n【风格要求】请用严谨的学术语言，引用相关理论或概念，可以适当使用专业术语并解释。",
        "story":    "\n\n【风格要求】请用讲故事的方式解释，加入具体场景、比喻或类比，让人感觉身临其境。",
    }

    if req.style == "socratic":
        round_num = len(req.history) // 2 + 1
        if round_num >= 3:
            system_prompt = (
                "你是一位苏格拉底式的阅读导师。"
                "用户通过两轮对话已经自己推导出了答案。"
                "请以"你已经推导出来了——"开头，用温暖肯定的语气，"
                "总结用户在这段对话中自己发现的洞见，不超过 100 字。"
                "禁止再提问。禁止 Markdown 符号和 emoji。"
            )
        elif round_num == 2:
            system_prompt = (
                "你是一位苏格拉底式的阅读导师。"
                "你的唯一任务是提问，绝对不能给出解释或答案。"
                "根据用户的回答，提一个更深入的追问，引导他继续独立思考。"
                "问题简短有力，不超过 30 字，只有一句话。"
                "禁止解释、禁止分析、禁止给答案。禁止 Markdown 符号和 emoji。"
            )
        else:
            system_prompt = (
                "你是一位苏格拉底式的阅读导师。"
                "你的唯一任务是提问，绝对不能给出解释或答案。"
                "根据用户选中的内容，提一个能触发独立思考的开放性问题。"
                "问题简短有力，不超过 30 字，只有一句话。"
                "禁止解释、禁止分析、禁止给答案。禁止 Markdown 符号和 emoji。"
            )
        # 苏格拉底模式：user_message 只传上下文 + 选文，不带"解释"动词
        # 防止 AI 看到"请解释"就直接给答案
        if ctx.selection:
            socr_user = (context_block + f"\n请针对上面这段内容展开苏格拉底式对话。") if context_block else req.question
        else:
            socr_user = user_message  # 用户自己打的追问，原样传

        messages = [{"role": "system", "content": system_prompt}]
        for turn in req.history:
            role = turn.get("role", "user")
            content = str(turn.get("content", ""))[:1000]
            if role in ("user", "assistant"):
                messages.append({"role": role, "content": content})
        # round1 用清洁版，后续轮次（history 已有内容）用原始回答
        messages.append({"role": "user", "content": socr_user if not req.history else req.question})
    else:
        system_prompt = SYSTEM_PROMPT + STYLE_SUFFIX.get(req.style, "")
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ]

    try:
        resp = await asyncio.to_thread(
            lambda: ds.chat.completions.create(
                model="deepseek-chat",
                max_tokens=512,
                messages=messages,
            )
        )
        return AskResponse(answer=resp.choices[0].message.content)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DeepSeek API 错误: {e}")

@app.post("/tts")
async def tts(req: TTSRequest):
    try:
        communicate = edge_tts.Communicate(clean_for_tts(req.text), req.voice)
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return Response(content=b"".join(chunks), media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS 错误: {e}")

@app.post("/transcribe")
async def transcribe(request: Request):
    """接收浏览器 WebM，转换为 WAV 后发给 SiliconFlow SenseVoice。"""
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="空音频")

    sf = _make_sf(_sf_key(request))
    print(f"[转录] 收到 {len(audio_bytes)//1024}KB")
    try:
        t0 = time.time()
        wav_bytes = await asyncio.to_thread(_webm_to_wav, audio_bytes)
        result = sf.audio.transcriptions.create(
            model="FunAudioLLM/SenseVoiceSmall",
            file=("audio.wav", io.BytesIO(wav_bytes), "audio/wav"),
            language="zh",
        )
        text = re.sub(r"<\|[^|]+\|>", "", result.text).strip()
        print(f"[转录] 耗时 {time.time()-t0:.2f}s → {repr(text)}")
    except Exception as e:
        print(f"[转录] 错误: {e}")
        raise HTTPException(status_code=502, detail=f"SenseVoice 错误: {e}")

    return {"text": text}

@app.get("/tts/play")
async def tts_play(text: str, voice: str = "zh-CN-XiaoxiaoNeural"):
    """GET 版 TTS，供移动端 Audio.Sound.createAsync 直接加载。"""
    try:
        communicate = edge_tts.Communicate(clean_for_tts(text), voice)
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return Response(content=b"".join(chunks), media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS 错误: {e}")

@app.get("/tts/voices")
async def tts_voices():
    voices = await edge_tts.list_voices()
    return {"voices": [{"name": v["ShortName"], "gender": v["Gender"]}
                       for v in voices if v["Locale"].startswith("zh-")]}
