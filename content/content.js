// 伴读讲讲 — 内容脚本
// 同时运行在顶层页面和 iframe 里（all_frames: true）

const IS_TOP = window === window.top;
const log = (...a) => console.log("[伴读讲讲]", ...a);

log("脚本加载", IS_TOP ? "顶层" : "iframe", location.href);

// ── 设置（从 chrome.storage 加载） ───────────────────────────────
let _settings = {
  apiUrl: "https://bandujiangjiang-production.up.railway.app",
  deepseekKey: "",
  siliconflowKey: "",
  wereadKey: "",
  style: "simple",
  tts: true,
};

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "apiUrl", "deepseekKey", "siliconflowKey", "wereadKey", "style", "tts",
  ]);
  _settings = {
    apiUrl:         data.apiUrl         || "http://localhost:8002",
    deepseekKey:    data.deepseekKey    || "",
    siliconflowKey: data.siliconflowKey || "",
    wereadKey:      data.wereadKey      || "",
    style:          data.style          || "simple",
    tts:            data.tts !== false,
  };
  ttsEnabled = _settings.tts;
}

// 返回所有请求都应带上的 header（GET 用）
function keyHeaders() {
  const h = {};
  if (_settings.deepseekKey)    h["X-DeepSeek-Key"]    = _settings.deepseekKey;
  if (_settings.siliconflowKey) h["X-SiliconFlow-Key"] = _settings.siliconflowKey;
  if (_settings.wereadKey)      h["X-WeRead-Key"]       = _settings.wereadKey;
  return h;
}

// 返回 JSON 请求的 header（POST 用）
function jsonHeaders() {
  return { "Content-Type": "application/json", ...keyHeaders() };
}

// ── 状态（仅顶层用） ──────────────────────────────────────────────
let ttsEnabled = true;
let currentAudio = null;
let recognition = null;
let isListening = false;
let capturedSel = { text: "", rect: null };
let pendingContext = "";
let hlScrollContainer = null;
let hlScrollHandler  = null;
let hlBaseScrollTop  = 0;
let hlBaseTop        = 0;

// ── 从页面标题提取书名（"书名 - 微信读书" → "书名"） ─────────────
function extractBookTitle() {
  return document.title.replace(/\s*[-—|]\s*微信读书.*$/i, "").trim();
}

// ── 从页面网络请求记录中提取 bookId（最可靠）──────────────────────
function findBookIdFromPerformance() {
  for (const e of performance.getEntriesByType("resource")) {
    const m = e.name.match(/[?&]bookId=(\d{4,12})/);
    if (m) { log("bookId from network:", m[1]); return m[1]; }
  }
  return "";
}

// ── 书本内容提取（调后端 API，不再刮 DOM） ────────────────────────
let _contextCache = { key: "", data: null, ts: 0 };

