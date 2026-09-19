import os
import tempfile
import unittest

from ebooklib import epub

from api.main import _build_standard_reading_chapters


class StandardReadingExtractionTests(unittest.TestCase):
    def test_toc_entries_do_not_become_empty_chapters(self):
        book = epub.EpubBook()
        book.set_identifier("standard-reader-test")
        book.set_title("Test")
        book.set_language("zh")
        first = epub.EpubHtml(title="First", file_name="one.xhtml", lang="zh")
        first.content = '<html><body><h1>第一章</h1><div>第一章的正文来自 div 标签。</div></body></html>'
        second = epub.EpubHtml(title="Second", file_name="two.xhtml", lang="zh")
        second.content = '<html><body><h1>第二章</h1><p>第二章的正文来自 p 标签。</p></body></html>'
        book.add_item(first)
        book.add_item(second)
        book.toc = (
            epub.Section("第一章", href="one.xhtml"),
            epub.Link("one.xhtml#part1", "第一节", "part1"),
            epub.Link("one.xhtml#part2", "第二节", "part2"),
            epub.Link("two.xhtml", "第二章", "second"),
        )
        book.add_item(epub.EpubNcx())
        book.add_item(epub.EpubNav())
        book.spine = ["nav", first, second]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "test.epub")
            epub.write_epub(path, book)
            chapters = _build_standard_reading_chapters(path)

        self.assertEqual(len(chapters), 2)
        self.assertIn("第一章的正文", " ".join(chapters[0]["paragraphs"]))
        self.assertIn("第二章的正文", " ".join(chapters[1]["paragraphs"]))
        self.assertTrue(all(chapter["blocks"] for chapter in chapters))


if __name__ == "__main__":
    unittest.main()
