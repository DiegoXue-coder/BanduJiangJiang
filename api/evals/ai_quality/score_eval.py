#!/usr/bin/env python3
"""Create and validate the manual scorecard for an AI quality eval run."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from run_eval import DEFAULT_CONFIG, DEFAULT_DATASET, load_cases, load_config


METRICS = (
    "grounding_accuracy",
    "factual_correctness",
    "honest_uncertainty",
    "answer_depth",
    "clarity",
    "evidence_labeling",
    # AI质量第二阶段新增：专门看"引用是不是真的支撑了给出的结论"，不是随便
    # 贴几个链接充数——0分=引用和答案对不上或者链接是编的，1分=有引用但没
    # 真正支撑关键结论，2分=引用确实支撑了结论。非外部查证题（没有来源）
    # 这项按不适用处理，评分时可以直接给2分或在reviewer_notes里注明"无需引用"，
    # 不强行扣分。
    "citation_validity",
)
FIELDNAMES = (
    "case_id",
    "category",
    "config_id",
    "adapter",
    "evidence_type",
    *METRICS,
    "score_total",
    "ttft_ms",
    "total_latency_ms",
    "input_tokens",
    "output_tokens",
    "estimated_cost",
    "error",
    "reviewer_notes",
)


def load_results(path: Path | None) -> dict[tuple[str, str], dict[str, Any]]:
    if path is None:
        return {}
    records: dict[tuple[str, str], dict[str, Any]] = {}
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        record = json.loads(raw)
        key = (record["case_id"], record["config_id"])
        if key in records:
            raise ValueError(f"duplicate result at line {line_number}: {key}")
        records[key] = record
    return records


def make_scorecard(dataset: Path, config_path: Path, output: Path, results_path: Path | None) -> None:
    cases = load_cases(dataset)
    config = load_config(config_path)
    results = load_results(results_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        for case in cases:
            for model_config in config["configs"]:
                result = results.get((case["id"], model_config["id"]), {})
                usage = result.get("usage") or {}
                writer.writerow(
                    {
                        "case_id": case["id"],
                        "category": case["category"],
                        "config_id": model_config["id"],
                        "adapter": result.get("adapter", model_config.get("adapter", "direct_model")),
                        "evidence_type": result.get("evidence_type", ""),
                        "ttft_ms": result.get("ttft_ms", ""),
                        "total_latency_ms": result.get("total_latency_ms", ""),
                        "input_tokens": usage.get("prompt_tokens", ""),
                        "output_tokens": usage.get("completion_tokens", ""),
                        "estimated_cost": result.get("estimated_cost", ""),
                        "error": result.get("error", ""),
                    }
                )


def _optional_number(value: str) -> float | None:
    return float(value) if value.strip() else None


def summarize(scorecard: Path) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with scorecard.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing_columns = set(FIELDNAMES) - set(reader.fieldnames or [])
        if missing_columns:
            raise ValueError(f"scorecard missing columns: {sorted(missing_columns)}")
        for row_number, row in enumerate(reader, 2):
            scores: dict[str, int] = {}
            for metric in METRICS:
                try:
                    score = int(row[metric])
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"row {row_number}: {metric} must be 0, 1, or 2") from exc
                if score not in (0, 1, 2):
                    raise ValueError(f"row {row_number}: {metric} must be 0, 1, or 2")
                scores[metric] = score
            groups[row["config_id"]].append(
                {
                    "category": row["category"],
                    "scores": scores,
                    "total": sum(scores.values()),
                    "ttft_ms": _optional_number(row["ttft_ms"]),
                    "total_latency_ms": _optional_number(row["total_latency_ms"]),
                    "estimated_cost": _optional_number(row["estimated_cost"]),
                }
            )

    summary: dict[str, Any] = {"schema_version": 1, "warning": "Scores are human judgments; this summary alone does not prove improvement.", "configs": {}}
    for config_id, rows in sorted(groups.items()):
        by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            by_category[row["category"]].append(row)
        config_summary: dict[str, Any] = {
            "cases_scored": len(rows),
            "mean_total_out_of_14": round(statistics.fmean(row["total"] for row in rows), 3),
            "metrics_mean_out_of_2": {
                metric: round(statistics.fmean(row["scores"][metric] for row in rows), 3)
                for metric in METRICS
            },
            "categories": {
                category: {
                    "cases_scored": len(category_rows),
                    "mean_total_out_of_14": round(statistics.fmean(row["total"] for row in category_rows), 3),
                }
                for category, category_rows in sorted(by_category.items())
            },
        }
        for field in ("ttft_ms", "total_latency_ms"):
            values = [row[field] for row in rows if row[field] is not None]
            config_summary[f"mean_{field}"] = round(statistics.fmean(values), 3) if values else None
        costs = [row["estimated_cost"] for row in rows if row["estimated_cost"] is not None]
        config_summary["estimated_cost_total"] = round(sum(costs), 8) if costs else None
        summary["configs"][config_id] = config_summary
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    make = subparsers.add_parser("make", help="create a blank scorecard, optionally populated with run metadata")
    make.add_argument("--dataset", default=str(DEFAULT_DATASET))
    make.add_argument("--config", default=str(DEFAULT_CONFIG))
    make.add_argument("--results")
    make.add_argument("--output", required=True)
    report = subparsers.add_parser("summarize", help="validate a completed scorecard and print JSON summary")
    report.add_argument("--scorecard", required=True)
    report.add_argument("--output")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "make":
        make_scorecard(
            Path(args.dataset).resolve(),
            Path(args.config).resolve(),
            Path(args.output).resolve(),
            Path(args.results).resolve() if args.results else None,
        )
        print(f"scorecard: {Path(args.output).resolve()}")
        return 0
    summary = summarize(Path(args.scorecard).resolve())
    payload = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.output:
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload + "\n", encoding="utf-8")
        print(f"summary: {output}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
