"""把阅读器正文字体（宋/黑/楷）从完整版裁成"子集版"。

为什么要裁：完整字体 10~25MB，安卓 WebView 里内联/加载会失败或极慢（实测 HTML 体积
超过约 14MB 就加载不出来，34MB 的楷体甚至让进程被杀）。裁成常用字集后每个约 3~5MB，
用本地文件方式加载与"不加载字体"几乎同速。详见 docs/项目管理/04-开发进度记录.md
"[Android] 阅读器字体修复"一条。

字符集（缺字回退策略）：
  - GB2312 一二级汉字 6763 个
  - Big5 常用+次常用汉字 5495 个（覆盖常见繁体）
  - ASCII、CJK 标点、全角形式、通用标点、带圈数字、罗马数字、常见符号
  三个字体对上面这些字符 100% 覆盖（脚本会打印覆盖率，不足会报错）。
  字符集之外的生僻字：CSS 字体栈里正文字体后面跟系统中文字体，浏览器会**逐字**回退到
  系统字体显示，不会出空白方块（系统也没有的极少数字才会是豆腐块，与改造前一致）。

许可证：三款字体均为 SIL OFL 1.1（思源宋体/黑体、霞鹜文楷），允许子集化再分发；
保留 name 表里的版权与许可证记录（name ID 0/13/14），许可证全文在 assets/fonts/OFL-LICENSE.txt。

用法（需要 pip install fonttools）：
    python mobile/scripts/subset_reader_fonts.py
输入：mobile/assets/fonts-full/*.ttf（完整版，不会被打包进 App）
输出：mobile/assets/fonts/*.ttf（同名子集版，被 App 使用）
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "fonts-full"))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "fonts"))
FONTS = [
    "SourceHanSerifSC-Regular.ttf",  # 宋体
    "SourceHanSansSC-Regular.ttf",   # 黑体
    "LXGWWenKai-Regular.ttf",        # 楷体
]


def gb2312_hanzi():
    out = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def big5_hanzi():
    out = []
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            try:
                out.append(bytes([hi, lo]).decode("big5"))
            except UnicodeDecodeError:
                pass
    return out


def punctuation_and_symbols():
    chars = [chr(c) for c in range(0x20, 0x7F)]       # ASCII
    chars += [chr(c) for c in range(0x3000, 0x3040)]  # CJK 标点
    chars += [chr(c) for c in range(0xFF00, 0xFFF0)]  # 全角形式
    chars += [chr(c) for c in range(0x2010, 0x2030)]  # 通用标点（— ‘ ’ “ ” …）
    chars += [chr(c) for c in range(0x2460, 0x24A0)]  # 带圈数字
    chars += [chr(c) for c in range(0x2160, 0x2180)]  # 罗马数字
    chars += list("×÷±°℃‰§¶·•→←↑↓≤≥≠≈∞√")
    return chars


def main():
    hanzi = gb2312_hanzi() + big5_hanzi()
    text = "".join(dict.fromkeys(hanzi + punctuation_and_symbols()))
    print(f"目标字符数: {len(text)}（汉字 {len(set(hanzi))}）")

    for name in FONTS:
        src = os.path.join(SRC_DIR, name)
        dst = os.path.join(OUT_DIR, name)
        if not os.path.exists(src):
            sys.exit(f"找不到完整字体: {src}")

        font = TTFont(src)
        cmap = font.getBestCmap()
        # 汉字必须 100% 覆盖，否则说明换了字体/字符集，要人工确认
        missing_hanzi = [c for c in set(hanzi) if ord(c) not in cmap]
        if missing_hanzi:
            sys.exit(f"{name} 缺少 {len(missing_hanzi)} 个目标汉字，例如 {missing_hanzi[:10]}")

        opts = subset.Options()
        opts.layout_features = ["kern", "liga", "locl", "vert", "vrt2"]
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]  # 保留版权/许可证
        opts.notdef_outline = True
        opts.glyph_names = False
        opts.hinting = False
        opts.desubroutinize = True
        sub = subset.Subsetter(options=opts)
        sub.populate(text=text)
        sub.subset(font)
        font.save(dst)
        print(f"{name}: {os.path.getsize(src)/1048576:.1f}MB -> {os.path.getsize(dst)/1048576:.2f}MB  字形 {len(font.getGlyphOrder())}")
        font.close()


if __name__ == "__main__":
    main()