async function extractBookContext() {
  const bookId    = findBookIdFromPerformance();
  const bookTitle = extractBookTitle();
  const cacheKey  = bookId || bookTitle || location.href;
  const now       = Date.now();

  // 同一本书 5 分钟内复用缓存
  if (cacheKey === _contextCache.key && now - _contextCache.ts < 300_000 && _contextCache.data) {
    const pageText = Array.from(
      document.querySelectorAll(".readerChapterContent p, .readerChapterContent_paragraph, .wr_absolute p")
    ).map(el => el.textContent.trim()).filter(Boolean).join("\n").slice(0, 1500);
    return { ..._contextCache.data, pageText, selection: capturedSel.text };
  }

  const getPageText = () => Array.from(
    document.querySelectorAll(".readerChapterContent p, .readerChapterContent_paragraph, .wr_absolute p")
  ).map(el => el.textContent.trim()).filter(Boolean).join("\n").slice(0, 1500);

  // 优先：用 bookId 精确拉取（最准确）
  if (bookId) {
    try {
      log("用 bookId 查上下文:", bookId);
      const res = await fetch(`${_settings.apiUrl}/context/${bookId}`, { headers: keyHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data.bookTitle) {
          _contextCache = { key: cacheKey, data, ts: now };
          log("API 上下文:", data.bookTitle, "/", data.chapterTitle);
          return { ...data, pageText: getPageText(), selection: capturedSel.text };
        }
      }
    } catch (e) {
      log("by-bookId 失败:", e.message);
    }
  }

  // 次选：用书名搜索
  if (bookTitle) {
    try {
      log("用书名查上下文:", bookTitle);
      const res = await fetch(`${_settings.apiUrl}/context/by-title?q=${encodeURIComponent(bookTitle)}`, { headers: keyHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data.bookTitle) {
          _contextCache = { key: cacheKey, data, ts: now };
          return { ...data, pageText: getPageText(), selection: capturedSel.text };
        }
      }
    } catch (e) {
      log("by-title 失败:", e.message);
    }
  }

  // 降级：书架最近读的书
  try {
    const res = await fetch(`${_settings.apiUrl}/context/current`, { headers: keyHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data.bookTitle) {
        _contextCache = { key: cacheKey, data, ts: now };
        log("降级 current:", data.bookTitle);
        return { ...data, pageText: getPageText(), selection: capturedSel.text };
      }
    }
  } catch (e) {
    log("context/current 失败:", e.message);
  }

  // 降级：WeRead API 不可用时用 DOM
  const titleEl = document.querySelector(".readerTopBar_title_link") ||
                  document.querySelector(".readerTopBar_title");
  const chapterEl = document.querySelector(".readerChapterContent_title") ||
                    document.querySelector(".chapterTitle");
  const pageText = Array.from(
    document.querySelectorAll(".readerChapterContent p, .readerChapterContent_paragraph, .wr_absolute p")
  ).map(el => el.textContent.trim()).filter(Boolean).join("\n").slice(0, 2000);

  return {
    bookTitle: titleEl?.textContent.trim() ?? "",
    author: "",
    chapterTitle: chapterEl?.textContent.trim() ?? "",
    pageText,
    selection: capturedSel.text,
    userHighlights: [],
    popularHighlights: [],
  };
}

// ── 浏览器内置 SpeechRecognition（无 SiliconFlow Key 时的降级方案）──
function startBrowserSpeech(onResult, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sr = new SR();
  sr.lang = "zh-CN";
  sr.interimResults = false;
  sr.maxAlternatives = 1;

  setVoiceState("recording");
  showStatus("正在录音 — 停顿后自动停止（浏览器识别）");
  isListening = true;

  sr.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript?.trim();
    if (text) onResult(text);
    else showStatus("没有识别到内容，请重试");
  };
  sr.onerror = (e) => {
    showStatus(e.error === "not-allowed" ? "麦克风被拒绝，请在地址栏允许" : `识别错误：${e.error}`);
    onEnd();
  };
  sr.onend = () => {
    setVoiceState("idle");
    isListening = false;
    onEnd();
  };

  sr.start();
  recognition = { stop: () => sr.stop() };
}

