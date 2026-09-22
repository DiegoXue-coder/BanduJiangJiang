"""EPUB 目录混合解析原型（A+B+C），供 tools/epub_toc_audit/audit.py 使用。

按 docs/学习笔记/09-导入EPUB目录拆分方案.md 的推荐方向实现，**不修改**
`api/main.py` 里线上正在用的 `_build_standard_reading_chapters`——这里是
另一套独立的实验性解析路径，只在离线测试工具里跑，从不接触生产库/生产
接口。

核心原则："TOC 决定语义，spine 保证内容不丢，href/锚点建立二者的对应
关系"（继承自 09 号文档的结论，不重新发明）。已知的两个失败模式，及这版
如何避开：

1. 直接复用 `_epub_book_to_chapters_via_toc`：把一个顶层 TOC 条目的整棵
   子树内容合并成一章，5 册合集会被合并成 5 个巨章。**这里改成"文件级
   粒度"**：最终章节列表始终是"一个物理 spine 文件 = 一个条目"（跟生产
   算法的粒度一致，不会重新引入巨章问题），TOC 只用来决定"这个文件该叫
   什么标题、该挂在哪个分组下面"，不负责合并文件。
2. 只读 TOC 引用的文件：《原则》这样的书，TOC 外还有上千字的真实正文。
   **这里始终以 spine 顺序遍历全部文件**，未被 TOC 引用的文件按规则就近
   归入相邻分组，不会被吞掉。

分组判定（"册/部"当分组标题，"章"保持可点，尽量对应 A+B+C 里的 C）：
对 TOC 树里的每个节点，算出它子树覆盖的"物理文件集合"（不同锚点指向
同一文件按同一个文件算）。子树只覆盖 1 个文件 → 这个节点本身就是一个
普通"叶子"（章节），不是分组；子树覆盖 >1 个文件 → 这个节点是"分组"
（册/部这一类），它的标题变成子孙文件的 group_path 前缀，它自己不再是
一条可独立点开的正文。

每个物理文件最终的"标题+分组"这样定：收集所有指向它的 TOC 节点，优先用
其中"没有子节点的叶子节点"里最深的那个当标题（最具体）；如果所有指向
它的节点都是"分组节点"（没有叶子直接指向它——常见于"分组标题页正好
等于第一个子章节的文件"，或者一个纯粹的分卷说明页），退一步用其中最
浅的那个节点自己的标题当标题，它自己就是本分组下的一条内容（比如"第一
部分"说明页），不再往下多分一层。group_path 只保留链路上"真正是分组"
的祖先标题，跳过"只指向自己、子树只有一个文件"的祖先。

TOC 没引用到的文件（含完全没有 TOC 的书）：沿用生产算法同一套"是不是
目录页"判断跳过目录页，其余文件就近挂在前一个已确定分组下面；找不到
真实标题时标注"低置信度占位"，**不生成任何 `第N章` 这种编造标题**
（生产算法会生成，这是要避免的旧行为之一）。
"""
from __future__ import annotations

import sys
import urllib.parse
from dataclasses import dataclass, field

from bs4 import BeautifulSoup

# 复用生产环境已经用、且验证过的抽取/判断逻辑，不重新发明一遍：
# _decode_epub_html（老书常见 GBK/Big5 的解码兜底）、_is_toc_like_document
# （<nav>/内部链接占比识别目录页）、_epub_doc_to_marker_paragraphs +
# _markers_to_standard_content（标题/表格/图片 marker 化再还原成 blocks，
# 跟标准阅读现在用的是同一套）。
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
from api.main import (  # noqa: E402
    _decode_epub_html,
    _is_toc_like_document,
    _epub_doc_to_marker_paragraphs,
    _markers_to_standard_content,
)

SHORT_CHAPTER_CHARS = 200  # 跟 09 号文档统一口径，只作为"需要人工看一眼"的信号，不是删除线
ORPHAN_TINY_CHARS = 40  # 低于这个字数且没有标题/媒体的孤立文件，标为"疑似分隔页"而不是硬造标题


def _norm_href(raw: str) -> tuple[str, str]:
    """TOC（NCX/nav）里的 href 常按规范做了 URL 百分号编码（比如文件名带空格时
    写成 `Huo%20Yu%20Bing...`），但 `item.get_name()` 拿到的是解码后的真实文件名
    （`Huo Yu Bing...`）。之前没做这一步解码，导致这类书**所有** TOC 节点都对不上
    任何 spine 文件，退化成"TOC 形同虚设"（真实案例：《火与冰》51 章全部判定成
    "TOC 没引用"，明明这本书的 TOC 结构完整）。这里统一解码后再比较。"""
    raw = raw or ""
    if "#" in raw:
        href, anchor = raw.split("#", 1)
    else:
        href, anchor = raw, ""
    href = urllib.parse.unquote(href)
    anchor = urllib.parse.unquote(anchor)
    return href, anchor


