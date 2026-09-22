# EPUB 目录批量测试工具

任务卡：`docs/项目管理/10-待分配任务-EPUB目录测试与回归机制.md`
结果报告：`docs/学习笔记/11-EPUB目录测试报告-首批12本.md`

## 是什么

对一个本地目录里的所有 EPUB，并列跑三套结果，供人工对比、发现回归：

1. **原始结构**：spine 文档数、TOC 树（层级、分组节点数）。
2. **当前生产算法**：直接调用 `api.main._build_standard_reading_chapters`（只读，不连库）。
3. **实验性混合方案**（`hybrid_parser.py`）：TOC 定语义 + spine 保完整 + 最多两级分组，
   是 `docs/学习笔记/09-导入EPUB目录拆分方案.md` 推荐方向的一个可运行原型，**不是**生产代码，
   从未被 `api/main.py` 或客户端引用。

## 怎么用

```bash
# 装依赖：跟 api/requirements.txt 共用，仓库根目录下
pip install -r api/requirements.txt

python tools/epub_toc_audit/audit.py --books-dir "<本地 EPUB 文件夹的绝对路径>"
```

- `--books-dir`：必填，本地存放测试 EPUB 的文件夹。**不要**把这个路径写进任何会提交的文件。
- `--out`：可选，本地详情报告输出目录，默认 `tools/epub_toc_audit/_local/`（已在 `.gitignore` 里，
  这个目录下的内容——含逐章正文摘录的 JSON 和 HTML 对比报告——**永远不要**手动加进 git。
- `--summary-out`：可选，匿名汇总 JSON 的输出路径，默认 `tools/epub_toc_audit/summary.json`
  （这个文件**会被提交**——只含计数和结构统计，不含正文摘录、不含本机路径、不含书名以外的文件系统信息）。

跑完看两个东西：
- `tools/epub_toc_audit/_local/report.html`：本地网页报告，逐本书并排显示"当前算法 vs 混合方案"
  的章节列表、字数、自动标红，本地浏览器直接打开看。
- `tools/epub_toc_audit/summary.json`：机器可读汇总，可以直接 diff 出"这次改动前后哪些书的指标变了"，
  当长期回归基线用。

## 长期怎么维护（任务卡"十、长期运行方式"）

- 每发现一本新的问题书，丢进同一个本地测试文件夹，重新跑一次 `audit.py`，对比 `summary.json`
  前后差异——不需要另外写新工具。
- 以后改 `hybrid_parser.py` 或者哪天真要把这套逻辑搬进 `api/main.py`，先在全部历史样本上跑一遍，
  任何一本书从"以前没有 severe 标红"变成"现在有" = 回归，必须先解决再继续。
- 样本从 12 本长到 30/50/100 本，`--books-dir` 指向同一个（不断扩充的）本地文件夹即可，
  工具不用改。

## 数据安全边界（写代码、跑工具、看结果都要守住）

- 原始 EPUB 文件、`_local/` 目录下的任何东西（含逐章正文摘录、HTML 报告）**永远不进 git**。
- `summary.json` 只保留计数/结构统计和 `book_id`（文件内容的 sha256 前 10 位，不是文件名/路径）；
  书名取自 EPUB 自带的 Dublin Core 元数据或清洗过文件名里的盗版站点标签，**没有任何本机绝对路径**。
- 本工具只读文件、只在 `--out` 写结果；不连接生产数据库、不发 HTTP 请求、不调用任何发布/构建命令、
  不修改 `api/main.py`。
