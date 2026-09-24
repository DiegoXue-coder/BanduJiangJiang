import unittest
from unittest.mock import AsyncMock

from api.external_search import (
    fetch_external_evidence,
    format_external_evidence_block,
    label_source_trust,
    should_trigger_external_search,
)


class TriggerRuleTests(unittest.TestCase):
    def test_socratic_never_triggers(self):
        self.assertFalse(should_trigger_external_search("作者现在怎么样了", "socratic", "insufficient_context"))

    def test_has_book_grounding_does_not_trigger_even_with_hint(self):
        self.assertFalse(should_trigger_external_search("作者现在怎么样了", "default", "current_context"))
        self.assertFalse(should_trigger_external_search("作者现在怎么样了", "default", "user_selection"))

    def test_no_hint_words_does_not_trigger(self):
        self.assertFalse(should_trigger_external_search("这句话是什么意思", "default", "insufficient_context"))

    def test_time_sensitive_hint_triggers(self):
        self.assertTrue(should_trigger_external_search("作者现在还在管理这家公司吗", "default", "insufficient_context"))

    def test_real_world_hint_triggers_on_general_knowledge(self):
        self.assertTrue(should_trigger_external_search("这本书的作者是真实存在的历史人物吗", "default", "general_knowledge"))


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
            "sources": [{"index": 1, "title": "标题", "url": "https://a.com", "site_name": "站点", "trust": "较可信"}]
        })
        self.assertIn("[1]", block)
        self.assertIn("标题", block)
        self.assertIn("https://a.com", block)
        self.assertIn("外部查证", block)
        self.assertIn("需在回答中用[数字]标明", block)


if __name__ == "__main__":
    unittest.main()
