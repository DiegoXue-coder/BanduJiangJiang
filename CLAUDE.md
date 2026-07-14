# 伴读讲讲 — 项目上下文

## 这个仓库现在有两个产品

1. **`extension/`** —— 原始的 Chrome 扩展（专为微信读书网页版打造的 AI 语音伴读助手）。**已冻结，不再迭代，但保留不删除。** 具体上下文见 `extension/CLAUDE.md`。
2. **`mobile/`** —— **正在积极开发的新产品**：从 Chrome 扩展转型的独立手机端 App，围绕"公版经典精读"定位，核心体验是"划线 → AI 苏格拉底式讲解 → 语音对话"，并为长期数据飞轮打地基。**这是当前的开发重心。**

两者共用同一个后端 `api/`（DeepSeek 对话、TTS、STT、PostgreSQL+pgvector）——后端只做"加"不做"改"：`extension/` 依赖的旧接口和旧表结构原样保留，手机端的新接口新表另外加，新接口统一加 `/app` 前缀区分。

---

## 手机端新产品的完整背景，看这里

架构决策、技术选型的推理过程、以及正式的项目管理文档，全部记录在：

- **`docs/学习笔记/`** —— 每个技术决策的推理过程（语音架构、跨平台框架、EPUB渲染、数据库Schema、后端API设计等），从 `00-技能清单.md` 开始看
- **`docs/项目管理/`** —— 正式的范围声明、WBS 任务分解、风险登记表

**在对手机端新产品做任何架构判断之前，先读这两个文件夹**，不要凭空假设或重新推导已经讨论过的决策。

**每次会话开始的固定动作**（SessionStart 钩子会自动 git pull，但读文档要自己做）：打开 `docs/项目管理/04-开发进度记录.md`，先读顶部"使用规则"和"开发经验法则"两个区，再看最新一条记录，确认上一次做到哪、留了什么问题，然后再动手。

---

## 手机端技术栈速览

| 层 | 技术 |
|----|------|
| 移动端框架 | React Native / Expo（`mobile/`，延续已有原型） |
| EPUB 渲染 | `@epubjs-react-native`（WebView + epub.js） |
| 后端 | Python 3.13 + FastAPI（`api/`，与扩展共用） |
| 数据库 | PostgreSQL + pgvector（Railway 托管） |
| AI 对话 | DeepSeek Chat（国内可访问，不用 Claude/GPT 等海外模型，避开中国大陆访问限制） |
| 语音合成/识别 | Microsoft Edge TTS / SiliconFlow SenseVoiceSmall |
| 内容来源 | 预置公版经典书库（不做用户自行导入任意 EPUB，DRM 限制详见学习笔记） |

---

## 文件结构

```
伴读讲讲/
├── CLAUDE.md               # 本文件
├── extension/               # 【已冻结】原 Chrome 扩展，详见 extension/CLAUDE.md
│   ├── manifest.json
│   ├── content/
│   ├── background/
│   ├── popup/
│   ├── icons/
│   └── gen_icons.py
├── mobile/                  # 【开发中】新的手机端 App（React Native / Expo）
├── api/                     # 共用后端（FastAPI），扩展和手机端都调用
│   ├── main.py
│   ├── requirements.txt
│   └── .env
├── docs/
│   ├── 学习笔记/             # 技术决策推理过程
│   ├── 项目管理/             # 范围声明 / WBS / 风险登记表
│   ├── index.html            # Chrome Web Store 隐私政策页（GitHub Pages 托管，勿改路径）
│   └── privacy.html
└── railway.toml
```

---

## 关键约束

- `Promise.allSettled`（不用 `Promise.all`）调外部 API，单个接口失败不影响整体
- AI 回答控制在合理字数内，TTS 朗读时间要合理
- 后端新增内容遵循"只加不改"原则，不破坏 `extension/` 现有依赖
