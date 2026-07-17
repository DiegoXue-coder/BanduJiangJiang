# 内容筹备（阶段二 + 阶段六）

v1 首发书库 4 本来源：[Project Gutenberg](https://www.gutenberg.org/)（道德经/论语/孟子/墨子，
公版，零版权风险）。阶段六新增 3 本（庄子/大学/中庸）来源改用
[zh.wikisource.org](https://zh.wikisource.org)（维基文库）——Gutenberg 没有这三本干净的
原文版本，见下方"阶段六：为什么庄子/大学/中庸换了个源"。

| 文件 | 说明 |
|---|---|
| `daodejing.epub` / `lunyu.epub` / `mengzi.epub` / `mozi.epub` | Gutenberg 原始下载文件，保留作为可追溯来源 |
| `*_clean.epub` | 重新打包后的干净EPUB，**这些才是实际导入书库用的文件** |
| `repackage_gutenberg_epub.py` | Gutenberg 书重新打包脚本，见脚本内文档字符串了解为什么需要这一步、章节切分规则怎么定的 |
| `wikisource_to_epub.py` | 维基文库抓取脚本，庄子/大学/中庸用这个，不经过 `repackage_gutenberg_epub.py` |

## 阶段六：为什么庄子/大学/中庸换了个源

Gutenberg 上：庄子只有英译本和一本现代人写的寓言故事集（作者二十世纪人，版权状态
存疑，不算公版），大学/中庸完全没收录。查了两个备选：

- **ctext.org**（中国哲学书电子化计划）：三篇原文都有，但网站条款明确写着"禁止
  自动化下载工具，违者直接封禁"——没有采用，这是网站白纸黑字禁止爬虫
- **zh.wikisource.org**（维基文库）：三篇原文都有，协议 CC BY-SA 4.0 明确允许转载
  （转载需署名，作者字段已体现来源），而且是标准 MediaWiki 站点，直接调
  `action=query&prop=extracts` 官方 API 取纯文本，不算爬虫，对站点友好——采用这个

`wikisource_to_epub.py` 里庄子走"目录页解析子页面链接+逐页抓取"（33个独立页面对应
33章），大学/中庸走"单页原文按自然段落切章节"（不追求复现某个后世注疏版本的章节
编号，比如朱熹《四书章句集注》那版——那版夹杂了大量注释，不是纯原文，特意选了
《礼记》里的原始版本）。抓取时注意限速（实测 0.5 秒间隔会被 429 限流，改成 2 秒
+ 失败退避重试）。

## 每本书的切分策略不一样（阶段六新增孟子/墨子后的教训）

Gutenberg 的中文公版书不是同一个转换脚本产出的，几本书的 HTML 结构互不相同，
`repackage_gutenberg_epub.py` 里对应留了三种切分函数，**新书导入前先看清楚结构再选**：

- `split_by_short_titled_paragraph`（道德经/论语用）：章节标题独占一个`<p>`，
  短且含"第"字
- `split_by_line_pattern`（孟子用）：标题和正文挤在同一个`<p>`里（一个`<p>`可能
  装了好几个章节），只能按文字行用正则找标题行（孟子是"卷之X某某上/下"）
- `split_by_bracketed_title_paragraph`（墨子用）：章节标题独占一个`<p>`，格式是
  "《标题》"，不需要长度+"第"字那套启发式，这本书结构最干净

孟子/墨子不能直接用 CLI（`python repackage_gutenberg_epub.py ...`默认走第一种），
要在 Python 里 `import repackage_gutenberg_epub` 后手动传 `split_fn` 参数调用
`repackage()`，具体写法参考阶段六开发记录。

## 为什么原始文件不能直接导入

Gutenberg 中文公版书正文塞在同一个HTML文件里、官方目录本身是坏的，不满足现有
`import_book` 接口"按章节文件+能用目录"解析的假设。详见
`docs/学习笔记/03-EPUB书库渲染与划线定位.md` 里的"现实教训"一节。

## 依赖

脚本需要 `beautifulsoup4` 和 `opencc-python-reimplemented`（繁体转简体，阶段六新增），
`pip install beautifulsoup4 opencc-python-reimplemented`。这是内容筹备阶段的一次性
工具，不是线上API运行依赖，所以没有放进 `api/requirements.txt`。

## 以后新增书目

参考这个脚本的思路：先检查目标EPUB是否已经按章节正常拆分（大部分正规出版的EPUB
不会有这个问题，Gutenberg是特例），有问题再照着这里的级联检测规则调整。
