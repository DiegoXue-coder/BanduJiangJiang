"""Stop hook for Claude Code: reads token usage from transcript and outputs summary."""
import json
import sys
from datetime import datetime
from pathlib import Path

PRICING = {
    "claude-opus-4-7":   {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50},
    "claude-sonnet-4-6": {"input": 3.00,  "output": 15.00, "cache_write": 3.75,  "cache_read": 0.30},
    "claude-haiku-4-5":  {"input": 0.80,  "output": 4.00,  "cache_write": 1.00,  "cache_read": 0.08},
}
DEFAULT_MODEL = "claude-sonnet-4-6"
CNY_RATE = 7.25
LOG_FILE = Path(__file__).parent / "token_usage.jsonl"


def parse_transcript(transcript_path: str) -> tuple[dict, str]:
    """Sum token usage from transcript, deduplicated by message ID."""
    p = Path(transcript_path)
    if not p.exists():
        return {}, DEFAULT_MODEL

    seen_ids = set()
    totals = {"input_tokens": 0, "output_tokens": 0,
              "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    model = DEFAULT_MODEL

    with open(p, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
            except Exception:
                continue
            if entry.get("type") != "assistant":
                continue
            msg = entry.get("message", {})
            msg_id = msg.get("id")
            if not msg_id or msg_id in seen_ids:
                continue
            seen_ids.add(msg_id)
            usage = msg.get("usage", {})
            totals["input_tokens"] += usage.get("input_tokens", 0)
            totals["output_tokens"] += usage.get("output_tokens", 0)
            totals["cache_creation_input_tokens"] += usage.get("cache_creation_input_tokens", 0)
            totals["cache_read_input_tokens"] += usage.get("cache_read_input_tokens", 0)
            if msg.get("model"):
                model = msg["model"]

    return totals, model


def calc_cost(usage: dict, model: str) -> dict:
    prices = PRICING.get(model, PRICING[DEFAULT_MODEL])
    input_cost = usage["input_tokens"] / 1_000_000 * prices["input"]
    output_cost = usage["output_tokens"] / 1_000_000 * prices["output"]
    cache_write_cost = usage["cache_creation_input_tokens"] / 1_000_000 * prices["cache_write"]
    cache_read_cost = usage["cache_read_input_tokens"] / 1_000_000 * prices["cache_read"]
    total_usd = input_cost + output_cost + cache_write_cost + cache_read_cost
    return {
        "model": model,
        **usage,
        "total_cost_usd": round(total_usd, 6),
        "total_cost_cny": round(total_usd * CNY_RATE, 5),
        "timestamp": datetime.now().isoformat(),
    }


def log_usage(record: dict):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def format_msg(record: dict) -> str:
    lines = [
        f"模型：{record['model']}",
        f"输入：{record['input_tokens']:,} tokens",
        f"输出：{record['output_tokens']:,} tokens",
    ]
    if record["cache_read_input_tokens"]:
        lines.append(f"缓存命中：{record['cache_read_input_tokens']:,} tokens（已减费）")
    if record["cache_creation_input_tokens"]:
        lines.append(f"缓存写入：{record['cache_creation_input_tokens']:,} tokens")
    lines.append(f"本次费用：¥{record['total_cost_cny']:.4f}（${record['total_cost_usd']:.6f}）")
    return "\n".join(lines)


def output(msg: str):
    sys.stdout.buffer.write((msg + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def main():
    hook_data = {}
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="ignore").strip()
        if raw:
            hook_data = json.loads(raw)
    except Exception:
        pass

    transcript_path = hook_data.get("transcript_path", "")
    if not transcript_path:
        output(json.dumps({"systemMessage": "[Token 统计] 未获取到会话记录路径"}, ensure_ascii=False))
        return

    usage, model = parse_transcript(transcript_path)
    if not any(usage.values()):
        output(json.dumps({"systemMessage": "[Token 统计] 本次会话无 token 记录"}, ensure_ascii=False))
        return

    record = calc_cost(usage, model)
    log_usage(record)
    output(json.dumps({"systemMessage": f"[Token 统计]\n{format_msg(record)}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
