// 伴读讲讲 — Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log("[伴读讲讲] 扩展已安装");
});

// 转发 content script 的 API 请求（解决 CORS 限制备用方案）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ASK_AI") {
    fetchAI(msg.payload)
      .then((answer) => sendResponse({ ok: true, answer }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 保持消息通道开放（异步响应必须）
  }
});

async function fetchAI({ question, context }) {
  const res = await fetch("http://localhost:8001/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, context }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.answer;
}
