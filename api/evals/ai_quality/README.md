# ChatBook AI 回答质量 v1 评测基线

本目录对应任务卡 T0、T0.1、T0.2，只提供固定题集、可重复运行器和人工评分工具，不会改变生产问答行为。

## 目录

- `cases.jsonl`：42 道固定题，六类各 7 道。
- `configs.example.json`：基线/候选配置示例，不含密钥。
- `run_eval.py`：默认 dry-run 的 OpenAI-compatible 流式运行器。
- `score_eval.py`：生成评分表、校验人工评分并汇总。
- `scorecard_template.csv`：可查看或手工复制的空表头。
- `summary_template.md`：允许提交的去敏摘要模板。
- `results/`：本地原始结果和评分；除 `.gitkeep` 外全部被忽略。

旧目录 `api/eval/` 是面向苏格拉底提示词的历史在线评测，不属于本基线，也不应替代这里的 dry-run 流程。

## 题集格式

`cases.jsonl` 每行一个 JSON 对象，关键字段如下：

| 字段 | 含义 |
|---|---|
| `id` / `category` / `title` | 稳定标识、六类之一、可读标题 |
| `question` | 固定问题 |
| `context` | 当前正文、划线、跨章检索片段和会话记忆 |
| `expected_evidence_types` | 期望使用的依据类型，可多选 |
| `must_include` | 人工评分时必须覆盖的事实或边界 |
| `must_not_claim` | 不得编造或过度推断的内容 |
| `human_scoring_notes` | 本题评分提示，不作为模型输入 |
| `risk_level` / `source_kind` | 风险等级、`synthetic` 或 `public_domain` 来源 |

当前五种证据类型是 `current_context`、`user_selection`、`conversation_memory`、`general_knowledge`、`insufficient_context`。`conversation_memory` 是未来能力的评测标识；当前候选若不支持，应如实暴露缺口，不要为了过题把记忆伪装成正文。

## 默认 dry-run

在仓库根目录执行：

```powershell
python api/evals/ai_quality/run_eval.py
```

它只会：

1. 校验数据和配置结构。
2. 输出数据集 SHA-256、分类数量和计划请求数。
3. 明确打印 `DRY-RUN`。

它不会读取密钥、创建结果文件或访问网络。可用 `--dataset` 和 `--config` 指向冻结副本或本地配置。

## 显式真实运行（本次任务禁止执行）

需要先复制配置示例到 Git 忽略范围外或本地私有位置，填写实际 endpoint、模型与单价。密钥只通过配置中 `api_key_env` 指定的环境变量提供：

```powershell
$env:AI_QUALITY_API_KEY = '<local-secret>'
python api/evals/ai_quality/run_eval.py --config C:\private\ai-quality.json --execute
```

只有显式 `--execute` 才会发请求。运行器使用流式响应，逐题逐配置保存：模型、temperature、max tokens、首字延迟、总耗时、token usage、估算成本、原始回答和错误。密钥不会进入请求结果。

如果供应商不返回流式 usage，token 和成本保持空值，不能猜测补齐。成本数值沿用本地配置填写的计费币种，摘要中应注明币种。

## 人工评分

从一次运行结果生成 84 行评分表：

```powershell
python api/evals/ai_quality/score_eval.py make `
  --results api/evals/ai_quality/results/run-YYYYMMDD-HHMMSS.jsonl `
  --output api/evals/ai_quality/results/scorecard.csv
```

也可不传 `--results`，先建立空白评分表。六项均只允许 `0/1/2`：

| 指标 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| `grounding_accuracy` | 主要依据错误或伪造 | 部分有据但混入无据内容 | 依据准确且边界清楚 |
| `factual_correctness` | 关键事实错误 | 次要错误或遗漏 | 关键事实正确 |
| `honest_uncertainty` | 把未知说成确定 | 有保留但边界含糊 | 明确说明未知、推断和限制 |
| `answer_depth` | 未回答核心问题 | 回答核心但解释浅 | 有充分且相关的解释/比较 |
| `clarity` | 难懂、矛盾或严重跑题 | 基本可懂但组织一般 | 简洁、连贯、直接 |
| `evidence_labeling` | 混淆原文、记忆和常识 | 有区分但不稳定 | 清楚标明依据类型 |

评分者应同时查看该题的 `must_include`、`must_not_claim` 和 `human_scoring_notes`。`score_total` 可留空，汇总工具会按六项直接计算，避免手填加总错误。

```powershell
python api/evals/ai_quality/score_eval.py summarize `
  --scorecard api/evals/ai_quality/results/scorecard.csv `
  --output api/evals/ai_quality/results/summary.json
```

汇总给出各配置六维均分、12 分制总均分、分类均分、延迟与成本。原始结果和逐题评分不得提交；对外只按 `summary_template.md` 去敏整理。没有完成同题对照和人工复核前，不得宣称候选质量提升。

## 离线验证

```powershell
python -m unittest discover -s api/evals/ai_quality -p "test_*.py" -v
```

测试会固定题目数量/分类、必要字段、短语料约束、配置结构、默认不联网及评分范围。
