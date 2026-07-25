"""
从 zh.wikisource.org（维基文库）抓取公版古籍原文，打包成干净EPUB，供
/app/books/import 使用。

背景：庄子/大学/中庸这三本书 Project Gutenberg 没有干净的原文版本（庄子只有
英译本和现代人写的故事改编；大学/中庸 Gutenberg 完全没收录），改用维基文库——
协议 CC BY-SA 4.0，明确允许转载（跟 Gutenberg 的纯公版声明不完全一样，转载需要
署名，已经在书籍作者字段里体现来源）。注意：另一个候选 ctext.org 网站条款明确
禁止自动化下载工具，没有采用。

用 MediaWiki 官方 API 的 `action=query&prop=extracts&explaintext=1`
（TextExtracts 扩展）取纯文本，不用 ws-export 导出工具——那个工具有 Anubis
反爬虫防护会拦掉自动化请求，直接调 API 才是对维基站点友好的方式。

两种书的结构不一样：
- 《庄子》：内外杂三篇共33个独立子页面（如"莊子/逍遙遊"），每个子页面对应一章，
  需要先从目录页wikitext里解析出子页面链接列表，再逐个调API取正文
- 《大学》《中庸》：单页存在于《礼记》原文（不含朱熹章句集注的评注），按API
  返回的自然段落切分成章节，不追求精确复现某个后世注疏版本的章节编号
"""
import re
import time
import urllib.request
import urllib.parse
import urllib.error
import json

from opencc import OpenCC
from ebooklib import epub

_T2S = OpenCC("t2s")
API = "https://zh.wikisource.org/w/api.php"


def _api_get(params, retries=5):
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "BanduJiangJiang-content-prep/1.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                wait = 5 * (attempt + 1)
                print(f"  429限流，等待{wait}秒重试...")
                time.sleep(wait)
                continue
            raise


def fetch_wikitext(title):
    data = _api_get({
        "action": "query", "titles": title, "prop": "revisions",
        "rvprop": "content", "format": "json",
    })
    page = next(iter(data["query"]["pages"].values()))
    return page["revisions"][0]["*"]


def fetch_extract(title):
    """取某一页去除wiki标记后的纯文本。"""
    data = _api_get({
        "action": "query", "titles": title, "prop": "extracts",
        "explaintext": 1, "format": "json",
    })
    page = next(iter(data["query"]["pages"].values()))
    return page.get("extract", "")


def parse_subpage_links(index_title):
    """从目录页wikitext里解析出 [[/子页面|显示标题]] 这种链接，按出现顺序返回。"""
    wikitext = fetch_wikitext(index_title)
    return re.findall(r"\[\[/([^|\]]+)\|([^\]]+)\]\]", wikitext)


def build_epub(dst_path, book_title, author, chapters):
    """chapters: [(title, plain_text), ...]，统一在这里转简体、写EPUB。"""
    book_title_s = _T2S.convert(book_title)
    author_s = _T2S.convert(author)

    new_book = epub.EpubBook()
    new_book.set_identifier(f"wikisource-{book_title_s}")
    new_book.set_title(book_title_s)
    new_book.set_language("zh")
    new_book.add_author(author_s)

    items = []
    for idx, (title, text) in enumerate(chapters):
        title_s = _T2S.convert(title)
        text_s = _T2S.convert(text)
        # 部分维基文库页面在正文里重复了一遍"==标题=="这种wiki标题标记，
        # TextExtracts转纯文本后会变成"= 标题 ="这一行，跟我们自己加的<h1>
        # 标题重复，过滤掉这种独占一行的"= ... ="标记行。
        lines = [p for p in text_s.split("\n") if p.strip() and not re.match(r"^=+.+=+$", p.strip())]
        paragraphs_html = "".join(f"<p>{p}</p>" for p in lines)
        c = epub.EpubHtml(title=title_s, file_name=f"chap_{idx:03d}.xhtml", lang="zh")
        c.content = f"<h1>{title_s}</h1>{paragraphs_html}"
        new_book.add_item(c)
        items.append(c)

    new_book.toc = tuple(items)
    new_book.add_item(epub.EpubNcx())
    new_book.add_item(epub.EpubNav())
    new_book.spine = ["nav"] + items

    epub.write_epub(dst_path, new_book)
    print(f"[{book_title_s}] 已生成 {len(items)} 章: {dst_path}")


def build_multi_page_book(index_title, dst_path, book_title, author):
    """《庄子》这种：目录页链接到多个子页面，每个子页面是一章。"""
    links = parse_subpage_links(index_title)
    chapters = []
    for sub, display_title in links:
        full_title = f"{index_title}/{sub}"
        text = fetch_extract(full_title)
        chapters.append((display_title, text))
        time.sleep(2)  # 对维基站点友好一点，不要连续高频请求（实测0.5秒会被429限流）
    build_epub(dst_path, book_title, author, chapters)
    return chapters


# 阶段十一排查"划线选字成功率因书而异"发现：《中庸》比《大学》明显更容易
# 选字失败，对比两本书实际生成的EPUB章节HTML，两者markup结构（单个<h1>+
# 若干<p>）完全一样，唯一实质差异是章节切分粒度——原来"每个自然段落独立成一
# 章"这个规则不设下限，《中庸》按wikisource原文的自然分段切出34章、平均400字/
# 章、其中4章不到100字（最短仅37字）；《大学》切出11章、平均603字/章、最短
# 也有118字。过短的单段文字块独立成一个WebView渲染单元后，长按拖动选字明显
# 更容易触发已知的"250ms防抖+selectionchange事件时机不稳定"这个epub.js底层
# 限制——不是《中庸》这本书本身有什么特殊问题，是切分规则对短段落不友好。
# 用一个最小字数合并短段落，不再无脑按每个自然段落独立切章。
MIN_CHAPTER_CHARS = 150


def _merge_short_paragraphs(paragraphs, min_chars=MIN_CHAPTER_CHARS):
    """把过短的自然段落并入相邻段落，直到攒够 min_chars 才切出一章。
    结尾如果还剩一截不够长的尾巴，并进上一章（没有上一章就单独成章，
    避免整本书内容量本来就很少时反而合并出0章）。
    """
    merged = []
    buffer = ""
    for p in paragraphs:
        buffer = f"{buffer}\n{p}" if buffer else p
        if len(buffer) >= min_chars:
            merged.append(buffer)
            buffer = ""
    if buffer:
        if merged:
            merged[-1] = f"{merged[-1]}\n{buffer}"
        else:
            merged.append(buffer)
    return merged


def build_single_page_book(page_title, dst_path, book_title, author):
    """《大学》《中庸》这种：单页原文，按API返回的自然段落切成章节，段落
    过短的先合并（见 MIN_CHAPTER_CHARS 注释），避免切出选字体验很差的短章节。
    """
    text = fetch_extract(page_title)
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    paragraphs = _merge_short_paragraphs(paragraphs)
    chapters = [(f"第{i+1}节", p) for i, p in enumerate(paragraphs)]
    build_epub(dst_path, book_title, author, chapters)
    return chapters


if __name__ == "__main__":
    print("=== 庄子 ===")
    build_multi_page_book("莊子", "zhuangzi_clean.epub", "莊子", "莊子")

    print("\n=== 大学 ===")
    build_single_page_book("禮記/大學", "daxue_clean.epub", "大學", "曾子")

    print("\n=== 中庸 ===")
    build_single_page_book("禮記/中庸", "zhongyong_clean.epub", "中庸", "子思")
