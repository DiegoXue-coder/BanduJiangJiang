# ChatBook AI 回答质量 v1 评测基线

本目录对应任务卡 T0、T0.1、T0.2，只提供固定题集、可重复运行器和人工评分工具，不会改变生产问答行为。

## 目录

- `cases.jsonl`：49 道固定题，七类各 7 道（2026-09-24 新增 `external_fact` 一类，专测 AI 质量第二阶段的外部联网查证）。
- `configs.example.json`：直连模型与 ChatBook 生产接口配置示例，不含密钥。
- `run_eval.py`：默认 dry-run 的双 adapter 流式运行器。
- `score_eval.py`：生成评分表、校验人工评分并汇总。
- `scorecard_template.csv`：可查看或手工复制的空表头。
- `summary_template.md`：允许提交的去敏摘要模板。
- `results/`：本地原始结果和评分；除 `.gitkeep` 外全部被忽略。

旧目录 `api/eval/` 是面向苏格拉底提示词的历史在线评测，不属于本基线，也不应替代这里的 dry-run 流程。

## 题集格式

`cases.jsonl` 每行一个 JSON 对象，关键字段如下：

| 字段 | 含义 |
|---|---|
| `id` / `category` / `title` | 稳定标识、七类之一、可读标题 |
| `question` | 固定问题 |
| `context` | 当前正文、划线、跨章检索片段和会话记忆 |
| `expected_evidence_types` | 期望使用的依据类型，可多选 |
| `must_include` | 人工评分时必须覆盖的事实或边界 |
| `must_not_claim` | 不得编造或过度推断的内容 |
| `human_scoring_notes` | 本题评分提示，不作为模型输入 |
| `risk_level` / `source_kind` | 风险等级、`synthetic` 或 `public_domain` 来源 |

当前六种证据类型是 `current_context`、`user_selection`、`conversation_memory`、`general_knowledge`、`insufficient_context`、`external_fact`。`conversation_memory` 是未来能力的评测标识；当前候选若不支持，应如实暴露缺口，不要为了过题把记忆伪装成正文。`external_fact` 对应 2026-09-24 上线的外部查证功能（千问 DashScope 接口），只表示"这次用了外部查证来源"，不表示答案已经被核实——语义边界跟其它证据类型一致，见 `docs/项目管理/14-方案讨论-外部资源联网查证.md`。

### `external_fact` 这一类题的特殊之处

跟其它六类不同，`external_fact` 依赖联网查证服务本身的可用性/搜索结果质量，同一道题**不保证每次运行都得到相同结果**（搜索结果本身就有波动，这是2026-09-24真机复测反复验证过的真实现象，不是评测代码的问题）。评分时不要因为某次跑出"没查到、诚实说依据不足"就直接扣分——这题的 `expected_evidence_types` 通常同时列出 `external_fact` 和 `insufficient_context`/`general_knowledge` 两种，只要回答诚实、没有编造，两种结果都算合格；真正该扣分的是编造内容、或者对现实世界问题避而不答却又不说明原因。

## 两种 adapter

`direct_model` 是模型实验器：它直接调用 OpenAI-compatible `/chat/completions`，使用配置中的实验提示词，可比较模型或提示词候选，但不会经过 ChatBook 的 `_build_book_context`、正式 `SYSTEM_PROMPT`、采样参数和流式完成逻辑。

`chatbook_api` 是生产链路验收器：它把每题映射成真实 `AskRequest`，调用 ChatBook `/ask/stream`，经过后端鉴权、上下文拼装、正式提示词和流式完成事件。结果除回答外还保存：

- 实际发送的 `pageText`、`selection`、history 等长度/数量元数据。
- 后端完成事件中的 `evidenceType` 或 `availableEvidenceType`。
- 后端未来增加的其他完成事件元数据。

跨章节 `retrieved_excerpts` 不会伪装成 `userHighlights` 或塞进 `pageText`。当前生产接口没有书籍 RAG 输入，因此运行结果会在 `request_metadata.omitted_retrieved_excerpts` 明确记录遗漏数量；相应跨章题失败是能力缺口，不应通过篡改请求来掩盖。

## 默认 dry-run

在仓库根目录执行：

```powershell
python api/evals/ai_quality/run_eval.py
```

它只会：

1. 校验数据和配置结构。
2. 输出数据集 SHA-256、分类数量和计划请求数。
3. 明确打印 `DRY-RUN`。

