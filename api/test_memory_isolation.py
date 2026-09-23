import unittest
from unittest.mock import AsyncMock, patch

from api.main import (
    HistorySaveRequest,
    ListenProgressIn,
    _get_memory_context,
    app_get_listen_history,
    app_update_listen_progress,
    save_history,
)
from fastapi import HTTPException


class _Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *_args):
        return False


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _Acquire(self.conn)


class _UserScopedConnection:
    def __init__(self):
        self.query = ""
        self.args = ()

    async def fetch(self, query, *args):
        self.query = query
        self.args = args
        # 假数据库里同时存在A/B两人的资料，但只按SQL传入的user_id返回。
        rows = {
            101: [{"book_title": "A的书", "question": "A的问题", "answer": "A的答案"}],
            202: [{"book_title": "B的书", "question": "B的问题", "answer": "B的答案"}],
        }
        return rows.get(args[2], [])


class _ListenHistoryConnection:
    def __init__(self):
        self.query = ''
        self.args = ()

    async def fetchrow(self, _query, *_args):
        return {'id': 7, 'source': 'preset', 'imported_by': None}

    async def fetch(self, query, *args):
        self.query = query
        self.args = args
        rows = {
            101: [{'id': 1, 'question': 'A的问题', 'answer': 'A的回答'}],
            202: [{'id': 2, 'question': 'B的问题', 'answer': 'B的回答'}],
        }
        return rows.get(args[0], [])


class _ListenProgressConnection:
    def __init__(self):
        self.upsert_args = ()

    async def fetchrow(self, query, *args):
        if 'SELECT id, source, imported_by' in query:
            return {'id': 7, 'source': 'preset', 'imported_by': None}
        self.upsert_args = args
        return {
            'chapter_kind': args[2], 'chapter_id': args[3], 'chapter_title': args[4],
            'paragraph_index': args[5], 'char_offset': args[6],
            'voice': args[7], 'rate': args[8], 'updated_at': None,
        }


class MemoryIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_user_a_never_receives_user_b_memory(self):
        conn = _UserScopedConnection()
        with (
            patch("api.main._embed", AsyncMock(return_value=[0.1, 0.2])),
            patch("api.main.get_pool", AsyncMock(return_value=_Pool(conn))),
        ):
            result = await _get_memory_context("同一个问题", user_id=101)

        self.assertIn("A的问题", result)
        self.assertNotIn("B的问题", result)
        self.assertIn("WHERE user_id = $3", conn.query)
        self.assertEqual(conn.args[2], 101)

    async def test_guest_and_legacy_extension_skip_private_memory(self):
        with patch("api.main.get_pool", AsyncMock()) as get_pool:
            result = await _get_memory_context("访客问题", user_id=None)

        self.assertEqual(result, "")
        get_pool.assert_not_awaited()

    async def test_listen_history_is_scoped_to_current_user_and_book(self):
        conn = _ListenHistoryConnection()
        with patch('api.main.get_pool', AsyncMock(return_value=_Pool(conn))):
            result = await app_get_listen_history(book_id=7, limit=30, user_id=101)

        self.assertEqual(result[0]['question'], 'A的问题')
        self.assertNotIn('B的问题', str(result))
        self.assertIn('WHERE user_id = $1 AND book_id = $2', conn.query)
        self.assertEqual(conn.args, (101, '7', 30))

    async def test_listen_progress_upsert_uses_current_user(self):
        conn = _ListenProgressConnection()
        body = ListenProgressIn(
            chapter_kind='standard', chapter_id=55, chapter_title='原则一',
            paragraph_index=3, char_offset=24, rate='+25%',
        )
        with patch('api.main.get_pool', AsyncMock(return_value=_Pool(conn))):
            await app_update_listen_progress(book_id=7, body=body, user_id=202)

        self.assertEqual(conn.upsert_args[0:2], (202, 7))
        self.assertEqual(conn.upsert_args[2:7], ('standard', 55, '原则一', 3, 24))

    async def test_invalid_mobile_bearer_never_falls_back_to_seed_user(self):
        request = type('RequestStub', (), {
            'headers': {'authorization': 'Bearer expired-token'},
        })()
        body = HistorySaveRequest(question='问题', answer='回答')
        with patch('api.main.get_pool', AsyncMock()) as get_pool:
            with self.assertRaises(HTTPException) as raised:
                await save_history(body, request, None, user_id=None)

        self.assertEqual(raised.exception.status_code, 401)
        get_pool.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
