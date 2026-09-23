import os
import tempfile
import unittest

from ebooklib import epub

from api.main import _build_standard_reading_chapters_v2


def _write_and_build(book) -> list[dict]:
    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, "test.epub")
        epub.write_epub(path, book)
        return _build_standard_reading_chapters_v2(path)


def _new_book(pages: list[tuple[str, str]]) -> tuple[epub.EpubBook, list[epub.EpubHtml]]:
    """pages: [(file_name, html_content), ...]"""
    book = epub.EpubBook()
    book.set_identifier("v2-test")
    book.set_title("Test")
    book.set_language("zh")
    items = []
    for file_name, html in pages:
        item = epub.EpubHtml(title=file_name, file_name=file_name, lang="zh")
        item.content = html
        book.add_item(item)
        items.append(item)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    return book, items


class GroupPathTests(unittest.TestCase):
    def test_multi_file_section_becomes_group(self):
        # 一个 Section 的子树跨两个物理文件 => 算一个分组（册/部）；
        # 单文件的 Section 不该被当成分组。
        book, items = _new_book([
            ("a.xhtml", "<html><body><h2>第一节</h2><p>第一节正文</p></body></html>"),
            ("b.xhtml", "<html><body><h2>第二节</h2><p>第二节正文</p></body></html>"),
            ("c.xhtml", "<html><body><h1>独立章</h1><p>独立章正文</p></body></html>"),
        ])
        book.toc = (
            (epub.Section("第一部"), (
                epub.Link("a.xhtml", "第一节", "a"),
                epub.Link("b.xhtml", "第二节", "b"),
            )),
            epub.Link("c.xhtml", "独立章", "c"),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        by_title = {c["title"]: c for c in chapters}
        self.assertEqual(by_title["第一节"]["group_path"], ["第一部"])
        self.assertEqual(by_title["第二节"]["group_path"], ["第一部"])
        # 单文件章节不应该被硬套上分组
        self.assertEqual(by_title["独立章"]["group_path"], [])

    def test_no_content_loss_across_all_chapters(self):
        book, items = _new_book([
            ("a.xhtml", "<html><body><h2>第一节</h2><p>第一节正文</p></body></html>"),
            ("b.xhtml", "<html><body><h2>第二节</h2><p>第二节正文</p></body></html>"),
        ])
        book.toc = (
            (epub.Section("第一部"), (
                epub.Link("a.xhtml", "第一节", "a"),
                epub.Link("b.xhtml", "第二节", "b"),
            )),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)
        all_text = "".join(p for c in chapters for p in c["paragraphs"])
        self.assertIn("第一节正文", all_text)
        self.assertIn("第二节正文", all_text)


class OrphanMergeTests(unittest.TestCase):
    def test_orphan_without_toc_or_heading_merges_forward(self):
        # b.xhtml 既不在目录里也没有自己的 h1~h3 标题 => 应该并入前一章，
        # 不能单独变成一条无意义的目录项（真需求真实案例：夹在两个同标签
        # 文件中间的正文文件，不看字数，只看有没有 TOC/标题依据）。
        book, items = _new_book([
            ("a.xhtml", "<html><body><h1>第一章</h1><p>第一章正文，这里内容比较长一些用来确认不会被误判成小文件。</p></body></html>"),
            ("b.xhtml", "<html><body><div>没有标题标签的过渡段落，同样有相当篇幅的正文内容用来验证长度阈值已经被去掉了。</div></body></html>"),
            ("c.xhtml", "<html><body><h1>第二章</h1><p>第二章正文</p></body></html>"),
        ])
        book.toc = (
            epub.Link("a.xhtml", "第一章", "a"),
            epub.Link("c.xhtml", "第二章", "c"),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        self.assertEqual([c["title"] for c in chapters], ["第一章", "第二章"])
        self.assertIn("没有标题标签的过渡段落", "".join(chapters[0]["paragraphs"]))

    def test_leading_orphan_before_first_chapter_is_kept_not_dropped(self):
        book, items = _new_book([
            ("cover.xhtml", "<html><body><div>封面说明文字，没有标题标签也不在目录里。</div></body></html>"),
            ("a.xhtml", "<html><body><h1>第一章</h1><p>第一章正文</p></body></html>"),
        ])
        book.toc = (
            epub.Link("a.xhtml", "第一章", "a"),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)
        self.assertEqual(len(chapters), 1)
        self.assertIn("封面说明文字", "".join(chapters[0]["paragraphs"]))
        self.assertIn("第一章正文", "".join(chapters[0]["paragraphs"]))


class SameLabelMergeAndSplitTests(unittest.TestCase):
    def test_consecutive_same_label_files_merge_into_one_chapter(self):
        # 真需求真实场景的缩影：连续多个文件被 TOC 标成完全相同的标题，
        # 不应该在目录里显示成一堆长得一样的条目。
        pages = [(f"p{i}.xhtml", f"<html><body><h2>PART ONE</h2><p>第{i}页正文内容。</p></body></html>") for i in range(5)]
        book, items = _new_book(pages)
        book.toc = tuple(epub.Link(f"p{i}.xhtml", "PART ONE", f"p{i}") for i in range(5))
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0]["title"], "PART ONE")
        for i in range(5):
            self.assertIn(f"第{i}页正文内容", "".join(chapters[0]["paragraphs"]))

    def test_naturally_large_single_file_chapter_is_never_split(self):
        # v1 从不切天然很大的单文件章节，v2 也不应该因为新加的安全网就
        # 顺手把这类正常大章节切碎（反三国演义真实踩过的坑）。
        big_text = "正文内容。" * 3000
        book, items = _new_book([
            ("a.xhtml", f"<html><body><h1>第一章</h1><p>{big_text}</p></body></html>"),
        ])
        book.toc = (epub.Link("a.xhtml", "第一章", "a"),)
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0]["title"], "第一章")

    def test_oversized_same_label_merge_gets_split_with_numbered_titles(self):
        # 连续同标签合并出的巨型章节，超过阈值才切，标题带编号后缀。
        big_text = "正文内容。" * 3000
        pages = [(f"p{i}.xhtml", f"<html><body><h2>PART ONE</h2><p>{big_text}</p></body></html>") for i in range(4)]
        book, items = _new_book(pages)
        book.toc = tuple(epub.Link(f"p{i}.xhtml", "PART ONE", f"p{i}") for i in range(4))
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        self.assertGreater(len(chapters), 1)
        for idx, c in enumerate(chapters):
            self.assertEqual(c["title"], f"PART ONE ({idx + 1})")
        total_chars = sum(len(p) for c in chapters for p in c["paragraphs"])
        # 每一页自己的 <h2>PART ONE</h2> 标题文字也会被当成一个 heading
        # marker 计入 paragraphs（跟 v1 的抽取逻辑一致），所以除了正文本身
        # 还要再加上 4 次 "PART ONE" 标题的字数。
        self.assertEqual(total_chars, len(big_text) * 4 + len("PART ONE") * 4)

    def test_split_chapter_keeps_heading_text_in_paragraphs(self):
        # 回归：_v2_split_oversized 曾经重建 paragraphs 时只认 type=="text"，
        # 漏掉了 type=="heading" 的 block，导致切分后的章节比切分前少字。
        big_text = "正文内容。" * 3000
        pages = []
        for i in range(4):
            pages.append((
                f"p{i}.xhtml",
                f"<html><body><h2>PART ONE</h2><h3>小节标题{i}</h3><p>{big_text}</p></body></html>",
            ))
        book, items = _new_book(pages)
        book.toc = tuple(epub.Link(f"p{i}.xhtml", "PART ONE", f"p{i}") for i in range(4))
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        self.assertGreater(len(chapters), 1)
        all_paragraph_text = "".join(p for c in chapters for p in c["paragraphs"])
        for i in range(4):
            self.assertIn(f"小节标题{i}", all_paragraph_text)


