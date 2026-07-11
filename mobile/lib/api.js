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
export function getBookFileUrl(bookId) {
  return `${API_BASE}/app/books/${bookId}/file?token=${getExtToken()}`;
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
