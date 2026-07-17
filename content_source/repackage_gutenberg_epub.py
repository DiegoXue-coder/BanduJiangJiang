"""
把 Project Gutenberg 中文公版书（正文塞在单个HTML文件里、没有真正章节文件）
重新打包成按章节拆分的干净 EPUB，供 /app/books/import 正式导入使用。

背景（详见 docs/学习笔记/03-EPUB书库渲染与划线定位.md 里"现实教训"一节）：
Gutenberg 的中文公版书是志愿者用自动化脚本转换的，几十年下来产出的文件结构并不
工整——整本书正文塞在同一个 HTML 文件里，官方目录(toc)本身也是坏的（只登记了
版权页）。要让现有的 import_book 正常工作（依赖真正独立的章节文件+能用的目录），
需要先把这种"扁平"格式重新切分打包。

级联式章节边界检测（按可靠程度从高到低，用户拍板确定的顺序）：
1. EPUB 自带官方目录 —— 本脚本处理的书目录本身是坏的，跳过
2. 语义化标题标签 <h1>-<h6> 或 id 属性 —— 实测这两本书里没有可用的（只有版权页
   标题用了h2），回退到3
3. 命名锚点（如 pgepubid）—— 实测也没有，回退到4
4. 启发式兜底 —— 实测两轮调整：
   a) 先试过 CSS 样式匹配（margin-top）：《道德经》81章只切出7章，漏检严重，弃用
   b) 改用"字数很短的独立段落"：《道德经》完美命中全部81章+2个分卷标题；但同样
      规则用在《论语》上，会把"20. 子不語怪力亂神。"这类字数恰好也短的"编号语录"
      误判成标题
   c) 最终方案：短段落 **且包含"第"字** —— 真正的章节标题都是"第一章"/"學而第一"
      这类含"第"的格式，编号语录是"阿拉伯数字+句号"开头，不含"第"，加这个条件后
      两本书都精确切分（道德经81章、论语20篇，与传世版本篇章结构完全吻合，人工
      核对过标题列表和首尾章节正文内容）

这不是通用算法，是针对这两本具体的书调出来的经验规则——以后新书如果结构不同，
需要重新观察、重新调整，不追求一次性写出"放之四海皆准"的方案。

2026-07-17（阶段六）新增：切分完成后统一转成简体（`opencc-python-reimplemented`，
t2s 配置）。转换放在切分之后，不改动已经调好的繁体文本切分规则；只转标题和正文，
不影响判断"第"字的逻辑（简繁体"第"字写法相同）。
"""
import sys
from bs4 import BeautifulSoup
import ebooklib
from ebooklib import epub
from opencc import OpenCC

_T2S = OpenCC("t2s")


def find_body_item(book):
    """找到含正文的文档项：排除明显是版权/许可的部分。"""
    candidates = [
        item for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT)
        if item.get_id() not in ("pg-footer", "ncx", "coverpage-wrapper")
    ]
    # 正文通常是内容最长的那个文档项
    return max(candidates, key=lambda it: len(it.get_content()))


def strip_gutenberg_boilerplate(soup):
    """去掉 Gutenberg 头部样板文字（版权声明、书名信息），只留正文。"""
    header = soup.find("header", {"id": "pg-header"})
    if header:
        header.decompose()
    return soup


def split_by_short_titled_paragraph(soup, max_title_len=12):
    """级联第4层兜底：短段落 + 含"第"字 = 章节标题（详见模块docstring）。"""
    body = soup.find("body") or soup
    all_ps = body.find_all("p", recursive=True)

    sections = []  # [(title, [content_html, ...])]
    current_title = None
    current_content = []

    for p in all_ps:
        text = p.get_text(strip=True)
        if not text:
            continue
        is_heading = len(text) <= max_title_len and "第" in text
        if is_heading:
            if current_title is not None:
                sections.append((current_title, current_content))
            current_title = text
            current_content = []
        else:
            current_content.append(str(p))

    if current_title is not None:
        sections.append((current_title, current_content))
    return sections


def repackage(src_path, dst_path, book_title, author):
    src_book = epub.read_epub(src_path)
    body_item = find_body_item(src_book)
    html = body_item.get_content().decode("utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")
    soup = strip_gutenberg_boilerplate(soup)

    # 章节切分规则是照着 Gutenberg 原始繁体文本调出来的（"第"字判断等），
    # 所以先切分、再转简体，不去动切分逻辑本身。
    sections = split_by_short_titled_paragraph(soup)
    total_detected = len(sections)
    empty_titles = [t for t, c in sections if not c]
    sections = [(t, c) for t, c in sections if c]  # 过滤掉无正文的分卷标题类条目

    print(f"[{book_title}] 检测到 {total_detected} 个片段，"
          f"过滤掉 {len(empty_titles)} 个无正文的分卷标题({empty_titles})，"
          f"剩余 {len(sections)} 个真正章节")

    book_title = _T2S.convert(book_title)
    author = _T2S.convert(author)
    sections = [(_T2S.convert(t), [_T2S.convert(html) for html in c]) for t, c in sections]

    new_book = epub.EpubBook()
    new_book.set_identifier(f"repackaged-{book_title}")
    new_book.set_title(book_title)
    new_book.set_language("zh")
    new_book.add_author(author)

    chapters = []
    for idx, (title, content_htmls) in enumerate(sections):
        c = epub.EpubHtml(title=title, file_name=f"chap_{idx:03d}.xhtml", lang="zh")
        c.content = f"<h1>{title}</h1>" + "".join(content_htmls)
        new_book.add_item(c)
        chapters.append(c)

    new_book.toc = tuple(chapters)
    new_book.add_item(epub.EpubNcx())
    new_book.add_item(epub.EpubNav())
    new_book.spine = ["nav"] + chapters

    epub.write_epub(dst_path, new_book)
    print(f"[{book_title}] 已生成: {dst_path}")
    return sections


if __name__ == "__main__":
    src, dst, title, author = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    sections = repackage(src, dst, title, author)
    print(f"\n--- 全部 {len(sections)} 个章节标题 ---")
    for i, (t, _) in enumerate(sections):
        print(f"  [{i}] {t}")
