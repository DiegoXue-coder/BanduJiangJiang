import CryptoJS from 'crypto-js';
import * as SecureStore from 'expo-secure-store';

// ── 后端地址 ──────────────────────────────────────────────────────────
// 手机端新接口(/app/*)直接指向生产环境——书库内容是真实预置书籍，
// 不像旧的聊天原型那样需要连本机局域网后端做临时联调。
export const API_BASE = 'https://bandujiangjiang-production.up.railway.app';

// ── HMAC 会员卡式验证 ────────────────────────────────────────────────
// 与 extension/content/content.js 用的是同一个密钥、同一套算法
// （后端 EXTENSION_SECRET 对应），复用现有验证机制，不是重新设计。
// 阶段十三之后 /app/* 接口不再看这个token了（换成JWT），但 /history、
// /ask、/tts、/transcribe 这几个跟插件共用的接口鉴权维持不变，继续要发。
const EXT_SECRET = 'ce15f8e8-5956-42c5-9a6d-a0fc7d504f7b';

function getExtToken() {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return CryptoJS.HmacSHA256(day, EXT_SECRET).toString(CryptoJS.enc.Hex).slice(0, 32);
}

// ── 阶段十三：登录态（JWT）───────────────────────────────────────────
// token 存 SecureStore（安全存储，不是明文AsyncStorage），同时内存里缓存
// 一份——getBookFileUrl这类要同步拼URL的地方等不起SecureStore的异步读取，
// App启动时 loadStoredToken() 会先把这份内存缓存填好。
const TOKEN_KEY = 'bandu_auth_token';
let cachedToken = null;

/** App 启动时调一次：把 SecureStore 里存的 token 读进内存缓存，返回它
 * （null 表示没登录过/已登出）。*/
export async function loadStoredToken() {
  cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
  return cachedToken;
}

async function setToken(token) {
  cachedToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export function isLoggedIn() {
  return !!cachedToken;
}

// 退出登录（用户主动点"我的"页的退出按钮）和token失效（后端401）最终要
// 做的事完全一样：清token+通知订阅者弹回登录页，所以共用同一套广播逻辑，
// 不要在 ProfileScreen 里另起一条"退出登录该怎么通知App"的路径。
const authExpiredListeners = new Set();
export function onAuthExpired(fn) {
  authExpiredListeners.add(fn);
  return () => authExpiredListeners.delete(fn);
}
function clearLoginState() {
  cachedToken = null;
  authExpiredListeners.forEach((fn) => fn());
}

export async function logout() {
  clearLoginState();
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function register(username, password) {
  const res = await fetch(`${API_BASE}/app/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  await setToken(data.token);
  return data;
}

export async function login(username, password) {
  const res = await fetch(`${API_BASE}/app/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  await setToken(data.token);
  return data;
}

// token失效（过期/被后端拒绝）时，appFetch 在这里清掉本地登录态并广播，
// 订阅者（App.js）负责把用户弹回登录页。
function notifyAuthExpired() {
  clearLoginState();
  SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}

/** 带鉴权头的 fetch 封装，所有 /app/* 及共用接口调用统一走这个。
 * x-extension-token 一直带（插件同款接口要用），登录后额外带
 * Authorization（/app/* 接口靠这个识别真实用户）。*/
export async function appFetch(path, options = {}) {
  const headers = {
    'x-extension-token': getExtToken(),
    ...options.headers,
  };
  if (cachedToken) headers['Authorization'] = `Bearer ${cachedToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && path.startsWith('/app/')) {
    notifyAuthExpired();
  }
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

// JWT本身含两个"."（header.payload.signature标准格式）。epub.js嗅探文件
// 类型是看"URL里最后一个.后面是什么"，如果直接把JWT明文拼进query string，
// 最后一个"."会落在token内部而不是".epub"后面，库会误判成不认识的文件
// 类型、退化成"当成解压过的目录处理"，去请求一个不存在的.../META-INF/
// container.xml，界面卡死在"正在加载"——真机联调抓真实请求日志坐实的。
// 转成十六进制字符串（只含0-9a-f，没有任何"."）能从根上绕开这个问题，
// 不用去改第三方库。后端 get_current_user 对应会把这段十六进制解码回JWT。
function toHexToken(token) {
  let hex = '';
  for (let i = 0; i < token.length; i++) {
    hex += token.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

// 阅读器用 epubjs-react-native 内置的 expo-file-system 下载 EPUB 文件，
// 走的是普通 URL 下载，不会附带自定义请求头——所以这里把 token 放进
// query string，跟后端 get_current_user 的 query 兜底逻辑对应。阶段十三
// 这个接口鉴权从 ExtAuth 换成了 CurrentUser（JWT），这里也跟着从扩展令牌
// 换成登录 token；同步读内存缓存（不是 await SecureStore）是因为这个函数
// 直接内联用在 JSX 的 src 属性里，调用方等不起异步。
//
// 路径必须以 .epub 结尾：epubjs-react-native 靠 URL 字符串里有没有
// ".epub" 子串判断源文件类型，没有的话会内部报错但不会显示出来，界面卡在
// "正在下载书本"转圈——真机实测踩到的坑，不是猜的。
export function getBookFileUrl(bookId) {
  return `${API_BASE}/app/books/${bookId}/file.epub?token=${toHexToken(cachedToken || '')}`;
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

export async function deleteHighlight(bookId, highlightId) {
  return appFetch(`/app/books/${bookId}/highlights/${highlightId}`, { method: 'DELETE' });
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

// ── 阶段十二：知识图谱 ──────────────────────────────────────────────
// 图谱页面只读预算好的结果（概念提取/去重/关联检测是重AI调用的后台批处理，
// 不在App里触发，由内容维护流程单独跑 POST /app/concept-graph/build）。

export async function getConceptGraph() {
  return appFetch('/app/concept-graph');
}

// ── 阶段十四：测试阶段Bug反馈 ────────────────────────────────────────
// 相册选图+文字描述，不做程序自动截屏（避免额外的权限/技术复杂度，决策层
// 拍板范围）。appFetch 不手动设 Content-Type——RN 的 fetch 遇到 FormData
// 类型的 body 会自动生成正确的 multipart boundary，手动设反而会出错。
export async function submitBugReport(description, imageUri) {
  const formData = new FormData();
  formData.append('description', description);
  formData.append('image', {
    uri: imageUri,
    name: 'bug_report.jpg',
    type: 'image/jpeg',
  });
  return appFetch('/app/bug-reports', {
    method: 'POST',
    body: formData,
  });
}
