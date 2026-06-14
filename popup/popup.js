const DEFAULT_API_URL = "https://bandujiangjiang-production.up.railway.app";
const _EXT_SECRET = "REPLACE_WITH_YOUR_SECRET";

async function _getExtToken() {
  const day = new Date().toISOString().slice(0, 10);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(_EXT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(day));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "apiUrl", "deepseekKey", "siliconflowKey", "wereadKey", "style", "tts", "darkMode",
  ]);
  document.getElementById("api-url").value        = data.apiUrl        || DEFAULT_API_URL;
  document.getElementById("deepseek-key").value   = data.deepseekKey   || "";
  document.getElementById("siliconflow-key").value= data.siliconflowKey|| "";
  document.getElementById("weread-key").value     = data.wereadKey     || "";
  document.getElementById("style-select").value   = data.style         || "simple";
  document.getElementById("tts-toggle").checked   = data.tts !== false;
  document.getElementById("dark-mode-toggle").checked = !!data.darkMode;

  // 首次安装：DeepSeek Key 为空时自动展开并聚焦
  if (!data.deepseekKey) {
    document.getElementById("deepseek-key").focus();
  }

  // 加载免费额度
  const apiUrl = data.apiUrl || DEFAULT_API_URL;
  loadFreeQuota(apiUrl, !!data.deepseekKey);
}

async function loadFreeQuota(apiUrl, hasOwnKey) {
  const bar  = document.getElementById("free-quota-bar");
  const text = document.getElementById("free-quota-text");
  if (hasOwnKey) {
    bar.className = "popup-quota-bar quota-own";
    text.textContent = "使用自己的 API Key · 不限次数";
    return;
  }
  try {
    const res  = await fetch(`${apiUrl}/free-quota`);
    const data = await res.json();
    const rem  = data.remaining ?? 0;
    const lim  = data.limit ?? 20;
    bar.className = rem > 5 ? "popup-quota-bar quota-ok"
                  : rem > 0 ? "popup-quota-bar quota-low"
                  :           "popup-quota-bar quota-empty";
    text.textContent = rem > 0
      ? `今日免费额度：剩余 ${rem} / ${lim} 次`
      : `今日免费额度已用完，请填写自己的 Key`;
  } catch {
    bar.className = "popup-quota-bar quota-error";
    text.textContent = "无法连接到服务器";
  }
}

// SiliconFlow 测试
document.getElementById("test-sf-btn").addEventListener("click", async () => {
  const btn    = document.getElementById("test-sf-btn");
  const result = document.getElementById("test-sf-result");
  const sfKey  = document.getElementById("siliconflow-key").value.trim();
  const apiUrl = document.getElementById("api-url").value.trim() || DEFAULT_API_URL;

  if (!sfKey) {
    result.textContent = "请先填写 SiliconFlow API Key";
    result.className = "popup-test-result test-fail";
    return;
  }
  btn.disabled = true; btn.textContent = "测试中…"; result.textContent = "";
  try {
    const extToken = await _getExtToken();
    const res = await fetch(`${apiUrl}/transcribe`, {
      method: "POST",
      headers: { "X-SiliconFlow-Key": sfKey, "Content-Type": "audio/webm", "X-Extension-Token": extToken },
      body: new Uint8Array(0),
    });
    if (res.status === 400 || res.ok) {
      result.textContent = "✅ SiliconFlow Key 有效";
      result.className = "popup-test-result test-ok";
    } else if (res.status === 401 || res.status === 403) {
      result.textContent = "❌ Key 无效，请检查是否填写正确";
      result.className = "popup-test-result test-fail";
    } else {
      result.textContent = `❌ 错误 (${res.status})`;
      result.className = "popup-test-result test-fail";
    }
  } catch {
    result.textContent = "❌ 无法连接服务器";
    result.className = "popup-test-result test-fail";
  }
  btn.disabled = false; btn.textContent = "测试";
});

