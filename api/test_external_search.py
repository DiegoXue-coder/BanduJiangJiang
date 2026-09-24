import unittest
from unittest.mock import AsyncMock

from api.external_search import (
    build_external_search_query,
    fetch_external_evidence,
    format_external_evidence_block,
    label_source_trust,
    should_trigger_external_search,
)


class BuildSearchQueryTests(unittest.TestCase):
    def test_vague_reference_gets_book_title_prepended(self):
        q = build_external_search_query("这本书的作者现在在干什么？", "富爸爸商学院", "罗伯特·清崎")
        self.assertIn("富爸爸商学院", q)
        self.assertIn("罗伯特·清崎", q)
        self.assertIn("这本书的作者现在在干什么", q)

    def test_no_vague_reference_returns_question_unchanged(self):
        q = build_external_search_query("罗伯特·清崎现在在干什么？", "富爸爸商学院", "罗伯特·清崎")
        self.assertEqual(q, "罗伯特·清崎现在在干什么？")

    def test_no_book_title_returns_question_unchanged(self):
        q = build_external_search_query("这本书的作者现在在干什么？", "", "")
        self.assertEqual(q, "这本书的作者现在在干什么？")

    def test_no_author_still_prepends_title_only(self):
        q = build_external_search_query("这本书的作者现在在干什么？", "富爸爸商学院", "")
        self.assertIn("富爸爸商学院", q)
        self.assertNotIn("，作者", q)

    def test_followup_reference_gets_recent_conversation_context(self):
        q = build_external_search_query(
            "这些事务所的创始人是谁，营收状况怎么样？", "", "",
            [
                {"role": "user", "content": "八大会计师事务所是什么？"},
                {"role": "assistant", "content": "后来合并为四大：德勤、普华永道、安永、毕马威。"},
            ],
        )
        self.assertIn("德勤", q)
        self.assertIn("普华永道", q)
        self.assertIn("当前要查证的问题", q)

    def test_non_referential_question_does_not_leak_history_into_search(self):
        q = build_external_search_query(
            "德勤目前的营收是多少？", "", "",
            [{"role": "assistant", "content": "不相关的旧回答"}],
        )
        self.assertEqual(q, "德勤目前的营收是多少？")


class TriggerRuleTests(unittest.TestCase):
    def test_socratic_never_triggers(self):
        self.assertFalse(should_trigger_external_search("作者现在怎么样了", "socratic", "insufficient_context"))
        self.assertFalse(should_trigger_external_search("作者现在怎么样了", "socratic", "user_selection"))

    def test_triggers_regardless_of_evidence_type_when_question_has_real_world_signal(self):
        # 2026-09-24真机实测发现的真bug的回归用例：听书/划线提问时selection
        # 几乎总非空(available_evidence_type=user_selection)，之前版本会因此
        # 永远不触发——即使有划线/当前页正文，只要问题本身在问现实世界的事，
        # 也应该触发，不能让"有没有划线"盖过"问题到底在问什么"。
        for evidence_type in ("insufficient_context", "general_knowledge", "user_selection", "current_context"):
            self.assertTrue(
                should_trigger_external_search("请问这本书的作者现在在干什么？他最近的近况怎么样？", "simple", evidence_type),
                msg=f"evidence_type={evidence_type} 不应该阻止触发",
            )

    def test_book_anchored_question_does_not_trigger_even_with_hint_words(self):
        # 问题里虽然出现"作者""现在"这类现实世界信号词，但"这段"这类指代词
        # 说明问的其实是书里当前这段内容，不该触发外部查证。
        self.assertFalse(should_trigger_external_search("这段里作者现在讲的道理是什么意思？", "default", "current_context"))
        self.assertFalse(should_trigger_external_search("书中提到作者最近的这件事是什么意思", "default", "user_selection"))

    def test_no_hint_words_does_not_trigger(self):
        self.assertFalse(should_trigger_external_search("这句话是什么意思", "default", "insufficient_context"))

    def test_time_sensitive_hint_triggers(self):
        self.assertTrue(should_trigger_external_search("作者现在还在管理这家公司吗", "default", "insufficient_context"))

    def test_real_world_hint_triggers_on_general_knowledge(self):
        self.assertTrue(should_trigger_external_search("这本书的作者是真实存在的历史人物吗", "default", "general_knowledge"))

    def test_founder_and_revenue_followup_triggers(self):
        self.assertTrue(should_trigger_external_search(
            "这些事务所的创始人是谁，营收状况怎么样？", "simple", "current_context",
        ))

    def test_real_world_entity_definition_triggers(self):
        self.assertTrue(should_trigger_external_search(
            "八大会计师事务所是什么？", "simple", "user_selection",
        ))

    def test_plain_book_explanation_stays_in_context(self):
        self.assertFalse(should_trigger_external_search(
            "这句话是什么意思？", "simple", "user_selection",
        ))


