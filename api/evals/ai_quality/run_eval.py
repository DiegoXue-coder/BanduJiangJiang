#!/usr/bin/env python3
"""ChatBook AI quality evaluation runner; dry-run is the default."""

from __future__ import annotations

import argparse
import codecs
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Iterator


ROOT = Path(__file__).resolve().parent
DEFAULT_DATASET = ROOT / "cases.jsonl"
DEFAULT_CONFIG = ROOT / "configs.example.json"
DEFAULT_RESULTS = ROOT / "results"
REQUIRED_CASE_FIELDS = {
    "id", "category", "title", "question", "context", "expected_evidence_types",
    "must_include", "must_not_claim", "human_scoring_notes", "risk_level", "source_kind",
}
# AI质量第二阶段(外部查证)新增：external_fact 这一类专门测试联网查证场景
# （稳定事实/时效性/来源冲突/查不到要老实说/听书划线场景下问题仍在问现实
# 世界的事），题目和对应踩过的真实bug都记在 docs/项目管理/04-开发进度记录.md
# 续二十八至续三十。
ALLOWED_CATEGORIES = {
    "current_context", "cross_chapter", "insufficient_context",
    "conversation_memory", "high_risk", "literary_open", "external_fact",
}
ALLOWED_EVIDENCE_TYPES = {
    "current_context", "user_selection", "conversation_memory",
    "general_knowledge", "insufficient_context", "external_fact",
}
ALLOWED_ADAPTERS = {"direct_model", "chatbook_api"}


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


def _validate_request(adapter: str, request: dict[str, Any], config_id: str) -> None:
    if adapter == "direct_model":
        if request.get("provider") != "openai_compatible":
            raise ValueError(f"config {config_id}: direct_model requires provider=openai_compatible")
        required = ("endpoint", "api_key_env", "timeout_seconds")
    else:
        required = ("base_url", "path", "extension_token_env", "timeout_seconds")
        if not str(request.get("path", "")).endswith("/ask/stream"):
            raise ValueError(f"config {config_id}: chatbook_api path must end with /ask/stream")
    missing = [field for field in required if not request.get(field)]
    if missing:
        raise ValueError(f"config {config_id}: request missing {missing}")


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schema_version") not in (1, 2):
        raise ValueError("config schema_version must be 1 or 2")
    configs = config.get("configs", [])
    if len(configs) < 2:
        raise ValueError("at least two evaluation configs are required")
    ids = [item.get("id") for item in configs]
    if any(not item for item in ids) or len(ids) != len(set(ids)):
        raise ValueError("config ids must be present and unique")
    for item in configs:
        adapter = item.get("adapter", "direct_model")
        if adapter not in ALLOWED_ADAPTERS:
            raise ValueError(f"config {item['id']} has unknown adapter {adapter}")
        request = item.get("request") or config.get("request", {})
        _validate_request(adapter, request, item["id"])
        if adapter == "direct_model":
            for field in ("model", "temperature", "max_tokens", "system_prompt"):
                if field not in item:
                    raise ValueError(f"config {item['id']} missing {field}")
        elif item.get("style", "simple") not in ("simple", "socratic"):
            raise ValueError(f"config {item['id']}: unsupported ChatBook style")
    return config