// WeRead 测试
document.getElementById("test-wr-btn").addEventListener("click", async () => {
  const btn    = document.getElementById("test-wr-btn");
  const result = document.getElementById("test-wr-result");
  const wrKey  = document.getElementById("weread-key").value.trim();
  const apiUrl = document.getElementById("api-url").value.trim() || DEFAULT_API_URL;

  if (!wrKey) {
    result.textContent = "请先填写微信读书 Skill Key";
    result.className = "popup-test-result test-fail";
    return;
  }
  btn.disabled = true; btn.textContent = "测试中…"; result.textContent = "";
  try {
    const extToken = await _getExtToken();
    const res = await fetch(`${apiUrl}/context/current`, {
      headers: { "X-WeRead-Key": wrKey, "X-Extension-Token": extToken },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.bookTitle) {
        result.textContent = `✅ 连接成功，当前在读：${data.bookTitle}`;
      } else {
        result.textContent = "✅ Key 有效（暂无正在阅读的书）";
      }
      result.className = "popup-test-result test-ok";
    } else {
      result.textContent = "❌ Key 无效，请重新获取";
      result.className = "popup-test-result test-fail";
    }
  } catch {
    result.textContent = "❌ 无法连接服务器";
    result.className = "popup-test-result test-fail";
  }
  btn.disabled = false; btn.textContent = "测试";
});

// 深夜模式切换 — 实时同步到内容脚本
document.getElementById("dark-mode-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ darkMode: e.target.checked });
});

// 折叠面板
document.querySelectorAll(".popup-collapse-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const panelId = btn.dataset.target;
    const panel   = document.getElementById(panelId);
    const arrow   = btn.querySelector(".collapse-arrow");
    const open    = panel.classList.toggle("open");
    arrow.textContent = open ? "▼" : "▶";
  });
});

// 显示/隐藏 Key
document.querySelectorAll(".popup-eye-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type  = input.type === "password" ? "text" : "password";
  });
});

// 测试连接
document.getElementById("test-btn").addEventListener("click", async () => {
  const btn    = document.getElementById("test-btn");
  const result = document.getElementById("test-result");
  const apiUrl = document.getElementById("api-url").value.trim() || DEFAULT_API_URL;
  const dsKey  = document.getElementById("deepseek-key").value.trim();

  btn.disabled = true;
  btn.textContent = "测试中…";
  result.textContent = "";
  result.className = "popup-test-result";

  try {
    const headers = { "Content-Type": "application/json" };
    if (dsKey) headers["X-DeepSeek-Key"] = dsKey;
    headers["X-Extension-Token"] = await _getExtToken();

    const res = await fetch(`${apiUrl}/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        question: "ping",
        context: { bookTitle: "", author: "", chapterTitle: "", pageText: "", selection: "", userHighlights: [], popularHighlights: [] }
      }),
    });

    if (res.ok) {
      result.textContent = "✅ 连接成功，API Key 有效";
      result.className = "popup-test-result test-ok";
    } else if (res.status === 401) {
      result.textContent = "❌ API Key 无效，请检查是否填写正确";
      result.className = "popup-test-result test-fail";
    } else if (res.status === 429) {
      result.textContent = "✅ 服务器正常（今日免费次数已用完，请填写自己的 Key）";
      result.className = "popup-test-result test-ok";
    } else {
      result.textContent = `❌ 服务器错误 (${res.status})`;
      result.className = "popup-test-result test-fail";
    }
  } catch {
    result.textContent = "❌ 无法连接服务器，请检查网络";
    result.className = "popup-test-result test-fail";
  }

  btn.disabled = false;
  btn.textContent = "测试连接";
});

// 保存
document.getElementById("save-btn").addEventListener("click", async () => {
  const deepseekKey = document.getElementById("deepseek-key").value.trim();

  await chrome.storage.local.set({
    apiUrl:         document.getElementById("api-url").value.trim()         || DEFAULT_API_URL,
    deepseekKey,
    siliconflowKey: document.getElementById("siliconflow-key").value.trim(),
    wereadKey:      document.getElementById("weread-key").value.trim(),
    style:          document.getElementById("style-select").value,
    tts:            document.getElementById("tts-toggle").checked,
    darkMode:       document.getElementById("dark-mode-toggle").checked,
  });

  const msg = document.getElementById("save-msg");
  msg.textContent = "已保存 ✓";
  msg.style.color = "";
  setTimeout(() => (msg.textContent = ""), 2000);
});

loadSettings();