// ── 语音录制 + SenseVoice 转录（含客户端 VAD 自动停止）──────────
async function startVoice(onResult, onEnd) {
  // 无 SiliconFlow Key 时降级到浏览器 SpeechRecognition
  if (!_settings.siliconflowKey) {
    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      startBrowserSpeech(onResult, onEnd);
    } else {
      showStatus("请填写 SiliconFlow API Key 以启用语音识别");
      onEnd();
    }
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showStatus("浏览器不支持麦克风 API，请更新 Chrome");
    onEnd(); return;
  }

  let stream;
  try {
    showStatus("请在浏览器弹窗中允许麦克风…");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const msg = err.name === "NotAllowedError"
              ? "麦克风被拒绝 — 请点地址栏左侧🔒 → 允许麦克风"
              : err.name === "NotFoundError"
              ? "找不到麦克风设备"
              : `麦克风错误(${err.name})`;
    showStatus(msg);
    onEnd(); return;
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  // ── VAD 状态 ──
  let audioCtx = null;
  let vadInterval = null;

  const stopVAD = () => {
    if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
    if (audioCtx)    { audioCtx.close().catch(() => {}); audioCtx = null; }
  };

  let ended = false;
  const safeEnd = () => { if (!ended) { ended = true; onEnd(); } };

  recorder.onstop = async () => {
    stopVAD();
    stream.getTracks().forEach(t => t.stop());
    setVoiceState("processing");
    showStatus("识别中…");
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      log("发送音频:", (blob.size / 1024).toFixed(1), "KB");
      const res = await fetch(`${_settings.apiUrl}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": blob.type, ...keyHeaders() },
        body: blob,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { text } = await res.json();
      log("转录结果:", JSON.stringify(text));
      if (text?.trim()) onResult(text.trim());
      else showStatus("没有识别到内容，请重试");
    } catch (e) {
      showStatus(`识别失败：${e.message}`);
    }
    safeEnd();
  };

  // 600ms 预热，避免 MediaRecorder 开头截断
  recorder.start();
  isListening = true;
  await new Promise(r => setTimeout(r, 600));
  setVoiceState("recording");
  showStatus("正在录音 — 停顿后自动停止");

  // ── 启动 VAD ──
  try {
    audioCtx = new AudioContext();
    const source   = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const timeBuf   = new Uint8Array(analyser.frequencyBinCount);
    const startTime = Date.now();
    let silenceStart = null;

    const SILENCE_RMS = 0.018;   // 低于此值视为静音（可按实际噪底调整）
    const SILENCE_MS  = 1500;    // 持续静音多久自动停
    const MIN_MS      = 1200;    // 最短录音时间，避免误触发

    vadInterval = setInterval(() => {
      if (recorder.state !== "recording") return;

      analyser.getByteTimeDomainData(timeBuf);
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) {
        const v = (timeBuf[i] - 128) / 128;
        sum += v * v;
      }
      const rms     = Math.sqrt(sum / timeBuf.length);
      const elapsed = Date.now() - startTime;

      if (elapsed < MIN_MS) return;  // 最短录音保护

      if (rms < SILENCE_RMS) {
        if (!silenceStart) silenceStart = Date.now();
        const silent = Date.now() - silenceStart;
        if (silent > 1000) showStatus("检测到停顿，即将停止…");
        if (silent > SILENCE_MS) recognition?.stop();
      } else {
        if (silenceStart) {
          silenceStart = null;
          showStatus("正在录音 — 停顿后自动停止");
        }
      }
    }, 100);
  } catch (e) {
    log("VAD 初始化失败，降级为手动停止:", e.message);
    showStatus("正在录音 — 点击停止");
  }

  // 60 秒安全兜底
  const safeTimer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, 60000);

  recognition = {
    stop: () => {
      stopVAD();
      clearTimeout(safeTimer);
      if (recorder.state === "recording") recorder.stop();
    }
  };
}

function stopVoice() {
  recognition?.stop();
  isListening = false;
}

// ── TTS ───────────────────────────────────────────────────────────
async function speakText(text) {
  if (!ttsEnabled) return;
  stopAudio();
  try {
    const res = await fetch(`${_settings.apiUrl}/tts`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    currentAudio = new Audio(url);
    currentAudio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; updateStopBtn(); };
    currentAudio.play();
    updateStopBtn();
  } catch (e) {
    console.warn("[伴读讲讲] TTS 失败:", e);
  }
}

function stopAudio() {
  currentAudio?.pause();
  currentAudio = null;
  updateStopBtn();
}

function updateStopBtn() {
  const btn = document.getElementById("bandu-stop-btn");
  if (btn) btn.style.display = currentAudio ? "inline-flex" : "none";
}

// ── API ───────────────────────────────────────────────────────────
async function askAI(question, context) {
  const res = await fetch(`${_settings.apiUrl}/ask`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ question, context, style: _settings.style || "simple" }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch {}
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).answer;
}

// ── UI ────────────────────────────────────────────────────────────
function buildUI() {
  if (document.getElementById("bandu-root")) return;
  const root = document.createElement("div");
  root.id = "bandu-root";
  root.innerHTML = `
    <div id="bandu-fab" title="伴读讲讲">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 9.5C8 8.67 8.67 8 9.5 8s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 15.33 8 14.5v-5zm5 0c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S13 15.33 13 14.5v-5z" fill="currentColor"/>
        <path d="M6 12c0 3.31 2.69 6 6 6v2c-4.42 0-8-3.58-8-8h2zm12 0c0-3.31-2.69-6-6-6V4c4.42 0 8 3.58 8 8h-2z" fill="currentColor"/>
      </svg>
    </div>
    <div id="bandu-panel" data-tab="chat">
      <div id="bandu-header">
        <span id="bandu-title">伴读讲讲</span>
        <div id="bandu-header-actions">
          <button id="bandu-tts-btn" title="开关语音朗读">🔊</button>
          <button id="bandu-close" title="关闭">✕</button>
        </div>
      </div>
      <div id="bandu-tabs">
        <button id="bandu-tab-chat" class="bandu-tab bandu-tab-active">对话</button>
        <button id="bandu-tab-history" class="bandu-tab">历史</button>
      </div>
      <div id="bandu-messages"></div>
      <div id="bandu-history"></div>
      <div id="bandu-status"></div>
      <div id="bandu-controls">
        <button id="bandu-voice-btn">
          <span class="v-mic">🎤</span>
          <span class="v-bars"><i></i><i></i><i></i><i></i></span>
          <span class="v-spin"></span>
          <span class="bandu-mic-label">语音提问</span>
        </button>
        <button id="bandu-stop-btn" style="display:none">⏹ 停止朗读</button>
      </div>
      <div id="bandu-context-bar" style="display:none">
        <span id="bandu-context-text"></span>
        <button id="bandu-context-clear" title="清除选中内容">✕</button>
      </div>
      <div id="bandu-style-bar">
        <span class="bandu-style-label">风格</span>
        <button class="bandu-style-btn active" data-style="simple" title="用大白话解释，简单易懂">通俗</button>
        <button class="bandu-style-btn" data-style="academic" title="引用理论和专业概念，严谨深入">学术</button>
        <button class="bandu-style-btn" data-style="story" title="用故事和比喻来解释，生动有趣">故事</button>
        <button class="bandu-style-btn" data-style="socratic" title="先抛出问题引发思考，再给出解释">提问式</button>
      </div>
      <div id="bandu-input-row">
        <input id="bandu-text-input" type="text" placeholder="输入问题，回车发送…" />
        <button id="bandu-input-clear" style="display:none" title="清除输入">✕</button>
        <button id="bandu-send-btn">发送</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  bindTopEvents();
}

// idle | preparing | recording | processing
function setVoiceState(state) {
  const btn = document.getElementById("bandu-voice-btn");
  if (!btn) return;
  btn.classList.remove("bandu-preparing", "bandu-recording", "bandu-processing");
  btn.disabled = (state === "preparing" || state === "processing");
  const labels = { idle: "语音提问", preparing: "准备中…", recording: "点击停止", processing: "识别中…" };
  const el = btn.querySelector(".bandu-mic-label");
  if (el) el.textContent = labels[state] ?? "语音提问";
  if (state !== "idle") btn.classList.add(`bandu-${state}`);
}

function openPanel() {
  document.getElementById("bandu-panel")?.classList.add("bandu-panel-open");
  document.getElementById("bandu-fab")?.classList.add("bandu-fab-active");
}

function addMessage(role, text) {
  const c = document.getElementById("bandu-messages");
  const el = document.createElement("div");
  el.className = `bandu-msg bandu-msg-${role}`;
  el.textContent = text;
  c.appendChild(el);
  while (c.children.length > 20) c.removeChild(c.firstChild);
  c.scrollTop = c.scrollHeight;
}

function showStatus(text) {
  const el = document.getElementById("bandu-status");
  if (el) el.textContent = text;
  if (text) log("状态:", text);
}

// ── 上下文工具 ────────────────────────────────────────────────────
function setSelectionContext(text, toolbarRect) {
  pendingContext = text;
  const bar     = document.getElementById("bandu-context-bar");
  const ctxText = document.getElementById("bandu-context-text");
  if (bar && ctxText) {
    ctxText.textContent = text.length > 28 ? text.slice(0, 28) + "…" : text;
    bar.style.display = "flex";
  }
  const input = document.getElementById("bandu-text-input");
  if (input) {
    input.placeholder = "追问这段话，直接回车则解释全文…";
    input.focus();
  }
  if (toolbarRect) showSelectionHighlight(toolbarRect, text);
  openPanel();
}

function clearContext() {
  pendingContext = "";
  const bar = document.getElementById("bandu-context-bar");
  if (bar) bar.style.display = "none";
  const input = document.getElementById("bandu-text-input");
  if (input) input.placeholder = "输入问题，回车发送…";
  hideSelectionHighlight();
}

// ── 选中区域光带（跟随滚动）────────────────────────────────────────
function _findScrollContainer() {
  // 找 weread 阅读器的实际滚动容器
  const selectors = [".reader_main", ".readerContent", ".reader_container",
                     ".readerChapterContent", ".reader_page", ".wr_absolute"];
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (!el) continue;
    const st = window.getComputedStyle(el);
    if (["scroll","auto"].includes(st.overflow) || ["scroll","auto"].includes(st.overflowY))
      return el;
  }
  return null; // 回退到 window scroll
}

function showSelectionHighlight(toolbarRect, text) {
  return; // 暂时关闭高亮定位，等修复后重新开启
  hideSelectionHighlight(); // 清理旧的

  // 工具栏出现在选区上方，从工具栏底部开始
  const viewportTop = toolbarRect.bottom + 4;

  // 微信读书默认列宽约 600px，18px 字体约 32 字/行，行高约 32px
  const lines  = Math.max(2, Math.ceil((text?.length ?? 60) / 32));
  const height = lines * 32;  // 不设上限，长选文不截断

  const el = document.createElement("div");
  el.id = "bandu-sel-highlight";
  el.style.top    = `${viewportTop}px`;
  el.style.height = `${height}px`;
  document.body.appendChild(el);

  // ── 监听滚动，动态修正 top ──
  hlScrollContainer = _findScrollContainer();
  const getScroll = () => hlScrollContainer ? hlScrollContainer.scrollTop : window.scrollY;
  hlBaseScrollTop  = getScroll();
  hlBaseTop        = viewportTop;

  hlScrollHandler = () => {
    const delta = getScroll() - hlBaseScrollTop;
    el.style.top = `${hlBaseTop - delta}px`;
  };
  const target = hlScrollContainer ?? window;
  target.addEventListener("scroll", hlScrollHandler, { passive: true, capture: true });
}

function hideSelectionHighlight() {
  if (hlScrollHandler) {
    const target = hlScrollContainer ?? window;
    target.removeEventListener("scroll", hlScrollHandler, { capture: true });
    hlScrollHandler = null;
  }
  const el = document.getElementById("bandu-sel-highlight");
  if (!el) return;
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 400);
}

