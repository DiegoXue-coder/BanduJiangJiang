"""伴读讲讲 — FastAPI 后端（DeepSeek 对话 + SiliconFlow SenseVoice 语音识别）"""

import os
import io
import re
import time
import json
import asyncio
import hashlib
from collections import defaultdict
from contextlib import asynccontextmanager

import asyncpg

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from openai import OpenAI
import edge_tts
import av
import httpx
from dotenv import load_dotenv

load_dotenv()

# ── 数据库连接池 ───────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "")

_pool: asyncpg.Pool | None = None

async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        # statement_cache_size=0 required for Supabase Transaction Pooler (PgBouncer)
        _pool = await asyncpg.create_pool(
            DATABASE_URL, min_size=1, max_size=5, statement_cache_size=0
        )
    return _pool

async def init_db():
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS qa_history (
                id            BIGSERIAL PRIMARY KEY,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                book_id       TEXT NOT NULL DEFAULT '',
                book_title    TEXT NOT NULL DEFAULT '',
                chapter_title TEXT NOT NULL DEFAULT '',
                question      TEXT NOT NULL,
                answer        TEXT NOT NULL,
                selection     TEXT NOT NULL DEFAULT '',
                embedding     vector(1024)
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS daily_usage (
                ip    TEXT    NOT NULL,
                date  DATE    NOT NULL DEFAULT CURRENT_DATE,
                cnt   INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (ip, date)
            )
        """)
        # 清理 90 天前的旧记录
        await conn.execute(
            "DELETE FROM qa_history WHERE created_at < NOW() - INTERVAL '90 days'"
        )
    print("[DB] 初始化完成，pgvector 已启用")

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    if _pool:
        await _pool.close()

# ── API Key 解析 ───────────────────────────────────────────────────

def _ds_key(request: Request) -> str:
    return request.headers.get("x-deepseek-key", "").strip() or os.environ.get("DEEPSEEK_API_KEY", "")

def _sf_key(request: Request) -> str:
    return request.headers.get("x-siliconflow-key", "").strip() or os.environ.get("SILICONFLOW_API_KEY", "")

def _wr_key(request: Request) -> str:
    return request.headers.get("x-weread-key", "").strip() or os.environ.get("WEREAD_API_KEY", "")

def _make_ds(key: str) -> OpenAI | None:
    return OpenAI(api_key=key, base_url="https://api.deepseek.com") if key else None

def _make_sf(key: str) -> OpenAI | None:
    return OpenAI(api_key=key, base_url="https://api.siliconflow.cn/v1") if key else None

# ── 免费额度（按 IP + 日期，每天自动重置）─────────────────────────

FREE_DAILY_LIMIT = 20

def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    raw = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else "unknown"
    )
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

async def _check_and_increment_free(ip: str) -> tuple[bool, int]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO daily_usage (ip, date, cnt)
            VALUES ($1, CURRENT_DATE, 1)
            ON CONFLICT (ip, date) DO UPDATE
                SET cnt = daily_usage.cnt + 1
            RETURNING cnt
        """, ip)
        cnt = row["cnt"]
        if cnt > FREE_DAILY_LIMIT:
            # 超出后回滚计数（不让计数器无限增长）
            await conn.execute(
                "UPDATE daily_usage SET cnt = $1 WHERE ip = $2 AND date = CURRENT_DATE",
                FREE_DAILY_LIMIT, ip
            )
            return False, 0
        return True, FREE_DAILY_LIMIT - cnt

async def _get_remaining_free(ip: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT cnt FROM daily_usage WHERE ip = $1 AND date = CURRENT_DATE", ip
        )
        return max(0, FREE_DAILY_LIMIT - (row["cnt"] if row else 0))

# ── 速率限制（每 IP 每分钟 30 次）───────────────────────────────────
_rate_store: dict[str, list[float]] = defaultdict(list)

def _check_rate_limit(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _rate_store[ip] if now - t < 60]
    _rate_store[ip] = hits
    if len(hits) >= 30:
        return False
    _rate_store[ip].append(now)
    return True

# ── Embedding ──────────────────────────────────────────────────────

def _vec_to_str(vec: list[float]) -> str:
    """将 Python float list 转为 pgvector 接受的字符串格式。"""
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"

