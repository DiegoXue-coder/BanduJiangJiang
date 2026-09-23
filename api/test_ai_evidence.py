import os
import unittest

from api.main import (
    DEEPSEEK_MODEL,
    SYSTEM_PROMPT,
    BookContext,
    _bounded_context_text,
    _build_ask_messages,
    _build_book_context,
    _stream_done_payload,
)


class AiEvidenceTests(unittest.TestCase):
    def test_direct_answer_uses_lower_temperature(self):
        _, _, temperature = _build_ask_messages(
            "simple", 1, [], "为什么？", "用户问题：为什么？", ""
        )
        self.assertEqual(temperature, 0.5)

    def test_socratic_temperature_is_unchanged(self):
        _, _, temperature = _build_ask_messages(
            "socratic", 1, [], "为什么？", "用户问题：为什么？", "原文"
        )
        self.assertEqual(temperature, 0.3)

    def test_current_page_context_has_machine_readable_basis(self):
        block, available_evidence_type = _build_book_context(BookContext(
            bookTitle="测试书",
            chapterTitle="第三章",
            positionId="standard:3:page:2",
            pageText="当前页第一段。\n\n当前页第二段。",
        ))
        self.assertEqual(available_evidence_type, "current_context")
        self.assertIn("【当前页面附近正文（主要依据）】", block)
        self.assertIn("【稳定位置】standard:3:page:2", block)

    def test_selection_remains_primary_and_page_is_supplementary(self):
        block, available_evidence_type = _build_book_context(BookContext(
            selection="用户划选的原文。",
            pageText="同一页附近的补充原文。",
        ))
        self.assertEqual(available_evidence_type, "user_selection")
        self.assertLess(block.index("用户明确划选"), block.index("当前页面附近正文"))
        self.assertIn("补充依据", block)

    def test_missing_body_context_is_explicitly_insufficient(self):
        _, available_evidence_type = _build_book_context(BookContext(
            bookTitle="只有书名",
            chapterTitle="只有章节",
        ))
        self.assertEqual(available_evidence_type, "insufficient_context")

    def test_context_free_question_uses_general_knowledge(self):
        block, available_evidence_type = _build_book_context(BookContext())
        self.assertEqual(block, "")
        self.assertEqual(available_evidence_type, "general_knowledge")

    def test_stream_done_event_keeps_answer_and_exposes_available_context(self):
        payload = _stream_done_payload("旧客户端仍能读取的回答", "current_context")
        self.assertTrue(payload["done"])
        self.assertEqual(payload["answer"], "旧客户端仍能读取的回答")
        self.assertEqual(payload["availableEvidenceType"], "current_context")
        self.assertNotIn("evidenceType", payload)

    def test_long_context_stops_at_natural_boundary(self):
        text = ("甲" * 90) + "\n\n" + ("乙" * 90) + "\n\n" + ("丙" * 90)
        bounded = _bounded_context_text(text, 200)
        self.assertEqual(bounded, ("甲" * 90) + "\n\n" + ("乙" * 90))

    def test_prompt_contains_required_evidence_rules(self):
        for phrase in ("不得伪造", "一般背景知识", "上下文不足", "高风险"):
            self.assertIn(phrase, SYSTEM_PROMPT)

    def test_model_default_is_current_official_name(self):
        self.assertTrue(DEEPSEEK_MODEL)
        if not os.environ.get("DEEPSEEK_MODEL"):
            self.assertEqual(DEEPSEEK_MODEL, "deepseek-flash")


if __name__ == "__main__":
    unittest.main()
