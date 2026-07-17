# 内容筹备（阶段二）

v1 首发书库，来源：[Project Gutenberg](https://www.gutenberg.org/)（公版，零版权风险）。

| 文件 | 说明 |
|---|---|
| `daodejing.epub` / `lunyu.epub` / `mengzi.epub` / `mozi.epub` | 原始下载文件，保留作为可追溯来源 |
| `*_clean.epub` | 重新打包后的干净EPUB，**这些才是实际导入书库用的文件** |
| `repackage_gutenberg_epub.py` | 重新打包脚本，见脚本内文档字符串了解为什么需要这一步、章节切分规则怎么定的 |

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