它不会读取密钥、创建结果文件或访问网络。可用 `--dataset` 和 `--config` 指向冻结副本或本地配置；用可重复的 `--target <config-id>` 只选择某个 adapter。

## 显式真实运行（本次任务禁止执行）

需要先复制配置示例到 Git 忽略范围外或本地私有位置。所有密钥和令牌只从配置指向的环境变量读取。

直连模型示例：

```powershell
$env:AI_QUALITY_API_KEY = '<local-secret>'
python api/evals/ai_quality/run_eval.py --config C:\private\ai-quality.json --target direct_baseline --execute
```

ChatBook 生产链路示例：

```powershell
$env:CHATBOOK_EXTENSION_TOKEN = '<x-extension-token>'
$env:CHATBOOK_AUTH_TOKEN = '<optional-user-jwt>'
$env:CHATBOOK_DEEPSEEK_KEY = '<optional-user-deepseek-key>'
python api/evals/ai_quality/run_eval.py --config C:\private\ai-quality.json --target chatbook_production --execute
```

`CHATBOOK_EXTENSION_TOKEN` 必填；用户 JWT 与自带 DeepSeek Key 可选。若不提供自带 Key，是否产生服务器侧模型费用由部署环境决定，所以任何真实运行仍须单独批准。

只有显式 `--execute` 才会发请求。运行器逐题逐配置保存 adapter、模型/服务器配置、参数、首字延迟、总耗时、token usage（若有）、估算成本（若有）、原始回答、证据/上下文元数据和错误。任何密钥都不会进入结果。

如果供应商不返回流式 usage，token 和成本保持空值，不能猜测补齐。成本数值沿用本地配置填写的计费币种，摘要中应注明币种。

## 人工评分

从一次运行结果生成评分表。示例配置包含两个 direct target 和一个 ChatBook target，全量为 147 行；单独运行一个 target 为 49 行：

```powershell
python api/evals/ai_quality/score_eval.py make `
  --results api/evals/ai_quality/results/run-YYYYMMDD-HHMMSS.jsonl `
  --output api/evals/ai_quality/results/scorecard.csv
```

也可不传 `--results`，先建立空白评分表。七项均只允许 `0/1/2`：

| 指标 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| `grounding_accuracy` | 主要依据错误或伪造 | 部分有据但混入无据内容 | 依据准确且边界清楚 |
| `factual_correctness` | 关键事实错误 | 次要错误或遗漏 | 关键事实正确 |
| `honest_uncertainty` | 把未知说成确定 | 有保留但边界含糊 | 明确说明未知、推断和限制 |
| `answer_depth` | 未回答核心问题 | 回答核心但解释浅 | 有充分且相关的解释/比较 |
| `clarity` | 难懂、矛盾或严重跑题 | 基本可懂但组织一般 | 简洁、连贯、直接 |
| `evidence_labeling` | 混淆原文、记忆和常识 | 有区分但不稳定 | 清楚标明依据类型 |
| `citation_validity` | 引用和答案对不上、或链接是编的 | 有引用但没真正支撑关键结论 | 引用确实支撑了给出的结论 |

`citation_validity` 只在题目实际用到了外部查证来源时才有意义；非 `external_fact` 类题目（没有联网查证）这项按不适用处理，评分者可以直接给 2 分或在 `reviewer_notes` 里注明"无需引用"，不强行扣分。

评分者应同时查看该题的 `must_include`、`must_not_claim` 和 `human_scoring_notes`。`score_total` 可留空，汇总工具会按七项直接计算，避免手填加总错误。

```powershell
python api/evals/ai_quality/score_eval.py summarize `
  --scorecard api/evals/ai_quality/results/scorecard.csv `
  --output api/evals/ai_quality/results/summary.json
```

汇总给出各配置七维均分、14 分制总均分、分类均分、延迟与成本。原始结果和逐题评分不得提交；对外只按 `summary_template.md` 去敏整理。没有完成同题对照和人工复核前，不得宣称候选质量提升。

## 离线验证

```powershell
python -m unittest discover -s api/evals/ai_quality -p "test_*.py" -v
```

测试会固定题目数量/分类、必要字段、短语料约束、配置结构、默认不读取密钥且不联网、AskRequest 映射、分片 SSE 完成事件解析及评分范围。