@dataclass
class TocNode:
    title: str
    href: str
    anchor: str
    depth: int
    parent: "TocNode | None" = None
    children: list["TocNode"] = field(default_factory=list)
    is_leaf: bool = True  # 没有子节点的 TOC 节点（ebooklib 的 Link，或没配对子列表的 Section）
    subtree_hrefs: set = field(default_factory=set)  # 后序遍历补齐

    @property
    def is_group(self) -> bool:
        # 只有"自己带子节点、子树横跨不止一个物理文件"才算分组（册/部）；
        # 子树只覆盖自己这一个文件的节点，哪怕它是 Section，也只是普通叶子章节。
        return (not self.is_leaf) and len(self.subtree_hrefs) > 1

    def group_ancestors(self) -> list["TocNode"]:
        chain = []
        node = self.parent
        while node is not None:
            if node.is_group:
                chain.append(node)
            node = node.parent
        chain.reverse()
        return chain


def _toc_node_href_title(raw_node):
    n = raw_node[0] if isinstance(raw_node, tuple) else raw_node
    href_full = getattr(n, "href", None) or getattr(n, "file_name", None) or ""
    title = getattr(n, "title", "") or ""
    href, anchor = _norm_href(href_full)
    return href, anchor, title


def build_toc_tree(book) -> list[TocNode]:
    """把 ebooklib 的 book.toc（tuple/Link 混合结构）转成自己的 TocNode 树，
    并做一次后序遍历把每个节点的 subtree_hrefs 填好，供 is_group 判定用。"""
    roots: list[TocNode] = []

    def walk(raw_nodes, parent, depth):
        out = []
        for raw in raw_nodes:
            href, anchor, title = _toc_node_href_title(raw)
            is_tuple = isinstance(raw, tuple)
            node = TocNode(title=title, href=href, anchor=anchor, depth=depth, parent=parent, is_leaf=not is_tuple)
            if is_tuple:
                node.children = walk(raw[1], node, depth + 1)
            out.append(node)
        return out

    roots = walk(list(book.toc or []), None, 0)

    def fill_subtree(node: TocNode):
        hrefs = {node.href} if node.href else set()
        for child in node.children:
            fill_subtree(child)
            hrefs |= child.subtree_hrefs
        node.subtree_hrefs = hrefs

    for r in roots:
        fill_subtree(r)
    return roots


def flatten(nodes: list[TocNode]) -> list[TocNode]:
    out = []
    for n in nodes:
        out.append(n)
        out.extend(flatten(n.children))
    return out


def resolve_file_assignment(all_nodes: list[TocNode]) -> dict:
    """每个被 TOC 引用过的 href，决定它的标题来自哪个 TOC 节点、分组路径是什么。
    返回 {href: {"title_node": TocNode|None, "group_path": [str], "referenced": True}}。"""
    by_href: dict[str, list[TocNode]] = {}
    for n in all_nodes:
        if not n.href:
            continue
        by_href.setdefault(n.href, []).append(n)

    assignment = {}
    for href, nodes in by_href.items():
        leaves = [n for n in nodes if n.is_leaf]
        if leaves:
            # 最具体：同一批叶子节点里选深度最大的（多个锚点指向同一文件时，
            # 通常最深的那个才是真正的章节入口，浅的那个可能是分组顺手挂过来的）
            chosen = max(leaves, key=lambda n: n.depth)
        else:
            # 全都是"分组自己的 href"（没有叶子单独指向它）：用最浅的一个，
            # 它自己就是这一分组下的一条内容（比如"第一部分"说明页）
            chosen = min(nodes, key=lambda n: n.depth)
        group_path = [g.title for g in chosen.group_ancestors() if g.title]
        assignment[href] = {"title": chosen.title, "group_path": group_path, "referenced": True}
    return assignment


