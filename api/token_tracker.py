"""
会话 Token 用量 + 费用估算工具
用法：python token_tracker.py <文本文件或直接传字符串>
"""

import sys
import json
import re
from pathlib import Path
from datetime import datetime

# 各模型价格表（美元 / 1M tokens，2025-05 行情）
PRICING = {
    "claude-opus-4-7":     {"input": 15.00, "output": 75.00},
    "claude-sonnet-4-6":   {"input": 3.00,  "output": 15.00},
    "claude-haiku-4-5":    {"input": 0.80,  "output": 4.00},
    "deepseek-chat":       {"input": 0.27,  "output": 1.10},
    "deepseek-coder":      {"input": 0.27,  "output": 1.10},
    "gpt-4o":              {"input": 2.50,  "output": 10.00},
    "gpt-4o-mini":         {"input": 0.15,  "output": 0.60},
    "qwen-plus":           {"input": 0.40,  "output": 1.20},
    "qwen-max":            {"input": 2.40,  "output": 9.60},
}

LOG_FILE = Path(__file__).parent / "token_usage.jsonl"


def estimate_tokens(text: str) -> int:
    """粗略估算：中文 1 字≈1 token，英文 4 字符≈1 token"""
    chinese = len(re.findall(r'[一-鿿]', text))
    english_chars = len(re.sub(r'[一-鿿\s]', '', text))
    return chinese + max(1, english_chars // 4)


def calc_cost(input_tokens: int, output_tokens: int, model: str) -> dict:
    prices = PRICING.get(model, {"input": 3.00, "output": 15.00})
    input_cost  = input_tokens  / 1_000_000 * prices["input"]
    output_cost = output_tokens / 1_000_000 * prices["output"]
    return {
        "model": model,
        "input_tokens":  input_tokens,
        "output_tokens": output_tokens,
        "total_tokens":  input_tokens + output_tokens,
        "input_cost_usd":  round(input_cost,  6),
        "output_cost_usd": round(output_cost, 6),
        "total_cost_usd":  round(input_cost + output_cost, 6),
        "total_cost_cny":  round((input_cost + output_cost) * 7.25, 5),
        "timestamp": datetime.now().isoformat(),
    }


def log_usage(record: dict):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def summary():
    """汇总历史用量"""
    if not LOG_FILE.exists():
        print("暂无历史记录")
        return
    totals: dict[str, dict] = {}
    with open(LOG_FILE, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            m = r["model"]
            if m not in totals:
                totals[m] = {"input": 0, "output": 0, "cost_cny": 0.0}
            totals[m]["input"]    += r["input_tokens"]
            totals[m]["output"]   += r["output_tokens"]
            totals[m]["cost_cny"] += r["total_cost_cny"]
    print("\n=== Token 用量汇总 ===")
    for model, t in totals.items():
        print(f"  {model}: 输入 {t['input']:,} | 输出 {t['output']:,} | "
              f"合计费用 ¥{t['cost_cny']:.4f}")


def main():
    if len(sys.argv) < 2:
        summary()
        return

    cmd = sys.argv[1]
    if cmd == "summary":
        summary()
        return

    # 用法：python token_tracker.py <model> <input_tokens> <output_tokens>
    if len(sys.argv) == 4 and sys.argv[2].isdigit():
        model = cmd
        record = calc_cost(int(sys.argv[2]), int(sys.argv[3]), model)
        log_usage(record)
        print(f"[Token] {model} | "
              f"输入 {record['input_tokens']:,} | 输出 {record['output_tokens']:,} | "
              f"费用 ¥{record['total_cost_cny']:.5f}")
        return

    # 估算模式：python token_tracker.py deepseek-chat "用户输入文本"
    model = cmd
    text  = " ".join(sys.argv[2:])
    toks  = estimate_tokens(text)
    prices = PRICING.get(model, {"input": 3.00, "output": 15.00})
    cost_cny = toks / 1_000_000 * prices["input"] * 7.25
    print(f"[估算] '{text[:30]}...' ≈ {toks} tokens | "
          f"输入成本 ¥{cost_cny:.6f} ({model})")


if __name__ == "__main__":
    main()