function setInputValue(text) {
  const input = document.getElementById("bandu-text-input");
  const clearBtn = document.getElementById("bandu-input-clear");
  if (input) { input.value = text; input.focus(); }
  if (clearBtn) clearBtn.style.display = text ? "flex" : "none";
}

async function handleQuestion(question) {
  const q = question.trim();
  if (!q && !pendingContext) return;

  // 组合最终问题
  let fullQ;
  if (pendingContext && q) {
    fullQ = `关于这段话："${pendingContext}"，${q}`;
  } else if (pendingContext) {
    fullQ = `请帮我解释这段话："${pendingContext}"`;
  } else {
    fullQ = q;
  }
  clearContext();

  addMessage("user", fullQ);
  const voiceBtn      = document.getElementById("bandu-voice-btn");
  const sendBtn       = document.getElementById("bandu-send-btn");
  const msgContainer  = document.getElementById("bandu-messages");
  if (voiceBtn) voiceBtn.disabled = true;
  if (sendBtn)  sendBtn.disabled  = true;

  const typingEl = document.createElement("div");
  typingEl.className = "bandu-msg bandu-msg-assistant bandu-typing";
  typingEl.innerHTML = "<span></span><span></span><span></span>";
  msgContainer.appendChild(typingEl);
  msgContainer.scrollTop = msgContainer.scrollHeight;

  try {
    const context = await extractBookContext();
    const answer  = await askAI(fullQ, context);
    typingEl.remove();
    addMessage("assistant", answer);
    showStatus("");
    speakText(answer);
    saveHistory(fullQ, answer, context);
    const bookId = findBookIdFromPerformance();
    const related = await fetchRelated(fullQ, bookId);
    if (related.length > 0) showRelated(related);
  } catch (e) {
    typingEl.remove();
    if (e.status === 429) {
      showStatus("今日免费次数已用完，请点击扩展图标填写自己的 DeepSeek Key");
    } else if (e.status === 401) {
      showStatus("API Key 无效，请重新检查设置");
    } else {
      showStatus("连接失败，请稍后重试");
    }
  } finally {
    if (voiceBtn) voiceBtn.disabled = false;
    if (sendBtn)  sendBtn.disabled  = false;
  }
}

