import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from starlette.requests import Request

from api.main import (
    DEEPSEEK_MODEL,
    SYSTEM_PROMPT,
    AskRequest,
    BookContext,
    _bounded_context_text,
    _build_ask_messages,
    _build_book_context,
    _filter_initial_safety_delta,
    _finalize_socratic_text,
    _safety_prefix_delta,
    _socratic_action_safety_prefix,
    _stream_done_payload,
    _with_safety_prefix,
    ask_stream,
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

    def test_socratic_high_risk_rule_requires_boundary_before_question(self):
        messages, _, temperature = _build_ask_messages(
            "socratic", 1, [], "我可以自行停药吗？", "用户问题：我可以自行停药吗？", ""
        )
        system = messages[0]["content"]
        self.assertEqual(temperature, 0.3)
        self.assertIn("优先级高于苏格拉底追问", system)
        self.assertIn("不得让用户依据书中案例自行停药、改剂量", system)
        self.assertIn("咨询合格医生", system)
        self.assertIn("不得只用反问", system)

    def test_socratic_high_risk_rule_exempts_open_discussion(self):
        messages, _, _ = _build_ask_messages(
            "socratic", 1, [], "鲲鹏意象可以怎样理解？",
            "用户问题：鲲鹏意象可以怎样理解？", ""
        )
        self.assertIn("普通文学解读", messages[0]["content"])
        self.assertIn("不要附加机械免责声明", messages[0]["content"])
        self.assertIn("不能只把问题原样反问回去", messages[0]["content"])
        self.assertIn("回答必须以“一种可能的理解是”开头", messages[0]["content"])
        self.assertIn("而非作者唯一确定的", messages[0]["content"])
        self.assertEqual(messages[-1]["content"], "鲲鹏意象可以怎样理解？")

    def test_action_guard_detects_explicit_medical_legal_and_financial_requests(self):
        medical = _socratic_action_safety_prefix("那我可以靠晨跑自己停降压药吗？")
        legal = _socratic_action_safety_prefix("我照着作者这样报销可以吗？")
        financial = _socratic_action_safety_prefix("我可以按作者的方法买这只基金吗？")
        self.assertIn("不能仅根据书中内容自行停药", medical)
        self.assertIn("合法合规", legal)
        self.assertIn("不能根据书中个案保证收益", financial)

    def test_action_guard_does_not_trigger_for_discussion_or_passive_mentions(self):
        safe_questions = (
            "小说里人物停药这一情节象征什么？",
            "书中提到这种药的历史背景是什么？",
            "这项政策公布的投资数据可靠吗？",
            "集中持仓为什么会放大波动？",
            "作者对税法改革的批评有道理吗？",
        )
        for question in safe_questions:
            self.assertEqual(_socratic_action_safety_prefix(question), "", question)

    def test_non_stream_safety_prefix_is_first_and_not_duplicated(self):
        prefix = _socratic_action_safety_prefix("我可以停降压药吗？")
        model_answer = "书中只是个人经历。我该如何观察血压？"
        answer = _with_safety_prefix(model_answer, prefix)
        self.assertTrue(answer.startswith(prefix))
        self.assertEqual(answer.count(prefix), 1)
        self.assertEqual(_with_safety_prefix(answer, prefix), answer)

    def test_stream_safety_prefix_is_first_delta_and_model_duplicate_is_removed(self):
        prefix = _socratic_action_safety_prefix("我可以停降压药吗？")
        first_delta = _safety_prefix_delta(prefix)
        pending = ""
        decided = False
        outputs = []
        for chunk in (prefix[:8], prefix[8:], "书中只是个人经历。我该如何观察血压？"):
            pending, outgoing, decided = _filter_initial_safety_delta(
                pending, chunk, prefix, decided
            )
            if outgoing:
                outputs.append(outgoing)
        streamed = first_delta + "".join(outputs)
        self.assertTrue(streamed.startswith(prefix))
        self.assertEqual(streamed.count(prefix), 1)
        self.assertIn("书中只是个人经历", streamed)

    def test_stream_endpoint_emits_guard_before_model_and_done_answer_contains_it_once(self):
        prefix = _socratic_action_safety_prefix("我可以停降压药吗？")
        model_parts = (prefix[:10], prefix[10:], "书中只是个人经历。我该如何观察血压？")

        class FakeCompletions:
            @staticmethod
            def create(**_kwargs):
                return [
                    SimpleNamespace(choices=[SimpleNamespace(
                        delta=SimpleNamespace(content=part)
                    )])
                    for part in model_parts
                ]

        fake_ds = SimpleNamespace(
            chat=SimpleNamespace(completions=FakeCompletions())
        )
        prepared = (
            fake_ds, [{"role": "user", "content": "问题"}], 130, 0.3, 1,
            "current_context", prefix, [],
        )
        request = Request({
            "type": "http", "method": "POST", "path": "/ask/stream",
            "headers": [], "client": ("127.0.0.1", 1234),
        })
        req = AskRequest(
            question="我可以停降压药吗？",
            context=BookContext(pageText="一次个人晨跑记录。"),
            style="socratic",
        )

        async def collect_events():
            with patch("api.main._prepare_ask", new=AsyncMock(return_value=prepared)):
                response = await ask_stream(req, request, None, None)
                body = ""
                async for chunk in response.body_iterator:
                    body += chunk.decode() if isinstance(chunk, bytes) else chunk
            return [
                json.loads(line[6:])
                for line in body.splitlines()
                if line.startswith("data: ")
            ]

        events = asyncio.run(collect_events())
        self.assertEqual(events[0], {"delta": _safety_prefix_delta(prefix)})
        done = next(event for event in events if event.get("done"))
        self.assertTrue(done["answer"].startswith(prefix))
        self.assertEqual(done["answer"].count(prefix), 1)
        streamed_text = "".join(event.get("delta", "") for event in events)
        self.assertEqual(streamed_text.count(prefix), 1)

    def test_insufficient_context_rule_does_not_echo_question_as_reply(self):
        messages, _, _ = _build_ask_messages(
            "socratic", 1, [], "作者出生在哪座城市？",
            "用户问题：作者出生在哪座城市？", "",
        )
        self.assertIn("不要把用户原问题换个说法反问回去", messages[0]["content"])
        self.assertIn("建议用户划选相关原文", messages[0]["content"])

    def test_socratic_without_question_mark_is_not_cut_mid_sentence(self):
        raw = "现有内容只提到作者从小喜欢沿河散步，没有提供出生地或成长城市的信息，无法回答作者出生在哪座城市。"
        self.assertGreater(len(raw), 40)
        self.assertEqual(_finalize_socratic_text(raw, "socratic", 1), raw)

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