class AnchorSplitTests(unittest.TestCase):
    def test_single_file_with_multiple_toc_anchors_splits_into_chapters(self):
        # 后资本主义时代真实案例的缩影：全书正文塞进一个物理文件，目录靠
        # 内部锚点(#xxx)区分好几个章节，而不是靠不同文件。之前完全没有按
        # 锚点切分的逻辑，这种书会被压成一整章、目录结构全部丢失。
        html = (
            "<html><body>"
            '<h1 id="c1">第一章 起点</h1><p>第一章正文内容。</p>'
            '<h1 id="c2">第二章 转折</h1><p>第二章正文内容。</p>'
            '<h1 id="c3">第三章 终局</h1><p>第三章正文内容。</p>'
            "</body></html>"
        )
        book, items = _new_book([("all.xhtml", html)])
        book.toc = (
            epub.Link("all.xhtml#c1", "第一章 起点", "c1"),
            epub.Link("all.xhtml#c2", "第二章 转折", "c2"),
            epub.Link("all.xhtml#c3", "第三章 终局", "c3"),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        self.assertEqual([c["title"] for c in chapters], ["第一章 起点", "第二章 转折", "第三章 终局"])
        self.assertIn("第一章正文内容", "".join(chapters[0]["paragraphs"]))
        self.assertIn("第二章正文内容", "".join(chapters[1]["paragraphs"]))
        self.assertIn("第三章正文内容", "".join(chapters[2]["paragraphs"]))

    def test_nested_toc_anchors_in_one_file_produce_two_level_grouping(self):
        # 一个物理文件里，目录节点有嵌套层级（部 > 章）全靠锚点区分——
        # 子树跨越多个不同锚点也该算分组，不能因为"只有1个文件"就不分组。
        html = (
            "<html><body>"
            '<h1 id="p1">第一部分</h1>'
            '<h2 id="c1">第一章</h2><p>第一章正文。</p>'
            '<h2 id="c2">第二章</h2><p>第二章正文。</p>'
            "</body></html>"
        )
        book, items = _new_book([("all.xhtml", html)])
        book.toc = (
            (epub.Section("第一部分", href="all.xhtml#p1"), (
                epub.Link("all.xhtml#c1", "第一章", "c1"),
                epub.Link("all.xhtml#c2", "第二章", "c2"),
            )),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        by_title = {c["title"]: c for c in chapters}
        self.assertEqual(by_title["第一章"]["group_path"], ["第一部分"])
        self.assertEqual(by_title["第二章"]["group_path"], ["第一部分"])

    def test_toc_like_split_fragment_keeps_its_image(self):
        # 真实案例（《反三国演义》）：单文件整本书按锚点切开后，末尾一段是
        # 制作组credits页，混着一份嵌入式重复目录列表（一堆"标题->本文档内
        # 部锚点"的链接，命中_is_toc_like_document）和2张真实装饰图。之前
        # 整段判定成目录页直接return None，图片被连累一起丢掉。这里验证：
        # 目录文字被过滤，图片还在。
        fake_jpg = b"\xff\xd8\xff" + b"0" * 2200  # 只看字节数，不需要真的能解码
        book, items = _new_book([
            ("all.xhtml", '<html><body><h1 id="c1">第一章</h1><p>第一章正文内容。</p></body></html>'),
        ])
        credits_item = epub.EpubHtml(title="credits", file_name="credits.xhtml", lang="zh")
        toc_links = "".join(f'<p><a href="all.xhtml#c1">这是嵌入式重复目录第{i}条标题文字</a></p>' for i in range(5))
        credits_item.content = (
            '<html><body><img src="logo.jpg"/>' + toc_links + "</body></html>"
        )
        img_item = epub.EpubItem(file_name="logo.jpg", media_type="image/jpeg", content=fake_jpg)
        book.add_item(credits_item)
        book.add_item(img_item)
        items.append(credits_item)
        book.toc = (
            epub.Link("all.xhtml#c1", "第一章", "c1"),
            epub.Link("credits.xhtml", "制作组信息", "credits"),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        all_images = [b for c in chapters for b in c["blocks"] if b["type"] == "image"]
        self.assertEqual(len(all_images), 1)
        self.assertNotIn("嵌入式重复目录", "".join(p for c in chapters for p in c["paragraphs"]))

    def test_heading_only_anchor_fragment_is_not_silently_dropped(self):
        # 真实案例（《宋史》等多本样书）：按锚点切出来的某一段可能只有一个
        # 小节标题、旁边紧跟的正文属于下一刀之后的内容，这一段自己没有
        # type=="text"的block——之前 has_text 判断只认"text"不认"heading"，
        # 会把这种"纯标题段"整段判定成空内容直接丢弃，标题本身也消失了。
        html = (
            "<html><body>"
            '<h1 id="c1">第一章</h1>'
            '<h2 id="s1">第一节 纯标题小节</h2>'
            '<h2 id="s2">第二节 有正文的小节</h2><p>第二节正文内容。</p>'
            "</body></html>"
        )
        book, items = _new_book([("all.xhtml", html)])
        book.toc = (
            epub.Link("all.xhtml#c1", "第一章", "c1"),
            epub.Link("all.xhtml#s1", "第一节 纯标题小节", "s1"),
            epub.Link("all.xhtml#s2", "第二节 有正文的小节", "s2"),
        )
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)

        titles = [c["title"] for c in chapters]
        self.assertIn("第一节 纯标题小节", titles)
        self.assertIn("第二节 有正文的小节", titles)


class UrlEncodedHrefTests(unittest.TestCase):
    def test_url_encoded_toc_href_still_resolves(self):
        # 火与冰真实案例：TOC href 是百分号编码，item.get_name() 是解码后的
        # 文件名，不 unquote 就完全匹配不上，整本书目录“隐形”。
        book, items = _new_book([
            ("Chapter One.xhtml", "<html><body><h1>第一章</h1><p>正文</p></body></html>"),
        ])
        book.toc = (epub.Link("Chapter%20One.xhtml", "第一章", "a"),)
        book.spine = ["nav"] + items
        chapters = _write_and_build(book)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0]["title"], "第一章")


if __name__ == "__main__":
    unittest.main()