// ── 历史记录 ──────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function saveHistory(question, answer, context) {
  try {
    const bookId = findBookIdFromPerformance();
    await fetch(`${_settings.apiUrl}/history`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        book_id:       bookId,
        book_title:    context.bookTitle    || "",
        chapter_title: context.chapterTitle || "",
        question,
        answer,
        selection:     context.selection    || "",
      }),
    });
  } catch (e) {
    log("保存历史失败:", e.message);
  }
}

async function loadHistory() {
  const histEl = document.getElementById("bandu-history");
  if (!histEl) return;
  histEl.innerHTML = `<div class="bandu-hist-empty">加载中…</div>`;
  try {
    const bookId = findBookIdFromPerformance();
    const url = bookId
      ? `${_settings.apiUrl}/history?book_id=${encodeURIComponent(bookId)}&limit=40`
      : `${_settings.apiUrl}/history?limit=40`;
    const res = await fetch(url, { headers: keyHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { records } = await res.json();
    renderHistory(records);
  } catch (e) {
    histEl.innerHTML = `<div class="bandu-hist-empty">加载失败，请确认后端已启动</div>`;
    log("加载历史失败:", e.message);
  }
}

function renderHistory(records) {
  const histEl = document.getElementById("bandu-history");
  if (!histEl) return;
  if (!records || records.length === 0) {
    histEl.innerHTML = `<div class="bandu-hist-empty">还没有历史记录，开始提问吧</div>`;
    return;
  }
  histEl.innerHTML = records.map(r => {
    const parts = [r.book_title, r.chapter_title].filter(Boolean);
    const date  = r.created_at ? r.created_at.split(" ")[0] : "";
    if (date) parts.push(date);
    const meta = parts.join(" · ");
    return `<div class="bandu-hist-item">
      ${meta ? `<div class="bandu-hist-meta">${escHtml(meta)}</div>` : ""}
      <div class="bandu-hist-q">${escHtml(r.question)}</div>
      <div class="bandu-hist-a">${escHtml(r.answer)}</div>
    </div>`;
  }).join("");
}

async function fetchRelated(question, excludeBookId) {
  try {
    const params = new URLSearchParams({ q: question });
    if (excludeBookId) params.append("exclude_book_id", excludeBookId);
    const res = await fetch(`${_settings.apiUrl}/history/related?${params}`, { headers: keyHeaders() });
    if (!res.ok) return [];
    const { records } = await res.json();
    return records;
  } catch {
    return [];
  }
}

function showRelated(records) {
  const c = document.getElementById("bandu-messages");
  if (!c) return;
  const el = document.createElement("div");
  el.className = "bandu-related";
  el.innerHTML = `<div class="bandu-related-title">跨书关联</div>` +
    records.map(r => `
      <div class="bandu-related-item">
        <div class="bandu-related-book">《${escHtml(r.book_title || "未知")}》</div>
        <div class="bandu-related-q">${escHtml(r.question)}</div>
      </div>`).join("");
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function switchTab(tab) {
  const panel = document.getElementById("bandu-panel");
  if (panel) panel.setAttribute("data-tab", tab);
  document.getElementById("bandu-tab-chat")
    ?.classList.toggle("bandu-tab-active", tab === "chat");
  document.getElementById("bandu-tab-history")
    ?.classList.toggle("bandu-tab-active", tab === "history");
  if (tab === "history") loadHistory();
}

// ── 顶层事件绑定 ──────────────────────────────────────────────────
function bindTopEvents() {
  const fab        = document.getElementById("bandu-fab");
  const panel      = document.getElementById("bandu-panel");
  const closeBtn   = document.getElementById("bandu-close");
  const ttsBtn     = document.getElementById("bandu-tts-btn");
  const voiceBtn   = document.getElementById("bandu-voice-btn");
  const stopBtn    = document.getElementById("bandu-stop-btn");
  const sendBtn    = document.getElementById("bandu-send-btn");
  const textInput  = document.getElementById("bandu-text-input");
  const ctxClear   = document.getElementById("bandu-context-clear");
  const inputClear = document.getElementById("bandu-input-clear");

  // 风格切换 pill 按钮
  document.querySelectorAll(".bandu-style-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".bandu-style-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _settings.style = btn.dataset.style;
      // 同步存回 storage
      try { chrome.storage.local.set({ style: _settings.style }); } catch {}
    });
  });
  // 初始化时同步当前风格到按钮高亮
  function syncStyleBtn(style) {
    document.querySelectorAll(".bandu-style-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.style === (style || "simple"));
    });
  }
  syncStyleBtn(_settings.style);
  // 当 popup 改变风格时实时同步
  try { chrome.storage.onChanged.addListener(changes => {
    if (changes.style) syncStyleBtn(changes.style.newValue);
  }); } catch {}

  // 标签切换
  document.getElementById("bandu-tab-chat")
    ?.addEventListener("click", () => switchTab("chat"));
  document.getElementById("bandu-tab-history")
    ?.addEventListener("click", () => switchTab("history"));

  fab.addEventListener("click", () => {
    panel.classList.toggle("bandu-panel-open");
    fab.classList.toggle("bandu-fab-active");
  });

  closeBtn.addEventListener("click", () => {
    panel.classList.remove("bandu-panel-open");
    fab.classList.remove("bandu-fab-active");
    stopVoice(); stopAudio(); clearContext();
  });

  ttsBtn.addEventListener("click", () => {
    ttsEnabled = !ttsEnabled;
    ttsBtn.textContent = ttsEnabled ? "🔊" : "🔇";
    if (!ttsEnabled) stopAudio();
  });

  voiceBtn.addEventListener("click", async () => {
    if (isListening) {
      setVoiceState("processing");   // 立即给用户视觉反馈，不等 onstop
      showStatus("识别中…");
      stopVoice();
      return;
    }
    setVoiceState("preparing");
    showStatus("准备中…");
    await startVoice(
      (text) => {
        setInputValue(text);
        showStatus("识别完成 — 确认后回车发送，或点 ✕ 清除重录");
      },
      () => {
        setVoiceState("idle");
        isListening = false;
      }
    );
  });

  stopBtn.addEventListener("click", stopAudio);

  sendBtn.addEventListener("click", () => {
    const q = textInput.value.trim();
    if (q || pendingContext) {
      textInput.value = "";
      if (inputClear) inputClear.style.display = "none";
      handleQuestion(q);
    }
  });

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendBtn.click();
  });

  textInput.addEventListener("input", () => {
    if (inputClear) inputClear.style.display = textInput.value ? "flex" : "none";
  });

  if (inputClear) {
    inputClear.addEventListener("click", () => {
      textInput.value = "";
      inputClear.style.display = "none";
      textInput.focus();
      showStatus("");
    });
  }

  if (ctxClear) {
    ctxClear.addEventListener("click", () => {
      clearContext();
    });
  }


  // 接收 iframe 的选词结果
  window.addEventListener("message", (e) => {
    if (e.data?.type !== "BANDU_SEL") return;
    const { text } = e.data;
    if (text && text.length > 5) {
      capturedSel = { text, rect: null };
      log("iframe 选词:", JSON.stringify(text.slice(0, 20)));
    }
  });

  // ── MutationObserver：监听 .wr_copy 按钮出现，精确定位工具栏 ──
  const toolbarObserver = new MutationObserver(() => {
    const copyBtn = document.querySelector("button.wr_copy, .toolbarItem.wr_copy");
    if (!copyBtn) return;
    const toolbar = copyBtn.parentElement;
    if (!toolbar || toolbar.querySelector("#bandu-inject-btn")) return;

    // 工具栏出现时立刻抓文字（选区此时还活跃）
    const textAtAppear = window.getSelection()?.toString().trim() || capturedSel.text;
    log("工具栏出现，抓到文字:", JSON.stringify(textAtAppear?.slice(0, 30)));
    injectBanduButton(toolbar, copyBtn, textAtAppear);
  });
  toolbarObserver.observe(document.body, { childList: true, subtree: true });

  // Ctrl+Shift+E：用上次缓存的文字直接提问
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "E" && capturedSel.text) {
      e.preventDefault();
      openPanel();
      handleQuestion(`请帮我解释这段话："${capturedSel.text}"`);
    }
  });

  // 点击面板外部自动关闭
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("bandu-panel-open")) return;
    if (!panel.contains(e.target) && !fab.contains(e.target)) {
      panel.classList.remove("bandu-panel-open");
      fab.classList.remove("bandu-fab-active");
    }
  });
}