def _extract_doc(book, item):
    """跟生产 `_build_standard_reading_chapters` 完全同一套抽取逻辑，保证
    两边字数/图片/表格数可以直接比较，差异只来自"怎么分组、怎么起标题"。"""
    soup = BeautifulSoup(_decode_epub_html(item.get_content()), "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    if _is_toc_like_document(soup):
        return None
    heading = soup.find(["h1", "h2", "h3"])
    own_title = heading.get_text(" ", strip=True) if heading else ""
    markers = _epub_doc_to_marker_paragraphs(book, item, soup)
    paragraphs, blocks = _markers_to_standard_content(markers)
    body = soup.body or soup
    full_text = body.get_text(" ", strip=True)
    extracted_chars = sum(len(p) for p in paragraphs)
    if full_text and extracted_chars < len(full_text) * 0.6:
        paragraphs = [full_text]
        blocks = [{"type": "text", "text": full_text}] + [b for b in blocks if b["type"] in ("image", "table")]
    has_media = any(b["type"] in ("image", "table") for b in blocks)
    has_text = any(b["type"] == "text" and b["text"].strip() for b in blocks)
    if not has_text and not has_media:
        return None
    return {"own_title": own_title, "paragraphs": paragraphs, "blocks": blocks}


def run_hybrid(book, doc_items: list) -> list[dict]:
    """doc_items：跟生产算法一样，已经排除 EpubNav 的 spine 文档列表（保持 spine 顺序）。
    返回按 spine 顺序排列的章节列表，每条带 title/group_path/blocks/低置信度标记。"""
    toc_roots = build_toc_tree(book)
    all_nodes = flatten(toc_roots)
    assignment = resolve_file_assignment(all_nodes)

    chapters = []
    last_group_path: list[str] = []
    for idx, item in enumerate(doc_items):
        try:
            extracted = _extract_doc(book, item)
        except Exception as e:  # noqa: BLE001 — 单个文件解析失败不能拖垮整本书
            extracted = None
            parse_error = str(e)
        else:
            parse_error = None
        if extracted is None:
            if parse_error:
                chapters.append({
                    "source_href": item.get_name(),
                    "title": "（解析失败）",
                    "group_path": list(last_group_path),
                    "paragraphs": [], "blocks": [],
                    "toc_referenced": False, "low_confidence": True, "parse_error": parse_error,
                })
            continue  # 目录页/纯空白页，跳过（跟生产算法一致，不占章节）

        href = item.get_name()
        meta = assignment.get(href)
        if meta:
            title = meta["title"] or extracted["own_title"]
            group_path = meta["group_path"]
            low_confidence = not bool(title)
            if not title:
                title = extracted["own_title"] or f"（无标题，spine 第{idx + 1}篇）"
            last_group_path = group_path
            toc_referenced = True
        else:
            # 孤立文件：TOC 完全没提到它。标题用自己的标题标签；没有的话
            # 不编造"第N章"，就近挂在上一个已确定的分组下面，标低置信度。
            text_len = sum(len(p) for p in extracted["paragraphs"])
            has_media = any(b["type"] in ("image", "table") for b in extracted["blocks"])
            title = extracted["own_title"]
            if not title:
                title = f"（无标题，spine 第{idx + 1}篇）"
            group_path = list(last_group_path)
            low_confidence = True
            toc_referenced = False
            if not extracted["own_title"] and text_len < ORPHAN_TINY_CHARS and not has_media:
                title = f"（疑似分隔页，spine 第{idx + 1}篇）"

        chapters.append({
            "source_href": href,
            "title": title,
            "group_path": group_path,
            "paragraphs": extracted["paragraphs"],
            "blocks": extracted["blocks"],
            "toc_referenced": toc_referenced,
            "low_confidence": low_confidence,
        })

    # 没有任何有效 TOC 的书：assignment 为空，上面循环会让每一章都走"孤立文件"
    # 分支，但仍然保留 spine 顺序、仍然抽取全部正文——对应"无有效 TOC 时必须
    # 可靠降级到 spine + 文档标题模式，不能导入失败"这条要求。
    return chapters


def toc_raw_stats(book) -> dict:
    """原始 TOC 结构统计：给报告用，不依赖上面的分组/选择逻辑。"""
    roots = build_toc_tree(book)
    nodes = flatten(roots)
    depth_counts: dict[int, int] = {}
    for n in nodes:
        depth_counts[n.depth] = depth_counts.get(n.depth, 0) + 1
    unique_files = {n.href for n in nodes if n.href}
    max_depth = max((n.depth for n in nodes), default=-1)
    group_count = sum(1 for n in nodes if n.is_group)
    return {
        "total_entries": len(nodes),
        "depth_counts": depth_counts,
        "max_depth": max_depth,
        "unique_files_referenced": len(unique_files),
        "group_node_count": group_count,
        "referenced_hrefs": unique_files,
    }
