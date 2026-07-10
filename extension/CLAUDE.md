# 伴读讲讲 Chrome 扩展 — 历史项目上下文（已冻结，不再迭代）

> 这个文件夹里的东西是原始的"伴读讲讲"Chrome 扩展，2026-07 起已冻结开发，
> 保留但不再更新。新的手机端产品见项目根目录 `CLAUDE.md`。

## 项目定性

Chrome 扩展 + 本地 Python 后端，专为微信读书网页版（weread.qq.com）打造的 AI 语音伴读助手。

- 用户在微信读书划线 → 点"讲讲"按钮 → AI 解释 → TTS 朗读
- 支持语音提问（VAD 自动停顿检测 → SenseVoice 转文字 → DeepSeek 回答）

---

## 技术栈

| 层 | 技术 |
|----|------|
| 浏览器扩展 | Chrome MV3，content.js + popup + service-worker |
| 后端 | Python 3.13 + FastAPI（`../api/`，与手机端共用） |
| AI 对话 | DeepSeek Chat (`deepseek-chat`) |
| 语音合成 TTS | Microsoft Edge TTS (`edge_tts`) |
| 语音识别 STT | SiliconFlow SenseVoiceSmall（中文优化） |
| 音频转换 | PyAV（WebM → WAV，SenseVoice 不接受 WebM） |

---

## 微信读书官方 Skill API（2026-05-17 开放）

### 基本信息

- 官方页面：https://weread.qq.com/r/weread-skills
- 开源 SDK：https://github.com/Ceelog/OpenWeRead（TypeScript，MIT）
- 安装 SDK：`pnpm add openweread`
- API Key 格式：`wrk-xxxxxxxx`，在官方 Skills 管理页扫码获取
- 环境变量名：`WEREAD_API_KEY`

### 可用接口

| 接口路径 | 功能 | 关键返回字段 |
|---------|------|------------|
| `/shelf/sync` | 书架同步 | `books[]`（含 `bookId`、`readUpdateTime`） |
| `/book/info` | 书籍详情 | `title`、`author`、`intro` |
| `/book/chapterinfo` | 章节目录 | `chapters[]`（`chapterUid`、`title`） |
| `/book/getprogress` | 阅读进度 | `chapterUid`（当前章节） |
| `/book/bookmarklist` | 用户划线和笔记 | `updated[]`（`markText`、`createTime`） |
| `/book/bestbookmarks` | 热门划线 | `items[]`（`markText`、`totalCount`） |
| `/book/underlines` | 划线列表 | 同上 |
| `/user/notebooks` | 有笔记的书籍 | 书籍列表 + 笔记条数 |
| `/readdata/detail` | 阅读统计 | 时长、天数 |
| `/store/search` | 书城搜索 | 书籍列表 |
| `/book/recommend` | 个性化推荐 | 书籍列表 |
| `/book/similar` | 相似书籍 | 书籍列表 |
| `/review/list/mine` | 我的书评 | 评论列表 |

### SDK 基本用法（TypeScript）

```typescript
import { OpenWeRead } from "openweread";
const weread = new OpenWeRead({ apiKey: process.env.WEREAD_API_KEY! });

// 并发拉取书本完整上下文
const [bookInfo, chapters, progress, myMarks, hotMarks] = await Promise.allSettled([
  weread.book.getInfo({ bookId }),
  weread.book.getChapterInfo({ bookId }),
  weread.book.getProgress({ bookId }),
  weread.book.getBookmarkList({ bookId }),
  weread.book.getBestBookmarks({ bookId }),
]);
```

---

## 当前架构痛点与 API 接入方案（历史记录，未必再推进）

### 现有痛点

1. **DOM 选择器脆弱**：`content.js` 靠 `.readerTopBar_title_link`、`.readerChapterContent` 等类名抓书名/章节/正文，微信读书改版即废
2. **剪贴板 hack**：划词后点 `wr_copy` 按钮 → 等 150ms → 读剪贴板，不稳定且污染用户剪贴板
3. **上下文极度有限**：只能看当前页 DOM，截断到 2000 字
4. **对用户偏好一无所知**：不知道用户已经划了哪些线、关注什么

### 接入后改善

| 痛点 | 改善方式 |
|------|---------|
| 书名/章节获取 | URL 提取 `bookId` → `/book/info` + `/book/chapterinfo`（不依赖 DOM） |
| 正文上下文 | 用 `/book/getprogress` 知道当前章节，配合章节目录给 AI 更完整的书本结构 |
| 用户偏好 | `/book/bookmarklist` 拿用户自己的划线，作为 AI prompt 的偏好信号 |
| 热门难点 | `/book/bestbookmarks` 知道这本书其他读者觉得难的段落 |

### 接入架构设计

```
content.js
  → 从 URL 提取 bookId（正则：/web/reader/([A-Za-z0-9]+)）
  → 调后端 GET /context/:bookId

后端 /context/:bookId
  → 并发调 WeRead API（book/info + chapterinfo + getprogress + bookmarklist）
  → 组装结构化 BookContext 返回给扩展

后端 /ask
  → 接收问题 + 富上下文（含用户划线、当前章节、书籍信息）
  → 传给 DeepSeek 生成答案
```

### System Prompt 优化方向

获得 API 后，`SYSTEM_PROMPT` 可补充用户画像段：
```
用户在这本书中自己标注了以下内容（代表他的关注点）：
{userHighlights}

其他读者在这本书中最常标注的段落（代表全书难点）：
{popularHighlights}
```

---

## 文件结构

```
extension/
├── manifest.json          # Chrome 扩展声明（MV3）
├── content/
│   ├── content.js         # 核心：注入微信读书页面的脚本
│   └── content.css        # 面板和浮动按钮样式
├── background/
│   └── service-worker.js  # 后台保活，备用 CORS 转发
├── popup/
│   ├── popup.html         # 扩展图标弹窗
│   ├── popup.js
│   └── popup.css
├── icons/                 # 16/48/128px 图标
└── gen_icons.py           # 图标生成脚本
```

后端（`../api/`）与手机端新产品共用，不属于这个文件夹。

---

## 关键约束

- 后端地址在 `manifest.json` 的 `host_permissions` 里声明
- TTS 回答前必须过 `clean_for_tts()` 剥掉 Markdown 符号和 emoji
- 音频管道：浏览器录 WebM → 后端 PyAV 转 WAV 16kHz mono → SenseVoice → 文字
- AI 回答控制在 150 字内（System Prompt 约束），TTS 朗读时间合理
- `Promise.allSettled`（不用 `Promise.all`）调 WeRead API，单个接口失败不影响整体