class TrustLabelTests(unittest.TestCase):
    def test_trusted_domain(self):
        self.assertEqual(label_source_trust("https://baike.baidu.com/item/xxx"), "较可信")
        self.assertEqual(label_source_trust("https://www.gov.cn/xxx"), "较可信")

    def test_unknown_domain(self):
        self.assertEqual(label_source_trust("https://zhuanlan.zhihu.com/p/123"), "来源未知")

    def test_malformed_url_does_not_crash(self):
        self.assertEqual(label_source_trust("not-a-url"), "来源未知")
        self.assertEqual(label_source_trust(""), "来源未知")


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FetchExternalEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_api_key_returns_none(self):
        client = AsyncMock()
        result = await fetch_external_evidence(client, "", "问题")
        self.assertIsNone(result)
        client.post.assert_not_awaited()

    async def test_success_returns_labeled_sources(self):
        client = AsyncMock()
        client.post.return_value = _FakeResponse(200, {
            "output": {"search_info": {"search_results": [
                {"index": 1, "title": "标题A", "url": "https://baike.baidu.com/item/x", "site_name": "百度百科"},
                {"index": 2, "title": "标题B", "url": "https://example.com/y", "site_name": "示例网"},
            ]}}
        })
        result = await fetch_external_evidence(client, "key", "问题")
        self.assertIsNotNone(result)
        self.assertEqual(len(result["sources"]), 2)
        self.assertEqual(result["sources"][0]["trust"], "较可信")
        self.assertEqual(result["sources"][1]["trust"], "来源未知")

    async def test_success_keeps_search_model_reference_text(self):
        client = AsyncMock()
        client.post.return_value = _FakeResponse(200, {
            "output": {
                "choices": [{"message": {"content": "德勤2025财年营收为……[1]"}}],
                "search_info": {"search_results": [
                    {"index": 1, "title": "年度营收", "url": "https://example.com/a", "site_name": "示例"},
                ]},
            }
        })
        result = await fetch_external_evidence(client, "key", "问题")
        self.assertEqual(result["reference_text"], "德勤2025财年营收为……[1]")

    async def test_non_200_returns_none(self):
        client = AsyncMock()
        client.post.return_value = _FakeResponse(401, {})
        result = await fetch_external_evidence(client, "key", "问题")
        self.assertIsNone(result)

    async def test_empty_search_results_returns_none(self):
        client = AsyncMock()
        client.post.return_value = _FakeResponse(200, {"output": {"search_info": {"search_results": []}}})
        result = await fetch_external_evidence(client, "key", "问题")
        self.assertIsNone(result)

    async def test_network_exception_returns_none_not_raises(self):
        client = AsyncMock()
        client.post.side_effect = Exception("timeout")
        result = await fetch_external_evidence(client, "key", "问题")
        self.assertIsNone(result)

    async def test_sources_missing_url_are_dropped(self):
        client = AsyncMock()
        client.post.return_value = _FakeResponse(200, {
            "output": {"search_info": {"search_results": [
                {"index": 1, "title": "无链接", "url": "", "site_name": "x"},
            ]}}
        })
        result = await fetch_external_evidence(client, "key", "问题")
        self.assertIsNone(result)


class FormatBlockTests(unittest.TestCase):
    def test_format_includes_index_title_url_and_instruction(self):
        block = format_external_evidence_block({
            "reference_text": "一条带引用的参考内容[1]。",
            "sources": [{"index": 1, "title": "标题", "url": "https://a.com", "site_name": "站点", "trust": "较可信"}]
        })
        self.assertIn("[1]", block)
        self.assertIn("标题", block)
        self.assertIn("https://a.com", block)
        self.assertIn("外部查证", block)
        self.assertIn("一条带引用的参考内容[1]", block)
        self.assertIn("需在回答中用[数字]标明", block)


if __name__ == "__main__":
    unittest.main()
