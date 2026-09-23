#!/usr/bin/env python3
"""ChatBook AI quality evaluation runner; dry-run is the default."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_DATASET = ROOT / "cases.jsonl"
DEFAULT_CONFIG = ROOT / "configs.example.json"
DEFAULT_RESULTS = ROOT / "results"
REQUIRED_CASE_FIELDS = {
    "id",
    "category",
    "title",
    "question",
    "context",
    "expected_evidence_types",
    "must_include",
    "must_not_claim",
    "human_scoring_notes",
    "risk_level",
    "source_kind",
}
ALLOWED_CATEGORIES = {
    "current_context",
    "cross_chapter",
    "insufficient_context",
    "conversation_memory",
    "high_risk",
    "literary_open",
}
ALLOWED_EVIDENCE_TYPES = {
    "current_context",
    "user_selection",
    "conversation_memory",
    "general_knowledge",
    "insufficient_context",
}


def load_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            case = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
        missing = REQUIRED_CASE_FIELDS - set(case)
        if missing:
            raise ValueError(f"{case.get('id', line_number)} missing fields: {sorted(missing)}")
        if case["category"] not in ALLOWED_CATEGORIES:
            raise ValueError(f"{case['id']} has unknown category {case['category']}")
        unknown = set(case["expected_evidence_types"]) - ALLOWED_EVIDENCE_TYPES
        if unknown:
            raise ValueError(f"{case['id']} has unknown evidence types: {sorted(unknown)}")
        cases.append(case)
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("dataset contains duplicate case ids")
    return cases


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schema_version") != 1:
        raise ValueError("config schema_version must be 1")
    request = config.get("request", {})
    if request.get("provider") != "openai_compatible":
        raise ValueError("only provider=openai_compatible is supported")
    configs = config.get("configs", [])
    if len(configs) < 2:
        raise ValueError("at least baseline and candidate configs are required")
    ids = [item.get("id") for item in configs]
    if any(not item for item in ids) or len(ids) != len(set(ids)):
        raise ValueError("config ids must be present and unique")
    for item in configs:
        for field in ("model", "temperature", "max_tokens", "system_prompt"):
            if field not in item:
                raise ValueError(f"config {item['id']} missing {field}")
    return config


def dataset_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_user_message(case: dict[str, Any]) -> str:
    return (
        "请回答阅读问题。只可把下列 JSON 中实际出现的内容当作书中依据或用户记忆；"
        "需要一般知识时请明确区分，材料不足时请直接说明。\n"
        + json.dumps(
            {"question": case["question"], "context": case["context"]},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def _estimate_cost(config: dict[str, Any], usage: dict[str, Any]) -> float | None:
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    if not isinstance(prompt_tokens, int) or not isinstance(completion_tokens, int):
        return None
    return round(
        prompt_tokens * float(config.get("input_cost_per_million", 0)) / 1_000_000
        + completion_tokens * float(config.get("output_cost_per_million", 0)) / 1_000_000,
        8,
    )


def call_openai_compatible(
    request_config: dict[str, Any], model_config: dict[str, Any], case: dict[str, Any], api_key: str
) -> dict[str, Any]:
    body = {
        "model": model_config["model"],
        "temperature": model_config["temperature"],
        "max_tokens": model_config["max_tokens"],
        "stream": True,
        "stream_options": {"include_usage": True},
        "messages": [
            {"role": "system", "content": model_config["system_prompt"]},
            {"role": "user", "content": build_user_message(case)},
        ],
    }
    req = urllib.request.Request(
        request_config["endpoint"],
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    first_token_ms: int | None = None
    chunks: list[str] = []
    usage: dict[str, Any] = {}
    with urllib.request.urlopen(req, timeout=float(request_config["timeout_seconds"])) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            event = json.loads(payload)
            usage = event.get("usage") or usage
            choices = event.get("choices") or []
            content = choices[0].get("delta", {}).get("content") if choices else None
            if content:
                if first_token_ms is None:
                    first_token_ms = round((time.perf_counter() - started) * 1000)
                chunks.append(content)
    total_ms = round((time.perf_counter() - started) * 1000)
    return {
        "answer": "".join(chunks),
        "ttft_ms": first_token_ms,
        "total_latency_ms": total_ms,
        "usage": usage,
        "estimated_cost": _estimate_cost(model_config, usage),
    }


def result_path(output_dir: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return output_dir / f"run-{stamp}.jsonl"


def run(args: argparse.Namespace) -> int:
    dataset = Path(args.dataset).resolve()
    config_path = Path(args.config).resolve()
    cases = load_cases(dataset)
    config = load_config(config_path)
    configs = config["configs"]
    counts = {category: 0 for category in sorted(ALLOWED_CATEGORIES)}
    for case in cases:
        counts[case["category"]] += 1
    print(f"dataset: {dataset}")
    print(f"sha256: {dataset_digest(dataset)}")
    print(f"cases: {len(cases)}; configs: {', '.join(item['id'] for item in configs)}")
    print("categories: " + ", ".join(f"{key}={value}" for key, value in counts.items()))
    print(f"planned requests: {len(cases) * len(configs)}")
    if not args.execute:
        print("DRY-RUN: validation passed; no network request was made.")
        return 0

    request_config = config["request"]
    if ".invalid" in request_config["endpoint"]:
        raise ValueError("replace the example endpoint before --execute")
    env_name = request_config.get("api_key_env", "AI_QUALITY_API_KEY")
    api_key = os.environ.get(env_name, "")
    if not api_key:
        raise ValueError(f"missing API key environment variable: {env_name}")
    output = Path(args.output).resolve() if args.output else result_path(DEFAULT_RESULTS)
    output.parent.mkdir(parents=True, exist_ok=True)
    run_id = output.stem
    with output.open("x", encoding="utf-8") as handle:
        for case in cases:
            for model_config in configs:
                record: dict[str, Any] = {
                    "schema_version": 1,
                    "run_id": run_id,
                    "dataset_sha256": dataset_digest(dataset),
                    "case_id": case["id"],
                    "category": case["category"],
                    "config_id": model_config["id"],
                    "model": model_config["model"],
                    "parameters": {
                        "temperature": model_config["temperature"],
                        "max_tokens": model_config["max_tokens"],
                    },
                    "answer": None,
                    "ttft_ms": None,
                    "total_latency_ms": None,
                    "usage": {},
                    "estimated_cost": None,
                    "error": None,
                }
                try:
                    record.update(call_openai_compatible(request_config, model_config, case, api_key))
                except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                    record["error"] = f"{type(exc).__name__}: {exc}"
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
                status = "ok" if record["error"] is None else "error"
                print(f"[{status}] {case['id']} / {model_config['id']}")
    print(f"results: {output}")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--execute", action="store_true", help="explicitly enable paid network requests")
    parser.add_argument("--output", help="result JSONL path; must not already exist")
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
