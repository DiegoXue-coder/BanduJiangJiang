# 伴读讲讲

AI 语音伴读产品 — 划线 → AI 苏格拉底式讲解 → 语音对话。正在从 Chrome 插件转型为独立手机 App。

![状态](https://img.shields.io/badge/状态-开发中-yellow)
![平台](https://img.shields.io/badge/平台-React%20Native%20%2F%20Expo-blue)
![License](https://img.shields.io/badge/license-MIT-orange)

> **给招聘方/评审的说明**：本项目目前是 Expo Go 开发中的原型，还没有正式发布，暂时无法直接点击体验。这份 README 的目的是让你不需要安装任何工具，就能看懂项目的产品思路、架构决策和当前进度——真正的完整记录在下面链接的 `docs/` 文件夹里。

---

## 一句话定位

面向"公版经典精读"的手机 App：划线 → AI 苏格拉底式讲解 → 语音对话，长期目标是把阅读行为数据沉淀成"数据飞轮"（跨书连接、读书复盘）。

## 项目沿革

1. **v0（已冻结，见下方"历史版本"）**：依附微信读书网页版的 Chrome 扩展，AI 语音伴读助手
2. **v1（当前开发中）**：转型为完全独立的手机 App（React Native / Expo），放弃微信读书 API 依赖，自建公版经典书库

## 关键决策（面试/评审可以直接看这几篇）

- **内容来源**：商业电子书几乎全带 DRM，无法合法导入第三方阅读器 → 把这个限制转化为差异化定位，聚焦"公版经典/值得精读的书"，完全合法无版权风险
- **语音交互形态**：级联式架构（DeepSeek文字 + STT/TTS）+ 手动打断按钮，不做端到端实时打断——判断依据是真正的端到端语音大模型个人开发阶段有企业认证门槛
- **技术栈**：React Native/Expo 而非 Flutter——判断标准是"产品是否需要分子级跨平台一致性"，阅读陪伴类App不需要
- **产品形态**："两条腿走路"——手机App做门面，后端同时按"可被外部AI调用"的方式设计接口，为未来包一层MCP server留余地

## 完整文档

- [`docs/学习笔记/`](docs/学习笔记/00-技能清单.md) — 每个技术决策的完整推理过程（语音架构、跨平台框架、EPUB渲染、数据库Schema、账号体系、后端API设计）
- [`docs/项目管理/`](docs/项目管理/01-范围声明.md) — 范围声明、WBS任务分解、风险登记表、验收标准、开发进度记录
- [`docs/作品集/00-作品集索引.md`](docs/作品集/00-作品集索引.md) — 求职作品集材料索引

## 技术栈

| 层 | 技术 |
|----|------|
| 移动端框架 | React Native / Expo |
| EPUB 渲染 | `@epubjs-react-native`（WebView + epub.js） |
| 后端 | Python 3.13 + FastAPI |
| 数据库 | PostgreSQL + pgvector（Railway 托管） |
| AI 对话 | DeepSeek Chat |
| 语音合成/识别 | Microsoft Edge TTS / SiliconFlow SenseVoiceSmall |

---

## 历史版本：Chrome 插件（已冻结，不再迭代）

微信读书 AI 语音伴读助手 — 遇到难懂的段落，划词就能听 AI 讲解。这是项目最早的形态，验证了"AI语音讲解阅读内容"这个核心体验，后续转型为不依赖微信读书的独立手机App（即上方v1）。

<details>
<summary>点击展开安装说明</summary>

### 这是什么

在微信读书网页版读书时，遇到看不懂的段落：

1. 用鼠标划选文字
2. 点工具栏里出现的「讲讲」按钮
3. AI 用语音帮你解释，就像朋友坐在旁边讲给你听

也可以直接打字或语音提问，AI 结合书本上下文回答。

### 功能

- **划词解释** — 选中任意段落，一键获得通俗讲解
- **语音朗读** — AI 回答自动转语音播报（微软 Edge TTS）
- **语音提问** — 直接开口问，无需打字
- **对话追问** — 支持多轮追问，越聊越深
- **历史记录** — 保存所有问答，随时回顾

### 安装

**1. 下载代码**：点右上角绿色 **Code** 按钮 → **Download ZIP** → 解压到任意文件夹

**2. 加载到 Chrome**：
1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启**开发者模式**
3. 点**加载已解压的扩展程序**
4. 选择刚才解压的文件夹（选根目录，不是 `api` 子目录）

**3. 配置 API Key**：点 Chrome 右上角的扩展图标 → 找到「伴读讲讲」→ 填入 DeepSeek API Key

获取 DeepSeek API Key：注册 [platform.deepseek.com](https://platform.deepseek.com/api_keys)，充值约 10 元可使用很久

**4. 开始使用**：打开 [微信读书网页版](https://weread.qq.com)，划选任意文字，点「讲讲」

### 可选配置

| Key | 用途 | 获取地址 |
|-----|------|---------|
| SiliconFlow API Key | 高精度中文语音识别（不填则使用浏览器内置） | [cloud.siliconflow.cn](https://cloud.siliconflow.cn/account/ak) |
| 微信读书 Skill Key | 获取用户划线、热门标注等增强上下文 | [weread.qq.com/r/weread-skills](https://weread.qq.com/r/weread-skills) |

</details>

---

## 反馈

有问题或建议，欢迎提 [Issue](https://github.com/DiegoXue-coder/BanduJiangJiang/issues)。
