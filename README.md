# 伴读讲讲

微信读书 AI 语音伴读助手 — 遇到难懂的段落，划词就能听 AI 讲解。

![版本](https://img.shields.io/badge/版本-0.1.0-blue)
![平台](https://img.shields.io/badge/平台-Chrome-green)
![License](https://img.shields.io/badge/license-MIT-orange)

---

## 这是什么

在微信读书网页版读书时，遇到看不懂的段落：

1. 用鼠标划选文字
2. 点工具栏里出现的「讲讲」按钮
3. AI 用语音帮你解释，就像朋友坐在旁边讲给你听

也可以直接打字或语音提问，AI 结合书本上下文回答。

---

## 功能

- **划词解释** — 选中任意段落，一键获得通俗讲解
- **语音朗读** — AI 回答自动转语音播报（微软 Edge TTS）
- **语音提问** — 直接开口问，无需打字
- **对话追问** — 支持多轮追问，越聊越深
- **历史记录** — 保存所有问答，随时回顾

---

## 安装

### 1. 下载代码

点右上角绿色 **Code** 按钮 → **Download ZIP** → 解压到任意文件夹

### 2. 加载到 Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启**开发者模式**
3. 点**加载已解压的扩展程序**
4. 选择刚才解压的文件夹（选根目录，不是 `api` 子目录）

### 3. 配置 API Key

点 Chrome 右上角的扩展图标 → 找到「伴读讲讲」→ 填入 DeepSeek API Key

**获取 DeepSeek API Key：**
- 注册：[platform.deepseek.com](https://platform.deepseek.com/api_keys)
- 充值约 10 元，可使用非常长时间

### 4. 开始使用

打开 [微信读书网页版](https://weread.qq.com)，划选任意文字，点「讲讲」。

---

## 可选配置

在扩展 popup 的「可选功能」里还可以填写：

| Key | 用途 | 获取地址 |
|-----|------|---------|
| SiliconFlow API Key | 高精度中文语音识别（不填则使用浏览器内置） | [cloud.siliconflow.cn](https://cloud.siliconflow.cn/account/ak) |
| 微信读书 Skill Key | 获取用户划线、热门标注等增强上下文 | [weread.qq.com/r/weread-skills](https://weread.qq.com/r/weread-skills) |

---

## 技术栈

| 层 | 技术 |
|----|------|
| Chrome 扩展 | MV3，content script + popup |
| 后端 | Python + FastAPI，部署在 Railway |
| AI 对话 | DeepSeek Chat |
| 语音合成 | Microsoft Edge TTS（免费）|
| 语音识别 | SiliconFlow SenseVoice（可选）|

---

## 常见问题

**Q：需要一直开着后端吗？**
不需要，后端已部署在云端，安装扩展填好 Key 直接用。

**Q：费用怎么算？**
后端服务免费。你只需要自己的 DeepSeek API Key，按使用量计费，10 元可以用很久。

**Q：我的 API Key 安全吗？**
Key 只存在你本地浏览器里（chrome.storage），每次请求通过 HTTPS 加密传输，后端不存储你的 Key。

---

## 反馈

有问题或建议，欢迎提 [Issue](https://github.com/DiegoXue-coder/BanduJiangJiang/issues)。
