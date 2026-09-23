from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from collections import Counter
from pathlib import Path
from unittest import mock


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_eval  # noqa: E402
import score_eval  # noqa: E402


class DatasetTests(unittest.TestCase):
    def test_dataset_is_balanced_and_fixed_size(self) -> None:
        cases = run_eval.load_cases(HERE / "cases.jsonl")
        self.assertEqual(42, len(cases))
        self.assertEqual({category: 7 for category in run_eval.ALLOWED_CATEGORIES}, Counter(c["category"] for c in cases))

    def test_dataset_has_reviewable_short_sources(self) -> None:
        cases = run_eval.load_cases(HERE / "cases.jsonl")
        for case in cases:
            self.assertIn(case["source_kind"], {"synthetic", "public_domain"})
            self.assertTrue(case["must_include"], case["id"])
            self.assertTrue(case["must_not_claim"], case["id"])
            self.assertLess(len(json.dumps(case["context"], ensure_ascii=False)), 2000, case["id"])

    def test_example_config_has_two_distinct_configs(self) -> None:
        config = run_eval.load_config(HERE / "configs.example.json")
        self.assertEqual(["baseline", "candidate"], [item["id"] for item in config["configs"]])
        self.assertNotIn("api_key", config["request"])
        self.assertEqual("AI_QUALITY_API_KEY", config["request"]["api_key_env"])


class RunnerTests(unittest.TestCase):
    def test_default_run_never_opens_network(self) -> None:
        args = Namespace(
            dataset=str(HERE / "cases.jsonl"),
            config=str(HERE / "configs.example.json"),
            execute=False,
            output=None,
        )
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network called")) as urlopen:
            self.assertEqual(0, run_eval.run(args))
        urlopen.assert_not_called()

    def test_execute_rejects_placeholder_endpoint_before_key_lookup(self) -> None:
        args = Namespace(
            dataset=str(HERE / "cases.jsonl"),
            config=str(HERE / "configs.example.json"),
            execute=True,
            output=None,
        )
        with self.assertRaisesRegex(ValueError, "replace the example endpoint"):
            run_eval.run(args)


class ScoreTests(unittest.TestCase):
    def test_make_scorecard_has_one_row_per_case_and_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "scorecard.csv"
            score_eval.make_scorecard(HERE / "cases.jsonl", HERE / "configs.example.json", output, None)
            with output.open(encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(84, len(rows))

    def test_summary_rejects_out_of_range_scores(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "scorecard.csv"
            score_eval.make_scorecard(HERE / "cases.jsonl", HERE / "configs.example.json", output, None)
            with output.open(encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))
            for row in rows:
                for metric in score_eval.METRICS:
                    row[metric] = "2"
            rows[0]["clarity"] = "3"
            with output.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=score_eval.FIELDNAMES)
                writer.writeheader()
                writer.writerows(rows)
            with self.assertRaisesRegex(ValueError, "clarity must be 0, 1, or 2"):
                score_eval.summarize(output)


if __name__ == "__main__":
    unittest.main()
