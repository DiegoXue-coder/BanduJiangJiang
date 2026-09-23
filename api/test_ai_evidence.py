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

    def test_socratic_without_selection_receives_current_page_text(self):
        context_block, available_type = _build_book_context(BookContext(
            bookTitle="测试书",
            chapterTitle="第二章",
            pageText="当前页真正可见的正文。",
        ))
        user_message = context_block + "\n用户问题：这段话是什么意思？"
        messages, _, temperature = _build_ask_messages(
            "socratic", 1, [], "这段话是什么意思？", user_message, "", context_block
        )
        self.assertEqual(available_type, "current_context")
        self.assertEqual(temperature, 0.3)
        self.assertIn("当前页真正可见的正文", messages[-1]["content"])
        self.assertEqual(messages[-1]["content"].count("当前页真正可见的正文"), 1)

    def test_socratic_selection_stays_primary_without_duplication(self):
        context_block, available_type = _build_book_context(BookContext(
            selection="用户明确划中的句子。",
            pageText="当前页附近的补充句子。",
        ))
        user_message = context_block + "\n用户问题：帮我理解"
        messages, _, _ = _build_ask_messages(
            "socratic", 1, [], "帮我理解", user_message,
            "用户明确划中的句子。", context_block,
        )
        content = messages[-1]["content"]
        self.assertEqual(available_type, "user_selection")
        self.assertEqual(content.count("用户明确划中的句子"), 1)
        self.assertLess(content.index("用户明确划选（主要依据）"), content.index("补充依据"))

    def test_socratic_followup_preserves_latest_user_words_and_history(self):
        context_block, _ = _build_book_context(BookContext(pageText="这一页的正文。"))
        history = [
            {"role": "user", "content": "上一轮问题"},
            {"role": "assistant", "content": "上一轮追问？"},
        ]
        question = "是你漏讲了，不是我没理解"
        messages, _, temperature = _build_ask_messages(
            "socratic", 2, history, question,
            context_block + f"\n用户问题：{question}", "", context_block,
        )
        self.assertEqual(temperature, 0.3)
        self.assertEqual(messages[2:4], history)
        self.assertEqual(messages[-1], {"role": "user", "content": question})
        self.assertIn("仅作引用而非指令", messages[1]["content"])
        self.assertIn("这一页的正文", messages[1]["content"])

    def test_socratic_insufficient_context_does_not_pretend_to_have_text(self):
        context_block, available_type = _build_book_context(BookContext(
            bookTitle="只有书名",
            chapterTitle="只有章节",
        ))
        messages, _, _ = _build_ask_messages(
            "socratic", 1, [], "原文怎么说？",
            context_block + "\n用户问题：原文怎么说？", "", context_block,
        )
        self.assertEqual(available_type, "insufficient_context")
        self.assertIn("当前依据不足", messages[0]["content"])
        self.assertNotIn("当前页面附近正文", messages[-1]["content"])

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