async def _embed(text: str, sf: OpenAI | None = None) -> list[float]:
    c = sf or sf_client
    if not c:
        raise ValueError("SiliconFlow key not configured")
    resp = await asyncio.to_thread(
        lambda: c.embeddings.create(model="BAAI/bge-m3", input=text[:1000])
    )
    return resp.data[0].embedding

# ── FastAPI ────────────────────────────────────────────────────────

app = FastAPI(title="伴读讲讲 API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    max_age=600,
)

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
    style: str = "simple"
    history: list[dict] = []

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

SIMILARITY_THRESHOLD = 0.72
MEMORY_THRESHOLD     = 0.65

async def _get_memory_context(question: str, sf: OpenAI | None = None) -> str:
    """用 pgvector 在历史库中检索语义相关问答，组装为 prompt 片段。"""
    try:
        q_vec = _vec_to_str(await _embed(question[:500], sf))
    except Exception:
        return ""

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT book_title, question, answer,
                   1 - (embedding <=> $1::vector) AS sim
            FROM qa_history
            WHERE embedding IS NOT NULL
              AND 1 - (embedding <=> $1::vector) >= $2
            ORDER BY embedding <=> $1::vector
            LIMIT 3
        """, q_vec, MEMORY_THRESHOLD)

    if not rows:
        return ""

    lines = ["【用户的相关历史问答（代表其已有认知和关注点）】"]
    for row in rows:
        book = f"《{row['book_title']}》" if row["book_title"] else ""
        lines.append(f"- {book}问：{row['question'][:60]}　答摘：{row['answer'][:80]}")
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

# ── WebM → WAV ─────────────────────────────────────────────────────

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

# ── 微信读书 Skill API ─────────────────────────────────────────────

async def weread_call(api_name: str, weread_key: str = "", **params) -> dict:
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
        return data if data.get("errcode", 0) == 0 else {}
    except Exception:
        return {}

# ── 路由 ───────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/context/by-title")
async def get_context_by_title(q: str, request: Request):
    wr_key = _wr_key(request)
    search = await weread_call("/store/search", weread_key=wr_key, keyword=q, scope=10, count=3)
    book_id = None
    for r in search.get("results", []):
        book_id = r.get("bookId") or (r.get("book") or {}).get("bookId")
        if book_id:
            break
    if not book_id:
        return {"bookTitle": "", "author": "", "chapterTitle": "",
                "pageText": "", "userHighlights": [], "popularHighlights": []}
    return await get_book_context(book_id, request)

@app.get("/context/current")
async def get_current_book_context(request: Request):
    wr_key = _wr_key(request)
    shelf  = await weread_call("/shelf/sync", weread_key=wr_key)
    books  = shelf.get("books", [])
    if not books:
        return {"bookTitle": "", "author": "", "chapterTitle": "",
                "pageText": "", "userHighlights": [], "popularHighlights": []}
    current = max(books, key=lambda b: b.get("readUpdateTime", 0))
    return await get_book_context(current["bookId"], request)

@app.get("/context/{book_id}")
async def get_book_context(book_id: str, request: Request):
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
    book_title  = book_info.get("title", "")
    author      = book_info.get("author", "")
    chapters    = chapter_info.get("chapters", [])
    chapter_uid = (progress.get("book") or {}).get("chapterUid")
    current_chapter = ""
    if chapters:
        if chapter_uid:
            matched = next((c for c in chapters if c.get("chapterUid") == chapter_uid), None)
            current_chapter = matched["title"] if matched else chapters[0].get("title", "")
        else:
            current_chapter = chapters[0].get("title", "")
    raw_marks = my_marks.get("updated", [])
    raw_marks.sort(key=lambda m: m.get("createTime", 0), reverse=True)
    user_highlights    = [m["markText"] for m in raw_marks[:8] if m.get("markText")]
    popular_highlights = [h["markText"] for h in hot_marks.get("items", [])[:5] if h.get("markText")]
    return {
        "bookTitle": book_title, "author": author,
        "chapterTitle": current_chapter, "pageText": "",
        "userHighlights": user_highlights, "popularHighlights": popular_highlights,
    }

@app.post("/history")
async def save_history(req: HistorySaveRequest, request: Request):
    sf = _make_sf(_sf_key(request))
    emb_str = None
    try:
        vec = await _embed(f"{req.question} {req.answer}", sf)
        emb_str = _vec_to_str(vec)
    except Exception as e:
        print(f"[Embedding] 向量化失败: {e}")

    pool = await get_pool()
    async with pool.acquire() as conn:
        if emb_str:
            await conn.execute("""
                INSERT INTO qa_history
                    (book_id, book_title, chapter_title, question, answer, selection, embedding)
                VALUES ($1,$2,$3,$4,$5,$6,$7::vector)
            """, req.book_id, req.book_title, req.chapter_title,
                req.question, req.answer, req.selection, emb_str)
        else:
            await conn.execute("""
                INSERT INTO qa_history
                    (book_id, book_title, chapter_title, question, answer, selection)
                VALUES ($1,$2,$3,$4,$5,$6)
            """, req.book_id, req.book_title, req.chapter_title,
                req.question, req.answer, req.selection)
    return {"ok": True}

@app.get("/history")
async def get_history(book_id: str = "", limit: int = 50):
    pool = await get_pool()
    async with pool.acquire() as conn:
        if book_id:
            rows = await conn.fetch("""
                SELECT id, created_at, book_id, book_title, chapter_title,
                       question, answer, selection
                FROM qa_history WHERE book_id = $1
                ORDER BY created_at DESC LIMIT $2
            """, book_id, limit)
        else:
            rows = await conn.fetch("""
                SELECT id, created_at, book_id, book_title, chapter_title,
                       question, answer, selection
                FROM qa_history
                ORDER BY created_at DESC LIMIT $1
            """, limit)
    return {"records": [dict(r) for r in rows]}

@app.get("/history/related")
async def get_related(q: str, request: Request, exclude_book_id: str = "", limit: int = 2):
    sf = _make_sf(_sf_key(request))
    try:
        q_vec = _vec_to_str(await _embed(q[:500], sf))
    except Exception as e:
        print(f"[Embedding] 查询向量化失败: {e}")
        return {"records": []}

    pool = await get_pool()
    async with pool.acquire() as conn:
        if exclude_book_id:
            rows = await conn.fetch("""
                SELECT id, book_id, book_title, chapter_title, question, answer,
                       1 - (embedding <=> $1::vector) AS sim
                FROM qa_history
                WHERE embedding IS NOT NULL
                  AND book_id != $2
                  AND 1 - (embedding <=> $1::vector) >= $3
                ORDER BY embedding <=> $1::vector
                LIMIT $4
            """, q_vec, exclude_book_id, SIMILARITY_THRESHOLD, limit)
        else:
            rows = await conn.fetch("""
                SELECT id, book_id, book_title, chapter_title, question, answer,
                       1 - (embedding <=> $1::vector) AS sim
                FROM qa_history
                WHERE embedding IS NOT NULL
                  AND 1 - (embedding <=> $1::vector) >= $2
                ORDER BY embedding <=> $1::vector
                LIMIT $3
            """, q_vec, SIMILARITY_THRESHOLD, limit)
    return {"records": [dict(r) for r in rows]}

@app.get("/free-quota")
async def free_quota(request: Request):
    ip = _get_client_ip(request)
    return {"remaining": await _get_remaining_free(ip), "limit": FREE_DAILY_LIMIT}

@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest, request: Request):
    if len(req.question) > 2000:
        raise HTTPException(status_code=400, detail="问题太长，请控制在 2000 字以内")

    ip = _get_client_ip(request)
    if not _check_rate_limit(ip):
        raise HTTPException(status_code=429, detail="请求太频繁，请稍后再试")

    user_ds_key = request.headers.get("x-deepseek-key", "").strip()
    if user_ds_key:
        ds = _make_ds(user_ds_key)
    else:
        allowed, _ = await _check_and_increment_free(ip)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="今日免费次数已用完（每天20次）。请在扩展设置中填写自己的 DeepSeek API Key 继续使用。"
            )
        ds = _make_ds(os.environ.get("DEEPSEEK_API_KEY", ""))
        if not ds:
            raise HTTPException(status_code=503, detail="免费服务暂时不可用，请填写自己的 API Key")
    if not ds:
        raise HTTPException(status_code=401, detail="缺少 DeepSeek API Key，请在扩展设置中填写")

    sf  = _make_sf(_sf_key(request))
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
        context_block += f"【用户在本书的历史划线】{'；'.join(ctx.userHighlights[:5])}\n"
    if ctx.popularHighlights:
        context_block += f"【本书热门划线】{'；'.join(ctx.popularHighlights[:3])}\n"

    memory = await _get_memory_context(req.question, sf=sf)
    if memory:
        context_block += memory

    user_message = (context_block + f"\n用户问题：{req.question}") if context_block else req.question

    STYLE_SUFFIX = {
        "academic": "\n\n【风格要求】请用严谨的学术语言，引用相关理论或概念，可以适当使用专业术语并解释。",
        "story":    "\n\n【风格要求】请用讲故事的方式解释，加入具体场景、比喻或类比，让人感觉身临其境。",
    }

    round_num      = len(req.history) // 2 + 1
    SOCR_MAX_ROUNDS = 8

    if req.style == "socratic":
        if round_num >= SOCR_MAX_ROUNDS:
            system_prompt    = '你是阅读导师，必须以"你已经推导出来了——"开头给出核心洞见，2-3句话结束对话。'
            socr_max_tokens  = 300
        elif round_num >= 3:
            system_prompt = (
                '你是苏格拉底式阅读导师。根据用户的回答，从以下两条路选一条输出：\n\n'
                '路A——用户已触及核心，输出：\n'
                '你已经推导出来了——[用2-3句揭示洞见]\n\n'
                '路B——用户还未到位，输出：\n'
                '[一句拨正方向，15字内]。[一个追问，20字内，问号结尾]\n\n'
                '只输出以上格式的内容，不加任何其他文字。'
            )
            socr_max_tokens = 300
        elif round_num == 2:
            system_prompt = (
                '你是苏格拉底式阅读导师。按以下格式输出两句话，不多不少：\n\n'
                '[对用户回答的一句点评或轻微拨正，15字内]。[一个追问，20字内，问号结尾]\n\n'
                '只输出这两句，不加解释、不给答案、不加任何其他内容。'
            )
            socr_max_tokens = 100
        else:
            system_prompt = (
                '你是苏格拉底式阅读导师。针对用户提供的文字，直接输出一个问句。\n\n'
                '格式：[问句，20字内，问号结尾]\n\n'
                '只输出问句本身，不加任何解释、引导语或前缀。'
            )
            socr_max_tokens = 50

        socr_user = ctx.selection if (not req.history and ctx.selection) else req.question
        messages  = [{"role": "system", "content": system_prompt}]
        for turn in req.history:
            role    = turn.get("role", "user")
            content = str(turn.get("content", ""))[:1000]
            if role in ("user", "assistant"):
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": socr_user})
    else:
        system_prompt = SYSTEM_PROMPT + STYLE_SUFFIX.get(req.style, "")
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ]

    max_tokens  = socr_max_tokens if req.style == "socratic" else 512
    temperature = 0.3 if req.style == "socratic" else 1.0

    try:
        resp = await asyncio.to_thread(
            lambda: ds.chat.completions.create(
                model="deepseek-chat",
                max_tokens=max_tokens,
                temperature=temperature,
                messages=messages,
            )
        )
        raw = resp.choices[0].message.content
        print(f"[Ask] round={round_num} style={req.style} raw={repr(raw[:80])}")

        is_socr_q = (req.style == "socratic"
                     and round_num < SOCR_MAX_ROUNDS
                     and not raw.startswith("你已经推导出来了"))
        if is_socr_q:
            for qmark in ("？", "?"):
                idx = raw.find(qmark)
                if idx >= 0:
                    raw = raw[:idx + 1].strip()
                    break
            else:
                raw = raw[:40]

        return AskResponse(answer=raw)
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

@app.get("/tts/play")
async def tts_play(text: str, voice: str = "zh-CN-XiaoxiaoNeural"):
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

@app.post("/transcribe")
async def transcribe(request: Request):
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="空音频")
    sf = _make_sf(_sf_key(request))
    print(f"[转录] 收到 {len(audio_bytes)//1024}KB")
    try:
        import time as _time
        t0       = _time.time()
        wav_bytes = await asyncio.to_thread(_webm_to_wav, audio_bytes)
        result    = sf.audio.transcriptions.create(
            model="FunAudioLLM/SenseVoiceSmall",
            file=("audio.wav", io.BytesIO(wav_bytes), "audio/wav"),
            language="zh",
        )
        text = re.sub(r"<\|[^|]+\|>", "", result.text).strip()
        print(f"[转录] 耗时 {_time.time()-t0:.2f}s → {repr(text)}")
    except Exception as e:
        print(f"[转录] 错误: {e}")
        raise HTTPException(status_code=502, detail=f"SenseVoice 错误: {e}")
    return {"text": text}
