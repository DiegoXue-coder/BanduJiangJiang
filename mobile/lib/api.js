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
