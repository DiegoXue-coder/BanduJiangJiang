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
        self.assertEqual(
            {category: 7 for category in run_eval.ALLOWED_CATEGORIES},
            Counter(case["category"] for case in cases),
        )

    def test_dataset_has_reviewable_short_sources(self) -> None:
        cases = run_eval.load_cases(HERE / "cases.jsonl")
        for case in cases:
            self.assertIn(case["source_kind"], {"synthetic", "public_domain"})
            self.assertTrue(case["must_include"], case["id"])
            self.assertTrue(case["must_not_claim"], case["id"])
            self.assertLess(len(json.dumps(case["context"], ensure_ascii=False)), 2000, case["id"])

    def test_example_config_distinguishes_direct_and_production_adapters(self) -> None:
        config = run_eval.load_config(HERE / "configs.example.json")
        self.assertEqual(
            ["direct_baseline", "direct_candidate", "chatbook_production"],
            [item["id"] for item in config["configs"]],
        )
        self.assertEqual(
            ["direct_model", "direct_model", "chatbook_api"],
            [item["adapter"] for item in config["configs"]],
        )
        for target in config["configs"]:
            request = run_eval.config_request(config, target)
            self.assertNotIn("api_key", request)
            self.assertNotIn("token", request)


class MappingTests(unittest.TestCase):
    def test_chatbook_mapping_matches_ask_request_and_does_not_invent_rag(self) -> None:
        case = {
            "id": "mapping_001",
            "question": "两章有什么不同？",
            "expected_evidence_types": ["current_context"],
            "context": {
                "book_title": "自造书",
                "author": "测试作者",
                "chapter_title": "第二章",
                "current_text": "当前页面正文。",
                "selection": "用户划线。",
                "memory": [{"role": "user", "content": "请简短回答。"}],
                "retrieved_excerpts": [{"chapter": "第一章", "text": "前章正文。"}],
            },
        }
        payload, metadata = run_eval.build_chatbook_request(case, {"style": "simple"})
        self.assertEqual(
            {
                "bookTitle": "自造书",
                "author": "测试作者",
                "chapterTitle": "第二章",
                "pageText": "当前页面正文。",
                "selection": "用户划线。",
                "positionId": "eval:mapping_001",
                "userHighlights": [],
                "popularHighlights": [],
            },
            payload["context"],
        )
        self.assertEqual([{"role": "user", "content": "请简短回答。"}], payload["history"])
        self.assertEqual(1, metadata["omitted_retrieved_excerpts"])
        self.assertNotIn("retrieved_excerpts", json.dumps(payload, ensure_ascii=False))

    def test_sse_parser_handles_fragmented_utf8_and_completion_metadata(self) -> None:
        raw = (
            'data: {"delta":"你"}\r\n\r\n'
            'data: {"delta":"好"}\n\n'
            'data: {"done":true,"answer":"你好","evidenceType":"current_context"}\n\n'
        ).encode("utf-8")
        utf8_split = raw.index("你".encode("utf-8")) + 1
        crlf_split = raw.index(b"\r") + 1
        cuts = sorted({utf8_split, crlf_split, len(raw) // 2})
        chunks = [raw[start:end] for start, end in zip([0, *cuts], [*cuts, len(raw)])]
        events = list(run_eval.parse_sse_events(chunks))
        self.assertEqual(["你", "好"], [event["delta"] for event in events[:2]])
        self.assertTrue(events[2]["done"])
        self.assertEqual("current_context", events[2]["evidenceType"])

    def test_chatbook_adapter_uses_done_answer_and_available_evidence_metadata(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter([
                    b'data: {"delta":"partial"}\n\n',
                    b'data: {"done":true,"answer":"final",',
                    b'"availableEvidenceType":"user_selection","contextChars":12}\n\n',
                ])

        case = {
            "id": "adapter_001",
            "question": "解释一下。",
            "expected_evidence_types": ["user_selection"],
            "context": {
                "book_title": "书",
                "chapter_title": "章",
                "current_text": "页面",
                "selection": "划线",
                "memory": [],
                "retrieved_excerpts": [],
            },
        }
        request = {
            "base_url": "https://chatbook.test",
            "path": "/ask/stream",
            "timeout_seconds": 10,
        }
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse()):
            result = run_eval.call_chatbook_api(request, {"style": "simple"}, case, "extension-token")
        self.assertEqual("final", result["answer"])
        self.assertEqual("user_selection", result["evidence_type"])
        self.assertEqual(12, result["backend_metadata"]["contextChars"])
        self.assertEqual("AskRequest", result["request_metadata"]["request_shape"])


class RunnerTests(unittest.TestCase):
    def _args(self, **overrides):
        values = {
            "dataset": str(HERE / "cases.jsonl"),
            "config": str(HERE / "configs.example.json"),
            "target": None,
            "execute": False,
            "output": None,
        }
        values.update(overrides)
        return Namespace(**values)

    def test_default_run_reads_no_secret_and_never_opens_network(self) -> None:
        with (
            mock.patch("urllib.request.urlopen", side_effect=AssertionError("network called")) as urlopen,
            mock.patch.object(run_eval.os.environ, "get", side_effect=AssertionError("secret read")) as env_get,
        ):
            self.assertEqual(0, run_eval.run(self._args()))
        urlopen.assert_not_called()
        env_get.assert_not_called()

    def test_execute_rejects_direct_placeholder_before_secret_lookup(self) -> None:
        with self.assertRaisesRegex(ValueError, "replace the example endpoint"):
            run_eval.run(self._args(target=["direct_baseline"], execute=True))

    def test_execute_rejects_chatbook_placeholder_before_secret_lookup(self) -> None:
        with self.assertRaisesRegex(ValueError, "replace the example endpoint"):
            run_eval.run(self._args(target=["chatbook_production"], execute=True))


class ScoreTests(unittest.TestCase):
    def test_make_scorecard_has_one_row_per_case_and_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "scorecard.csv"
            score_eval.make_scorecard(HERE / "cases.jsonl", HERE / "configs.example.json", output, None)
            with output.open(encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(42 * 3, len(rows))

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
