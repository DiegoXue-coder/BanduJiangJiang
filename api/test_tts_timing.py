import unittest

from api.main import _map_tts_word_boundaries


class TtsWordBoundaryMappingTests(unittest.TestCase):
    def test_maps_repeated_words_from_current_cursor(self):
        text = "人们前进，人们继续前进。"
        events = [
            {"text": "人们", "offset": 1_000_000, "duration": 2_000_000},
            {"text": "前进", "offset": 3_000_000, "duration": 2_500_000},
            {"text": "人们", "offset": 6_000_000, "duration": 2_000_000},
        ]

        result = _map_tts_word_boundaries(text, events)

        self.assertEqual([item["charStart"] for item in result], [0, 2, 5])
        self.assertEqual(result[0]["offsetMs"], 100.0)
        self.assertEqual(result[1]["durationMs"], 250.0)

    def test_returns_empty_timeline_when_event_cannot_be_mapped(self):
        result = _map_tts_word_boundaries(
            "正文",
            [{"text": "不存在", "offset": 0, "duration": 1_000_000}],
        )

        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()