def config_request(config: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    return target.get("request") or config.get("request", {})


def select_targets(config: dict[str, Any], requested: list[str] | None) -> list[dict[str, Any]]:
    targets = config["configs"]
    if not requested:
        return targets
    wanted = set(requested)
    selected = [target for target in targets if target["id"] in wanted]
    missing = wanted - {target["id"] for target in selected}
    if missing:
        raise ValueError(f"unknown target ids: {sorted(missing)}")
    return selected


def dataset_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_direct_user_message(case: dict[str, Any]) -> str:
    return (
        "请回答阅读问题。只可把下列 JSON 中实际出现的内容当作书中依据或用户记忆；"
        "需要一般知识时请明确区分，材料不足时请直接说明。\n"
        + json.dumps(
            {"question": case["question"], "context": case["context"]},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def build_chatbook_request(case: dict[str, Any], target: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Map one eval case to production AskRequest without inventing RAG input."""
    source = case["context"]
    history = [
        {"role": item.get("role"), "content": str(item.get("content", ""))}
        for item in source.get("memory", [])
        if item.get("role") in ("user", "assistant") and str(item.get("content", "")).strip()
    ]
    page_text = str(source.get("current_text", ""))
    selection = str(source.get("selection", ""))
    context = {
        "bookTitle": str(source.get("book_title", "")),
        "author": str(source.get("author", "")),
        "chapterTitle": str(source.get("chapter_title", "")),
        "pageText": page_text,
        "selection": selection,
        "positionId": str(source.get("position_id") or f"eval:{case['id']}"),
        "userHighlights": list(source.get("user_highlights", [])),
        "popularHighlights": list(source.get("popular_highlights", [])),
    }
    payload = {
        "context": context,
        "question": case["question"],
        "style": target.get("style", "simple"),
        "history": history,
    }
    retrieved = source.get("retrieved_excerpts", [])
    metadata = {
        "request_shape": "AskRequest",
        "style": payload["style"],
        "book_title_present": bool(context["bookTitle"]),
        "chapter_title_present": bool(context["chapterTitle"]),
        "position_id": context["positionId"],
        "page_text_chars": len(page_text),
        "selection_chars": len(selection),
        "history_turns": len(history),
        "user_highlights_count": len(context["userHighlights"]),
        "omitted_retrieved_excerpts": len(retrieved) if isinstance(retrieved, list) else 0,
        "expected_evidence_types": case["expected_evidence_types"],
    }
    return payload, metadata


def parse_sse_events(chunks: Iterable[bytes | str]) -> Iterator[dict[str, Any]]:
    """Parse fragmented UTF-8 SSE chunks and yield JSON objects from data events."""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buffer = ""
    data_lines: list[str] = []

    def pop_line(final: bool = False) -> str | None:
        nonlocal buffer
        indexes = [index for index in (buffer.find("\n"), buffer.find("\r")) if index >= 0]
        if not indexes:
            if final and buffer:
                line, buffer = buffer, ""
                return line
            return None
        index = min(indexes)
        if buffer[index] == "\r" and index == len(buffer) - 1 and not final:
            return None
        separator_length = 2 if buffer[index:index + 2] == "\r\n" else 1
        line = buffer[:index]
        buffer = buffer[index + separator_length:]
        return line

    def process_line(line: str) -> dict[str, Any] | None:
        nonlocal data_lines
        if line == "":
            if not data_lines:
                return None
            payload = "\n".join(data_lines)
            data_lines = []
            if payload == "[DONE]":
                return None
            return json.loads(payload)
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        return None

    for chunk in chunks:
        text = chunk if isinstance(chunk, str) else decoder.decode(chunk)
        buffer += text
        while True:
            line = pop_line()
            if line is None:
                break
            event = process_line(line)
            if event is not None:
                yield event
    buffer += decoder.decode(b"", final=True)
    while buffer:
        line = pop_line(final=True)
        if line is None:
            break
        event = process_line(line)
        if event is not None:
            yield event
    event = process_line("")
    if event is not None:
        yield event


def _estimate_cost(target: dict[str, Any], usage: dict[str, Any]) -> float | None:
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    if not isinstance(prompt_tokens, int) or not isinstance(completion_tokens, int):
        return None
    return round(
        prompt_tokens * float(target.get("input_cost_per_million", 0)) / 1_000_000
        + completion_tokens * float(target.get("output_cost_per_million", 0)) / 1_000_000,
        8,
    )


def call_direct_model(
    request_config: dict[str, Any], target: dict[str, Any], case: dict[str, Any], api_key: str
) -> dict[str, Any]:
    body = {
        "model": target["model"],
        "temperature": target["temperature"],
        "max_tokens": target["max_tokens"],
        "stream": True,
        "stream_options": {"include_usage": True},
        "messages": [
            {"role": "system", "content": target["system_prompt"]},
            {"role": "user", "content": build_direct_user_message(case)},
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
        for event in parse_sse_events(response):
            usage = event.get("usage") or usage
            choices = event.get("choices") or []
            content = choices[0].get("delta", {}).get("content") if choices else None
            if content:
                if first_token_ms is None:
                    first_token_ms = round((time.perf_counter() - started) * 1000)
                chunks.append(content)
    return {
        "answer": "".join(chunks),
        "ttft_ms": first_token_ms,
        "total_latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": usage,
        "estimated_cost": _estimate_cost(target, usage),
        "evidence_type": None,
        "backend_metadata": {},
        "request_metadata": {"request_shape": "openai_chat_completions"},
    }


def _optional_env(request_config: dict[str, Any], field: str) -> str:
    env_name = str(request_config.get(field, "")).strip()
    return os.environ.get(env_name, "").strip() if env_name else ""


def call_chatbook_api(
    request_config: dict[str, Any], target: dict[str, Any], case: dict[str, Any], extension_token: str
) -> dict[str, Any]:
    payload, request_metadata = build_chatbook_request(case, target)
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "x-extension-token": extension_token,
    }
    auth_token = _optional_env(request_config, "auth_token_env")
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    deepseek_key = _optional_env(request_config, "deepseek_key_env")
    if deepseek_key:
        headers["x-deepseek-key"] = deepseek_key
    url = request_config["base_url"].rstrip("/") + "/" + request_config["path"].lstrip("/")
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    started = time.perf_counter()
    first_token_ms: int | None = None
    deltas: list[str] = []
    final_answer: str | None = None
    done_metadata: dict[str, Any] = {}
    with urllib.request.urlopen(req, timeout=float(request_config["timeout_seconds"])) as response:
        for event in parse_sse_events(response):
            if event.get("error"):
                raise ValueError(f"ChatBook SSE error: {event['error']}")
            delta = event.get("delta")
            if isinstance(delta, str) and delta:
                if first_token_ms is None:
                    first_token_ms = round((time.perf_counter() - started) * 1000)
                deltas.append(delta)
            if event.get("done"):
                final_answer = str(event.get("answer", ""))
                done_metadata = {key: value for key, value in event.items() if key not in ("done", "answer")}
    if final_answer is None:
        raise ValueError("ChatBook SSE ended without a done event")
    evidence_type = done_metadata.get("availableEvidenceType") or done_metadata.get("evidenceType")
    return {
        "answer": final_answer or "".join(deltas),
        "ttft_ms": first_token_ms,
        "total_latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": {},
        "estimated_cost": None,
        "evidence_type": evidence_type,
        "backend_metadata": done_metadata,
        "request_metadata": request_metadata,
    }


def _execution_secret(request_config: dict[str, Any], adapter: str) -> str:
    field = "api_key_env" if adapter == "direct_model" else "extension_token_env"
    env_name = request_config[field]
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise ValueError(f"missing environment variable for {adapter}: {env_name}")
    return value


def _validate_execution_target(request_config: dict[str, Any], adapter: str, config_id: str) -> None:
    endpoint = request_config["endpoint"] if adapter == "direct_model" else request_config["base_url"]
    if ".invalid" in endpoint:
        raise ValueError(f"config {config_id}: replace the example endpoint before --execute")


def result_path(output_dir: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return output_dir / f"run-{stamp}.jsonl"


def run(args: argparse.Namespace) -> int:
    dataset = Path(args.dataset).resolve()
    config_path = Path(args.config).resolve()
    cases = load_cases(dataset)
    config = load_config(config_path)
    targets = select_targets(config, getattr(args, "target", None))
    counts = {category: 0 for category in sorted(ALLOWED_CATEGORIES)}
    for case in cases:
        counts[case["category"]] += 1
    labels = ", ".join(f"{item['id']}[{item.get('adapter', 'direct_model')}]" for item in targets)
    print(f"dataset: {dataset}")
    print(f"sha256: {dataset_digest(dataset)}")
    print(f"cases: {len(cases)}; targets: {labels}")
    print("categories: " + ", ".join(f"{key}={value}" for key, value in counts.items()))
    print(f"planned requests: {len(cases) * len(targets)}")
    if not args.execute:
        print("DRY-RUN: validation passed; no environment secret was read and no network request was made.")
        return 0

    secrets: dict[str, str] = {}
    for target in targets:
        adapter = target.get("adapter", "direct_model")
        request_config = config_request(config, target)
        _validate_execution_target(request_config, adapter, target["id"])
        secrets[target["id"]] = _execution_secret(request_config, adapter)

    output = Path(args.output).resolve() if args.output else result_path(DEFAULT_RESULTS)
    output.parent.mkdir(parents=True, exist_ok=True)
    run_id = output.stem
    digest = dataset_digest(dataset)
    with output.open("x", encoding="utf-8") as handle:
        for case in cases:
            for target in targets:
                adapter = target.get("adapter", "direct_model")
                record: dict[str, Any] = {
                    "schema_version": 2,
                    "run_id": run_id,
                    "dataset_sha256": digest,
                    "case_id": case["id"],
                    "category": case["category"],
                    "config_id": target["id"],
                    "adapter": adapter,
                    "model": target.get("model", "server-configured"),
                    "parameters": {
                        "temperature": target.get("temperature"),
                        "max_tokens": target.get("max_tokens"),
                        "style": target.get("style"),
                    },
                    "answer": None,
                    "ttft_ms": None,
                    "total_latency_ms": None,
                    "usage": {},
                    "estimated_cost": None,
                    "evidence_type": None,
                    "backend_metadata": {},
                    "request_metadata": {},
                    "error": None,
                }
                try:
                    request_config = config_request(config, target)
                    if adapter == "direct_model":
                        result = call_direct_model(request_config, target, case, secrets[target["id"]])
                    else:
                        result = call_chatbook_api(request_config, target, case, secrets[target["id"]])
                    record.update(result)
                except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
                    record["error"] = f"{type(exc).__name__}: {exc}"
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
                status = "ok" if record["error"] is None else "error"
                print(f"[{status}] {case['id']} / {target['id']}")
    print(f"results: {output}")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--target", action="append", help="run only this config id; may be repeated")
    parser.add_argument("--execute", action="store_true", help="explicitly enable real network requests")
    parser.add_argument("--output", help="result JSONL path; must not already exist")
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
