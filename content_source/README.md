# 内容筹备（阶段二）

v1 首发书库，来源：[Project Gutenberg](https://www.gutenberg.org/)（公版，零版权风险）。

| 文件 | 说明 |
|---|---|
| `daodejing.epub` / `lunyu.epub` | 原始下载文件，保留作为可追溯来源 |
| `daodejing_clean.epub` / `lunyu_clean.epub` | 重新打包后的干净EPUB，**这两个才是实际导入书库用的文件** |
| `repackage_gutenberg_epub.py` | 重新打包脚本，见脚本内文档字符串了解为什么需要这一步、章节切分规则怎么定的 |

## 为什么原始文件不能直接导入

Gutenberg 中文公版书正文塞在同一个HTML文件里、官方目录本身是坏的，不满足现有
`import_book` 接口"按章节文件+能用目录"解析的假设。详见
`docs/学习笔记/03-EPUB书库渲染与划线定位.md` 里的"现实教训"一节。

## 依赖

脚本需要 `beautifulsoup4`（`pip install beautifulsoup4`），这是内容筹备阶段的一次性
工具，不是线上API运行依赖，所以没有放进 `api/requirements.txt`。

## 以后新增书目

参考这个脚本的思路：先检查目标EPUB是否已经按章节正常拆分（大部分正规出版的EPUB
不会有这个问题，Gutenberg是特例），有问题再照着这里的级联检测规则调整。
