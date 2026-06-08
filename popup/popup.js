const DEFAULT_API_URL = "https://bandujiangjiang-production.up.railway.app";

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "apiUrl", "deepseekKey", "siliconflowKey", "wereadKey", "style", "tts",
  ]);
  document.getElementById("api-url").value        = data.apiUrl        || DEFAULT_API_URL;
  document.getElementById("deepseek-key").value   = data.deepseekKey   || "";
  document.getElementById("siliconflow-key").value= data.siliconflowKey|| "";
  document.getElementById("weread-key").value     = data.wereadKey     || "";
  document.getElementById("style-select").value   = data.style         || "simple";
  document.getElementById("tts-toggle").checked   = data.tts !== false;

  // 首次安装：DeepSeek Key 为空时自动展开并聚焦
  if (!data.deepseekKey) {
    document.getElementById("deepseek-key").focus();
  }
}

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

// 保存
document.getElementById("save-btn").addEventListener("click", async () => {
  const deepseekKey = document.getElementById("deepseek-key").value.trim();
  if (!deepseekKey) {
    const msg = document.getElementById("save-msg");
    msg.textContent = "请填写 DeepSeek API Key";
    msg.style.color = "#e05252";
    setTimeout(() => { msg.textContent = ""; msg.style.color = ""; }, 3000);
    document.getElementById("deepseek-key").focus();
    return;
  }

  await chrome.storage.local.set({
    apiUrl:         document.getElementById("api-url").value.trim()         || DEFAULT_API_URL,
    deepseekKey,
    siliconflowKey: document.getElementById("siliconflow-key").value.trim(),
    wereadKey:      document.getElementById("weread-key").value.trim(),
    style:          document.getElementById("style-select").value,
    tts:            document.getElementById("tts-toggle").checked,
  });

  const msg = document.getElementById("save-msg");
  msg.textContent = "已保存 ✓";
  msg.style.color = "";
  setTimeout(() => (msg.textContent = ""), 2000);
});

loadSettings();
