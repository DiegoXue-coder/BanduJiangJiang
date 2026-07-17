import CryptoJS from 'crypto-js';

// ── 后端地址 ──────────────────────────────────────────────────────────
// 手机端新接口(/app/*)直接指向生产环境——书库内容是真实预置书籍，
// 不像旧的聊天原型那样需要连本机局域网后端做临时联调。
export const API_BASE = 'https://bandujiangjiang-production.up.railway.app';

// ── HMAC 会员卡式验证 ────────────────────────────────────────────────
// 与 extension/content/content.js 用的是同一个密钥、同一套算法
// （后端 EXTENSION_SECRET 对应），复用现有验证机制，不是重新设计。
const EXT_SECRET = 'ce15f8e8-5956-42c5-9a6d-a0fc7d504f7b';

function getExtToken() {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return CryptoJS.HmacSHA256(day, EXT_SECRET).toString(CryptoJS.enc.Hex).slice(0, 32);
}

/** 带鉴权头的 fetch 封装，所有 /app/* 接口调用统一走这个。 */
export async function appFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'x-extension-token': getExtToken(),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail}`.trim());
  }
  return res.json();
}

export async function getLibrary() {
  return appFetch('/app/books');
}

export async function getBookContext(bookId) {
  return appFetch(`/app/books/${bookId}/context`);
}

// 阅读器用 epubjs-react-native 内置的 expo-file-system 下载 EPUB 文件，
// 走的是普通 URL 下载，不会附带自定义请求头——所以这里把 token 放进
// query string，跟后端 _verify_token 的 query 兜底逻辑对应。
//
// 路径必须以 .epub 结尾：epubjs-react-native 靠 URL 字符串里有没有
// ".epub" 子串判断源文件类型，没有的话会内部报错但不会显示出来，界面卡在
// "正在下载书本"转圈——真机实测踩到的坑，不是猜的。
export function getBookFileUrl(bookId) {
  return `${API_BASE}/app/books/${bookId}/file.epub?token=${getExtToken()}`;
}

export async function getHighlights(bookId) {
  return appFetch(`/app/books/${bookId}/highlights`);
}

export async function saveHighlight(bookId, { cfiLocation, highlightedText, note = '' }) {
  return appFetch(`/app/books/${bookId}/highlights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cfi_location: cfiLocation,
      highlighted_text: highlightedText,
      note,
    }),
  });
}

export async function updateProgress(bookId, cfiLocation) {
  return appFetch(`/app/books/${bookId}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cfi_location: cfiLocation }),
  });
}

// ── 阶段四：AI 对话 + 语音 ──────────────────────────────────────────
// 这几个接口（/ask、/tts/play、/transcribe、/history）在阶段一就确认过是
// 格式无关的"独立能力"，浏览器插件和手机端共用同一套，不用另起一套后端逻辑。

// 流式版 /ask（阶段六）。RN 的 fetch 在部分环境下拿不到可读流，用
// XMLHttpRequest 的 onprogress 读 responseText 增量这个更稳的老办法
// （SSE 本质上就是持续增长的文本，不需要真的用 EventSource）。
// 返回一个"取消"函数，调用方在组件卸载/用户中断时可以 abort 掉请求。
export function streamAsk({ context, question, style = 'simple', history = [] }, { onDelta, onDone, onError }) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/ask/stream`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('x-extension-token', getExtToken());

  let readIndex = 0;
  let buffer = '';

  xhr.onprogress = () => {
    const newText = xhr.responseText.slice(readIndex);
    readIndex = xhr.responseText.length;
    buffer += newText;

    const parts = buffer.split('\n\n');
    buffer = parts.pop(); // 最后一段可能还没收全，留到下次 onprogress 再拼
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      let payload;
      try {
        payload = JSON.parse(jsonStr);
      } catch {
        continue;
      }
      if (payload.delta) onDelta(payload.delta);
      else if (payload.done) onDone(payload.answer);
      else if (payload.error) onError(new Error(payload.error));
    }
  };

  xhr.onerror = () => onError(new Error('网络请求失败'));
  xhr.onload = () => {
    if (xhr.status >= 400) onError(new Error(`HTTP ${xhr.status}`));
  };

  xhr.send(JSON.stringify({ context, question, style, history }));
  return () => xhr.abort();
}

// /tts/play 这个接口本身不带鉴权（跟 /app/books/{id}/file.epub 同理，是要
// 直接当音频播放地址用的，expo-av 不会带自定义请求头）。
export function getTtsPlayUrl(text, voice = 'zh-CN-XiaoxiaoNeural') {
  return `${API_BASE}/tts/play?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;
}

export async function transcribeAudio(fileUri, uploadAsync, FileSystemUploadType) {
  const result = await uploadAsync(`${API_BASE}/transcribe`, fileUri, {
    httpMethod: 'POST',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: {
      'Content-Type': 'audio/m4a',
      'x-extension-token': getExtToken(),
    },
  });
  if (result.status && result.status >= 400) {
    throw new Error(`HTTP ${result.status} ${result.body || ''}`.trim());
  }
  return JSON.parse(result.body).text;
}

export async function saveQaHistory({ bookId, bookTitle, chapterTitle, question, answer, selection = '', cfiRange = '' }) {
  return appFetch('/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      book_id: String(bookId),
      book_title: bookTitle,
      chapter_title: chapterTitle,
      question,
      answer,
      selection,
      cfi_location: cfiRange,
    }),
  });
}

// ── 阶段五：划线复盘 ────────────────────────────────────────────────

export async function getReview() {
  return appFetch('/app/review');
}