// ── iframe 内的划词监听 ───────────────────────────────────────────
function bindIframeEvents() {
  document.addEventListener("mouseup", (e) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    log("iframe mouseup，文字:", JSON.stringify(text.slice(0, 20)));
    window.parent.postMessage({
      type: "BANDU_SEL",
      text,
      mouseX: e.clientX,
      mouseY: e.clientY,
    }, "https://weread.qq.com");
  }, true);

  // iframe 内的快捷键转发给父页面
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      const text = window.getSelection()?.toString().trim() ?? "";
      window.parent.postMessage({ type: "BANDU_SEL", text, rect: null, forceAsk: true }, "https://weread.qq.com");
    }
  }, true);
}


// 在 weread 工具栏里注入"讲讲"按钮
function injectBanduButton(toolbar, copyBtn, savedText) {
  if (toolbar.querySelector("#bandu-inject-btn")) return;

  const btn = document.createElement("button");
  btn.id = "bandu-inject-btn";
  btn.className = "toolbarItem";
  // 蓝色高亮，区别于其他白色按钮
  btn.style.cssText = "color: #4f8ef7 !important;";
  btn.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
      <path d="M8 10c0-.83.67-1.5 1.5-1.5S11 9.17 11 10v4c0 .83-.67 1.5-1.5 1.5S8 14.83 8 14v-4zm5 0c0-.83.67-1.5 1.5-1.5S16 9.17 16 10v4c0 .83-.67 1.5-1.5 1.5S13 14.83 13 14v-4z" fill="currentColor"/>
      <path d="M5.5 12a6.5 6.5 0 0 0 6.5 6.5v1.5A8 8 0 0 1 4 12h1.5zm13 0A6.5 6.5 0 0 0 12 5.5V4a8 8 0 0 1 8 8h-1.5z" fill="currentColor"/>
    </svg>
    <span class="toolbarItem_text">讲讲</span>
  `;

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();

    // 在 copyBtn.click() 让工具栏消失之前，先记录工具栏位置（用于高亮定位）
    const toolbarRect = toolbar.getBoundingClientRect();

    let text = "";
    try {
      copyBtn.click();
      await new Promise(r => setTimeout(r, 150));
      text = (await navigator.clipboard.readText()).trim();
    } catch (err) {
      log("剪贴板读取失败:", err.message);
    }

    log("讲讲点击，获取到文字:", JSON.stringify(text?.slice(0, 30)));

    if (text && text.length > 2) {
      setSelectionContext(text, toolbarRect);
    } else {
      log("文字为空");
    }
  });

  // 插到复制按钮后面
  copyBtn.after(btn);
  log("讲讲按钮已注入工具栏，类名:", btn.className);
}


// ── 初始化 ────────────────────────────────────────────────────────
if (IS_TOP) {
  log("顶层初始化，等待阅读器 DOM...");
  loadSettings().then(() => {
    const check = setInterval(() => {
      const found = document.querySelector(".readerChapterContent, .reader_container, .readerTopBar, .wr_absolute");
      if (found) {
        log("找到阅读器 DOM:", found.className);
        clearInterval(check);
        buildUI();
      }
    }, 500);
    setTimeout(() => { clearInterval(check); log("等待超时，强制建 UI"); buildUI(); }, 15000);
  });

  // 设置变更时实时同步（用户在 popup 保存后立即生效）
  chrome.storage.onChanged.addListener((changes) => {
    const keys = ["apiUrl", "deepseekKey", "siliconflowKey", "wereadKey", "style", "tts"];
    if (keys.some(k => k in changes)) loadSettings();
  });
} else {
  log("iframe 初始化，绑定划词事件");
  bindIframeEvents();
}
