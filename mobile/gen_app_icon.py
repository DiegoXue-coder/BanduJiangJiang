"""阶段十四：图标概念方向已在决策层定稿——暖纸古风配色、油灯剪影，呼应
"沉光共读"这个暂定名里的"光"意象。照抄 extension/gen_icons.py 那套
PIL 程序化画图的做法（不是新引入的技术路径），按 Expo 各资源文件实际
需要的尺寸/格式分别导出。

配色直接用 mobile/theme.js 里亮色主题已经定稿的token，不额外发明新颜色：
bg（暖纸背景）、accent（暖棕，灯身剪影）、tag（暖金，火焰）。
"""
from PIL import Image, ImageDraw
import os
import math

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")

BG = (234, 227, 211)      # theme.light.bg    #EAE3D3
LAMP = (140, 86, 66)      # theme.light.accent #8C5642
FLAME_OUTER = (168, 130, 61)   # theme.light.tag    #A8823D
FLAME_INNER = (224, 189, 122)  # 比tag更亮一档的暖金，给火焰画出层次


def _flame_points(cx, top_y, bottom_y, half_w, steps=14):
    """火焰剪影：顶部收尖、约62%高度处最鼓、底部收窄到35%宽度贴合灯芯（不
    完全收尖，看起来像跟灯油连着），用较多采样点沿平滑曲线近似轮廓，比
    直接用直线折角的多边形更圆润。分两段算宽度：前62%用sin曲线鼓起，
    后38%线性收到35%宽度的收口。"""
    peak_t = 0.62
    right = []
    for i in range(steps + 1):
        t = i / steps  # 0=顶尖, 1=底部
        if t <= peak_t:
            w = half_w * math.sin((t / peak_t) * (math.pi / 2))
        else:
            bulge_at_peak = half_w
            tail = (t - peak_t) / (1 - peak_t)
            w = bulge_at_peak * (1 - tail) + half_w * 0.35 * tail
        y = top_y + (bottom_y - top_y) * t
        right.append((cx + w, y))
    left = [(cx - (x - cx), y) for x, y in reversed(right)]
    return right + left


def draw_lamp(draw, s, cx, cy_bottom, scale=1.0, lamp_color=LAMP,
              flame_outer=FLAME_OUTER, flame_inner=FLAME_INNER):
    """在 (cx, cy_bottom) 为底座中心、整体高度约为 s*scale 的范围内画一盏油灯
    （底座+灯柄+灯盘+火焰）。所有尺寸都用 s*scale 的比例算，跟分辨率无关，
    小图标（如48px favicon）也能按比例正常出图。"""
    unit = s * scale

    base_w = unit * 0.30
    base_h = unit * 0.045
    base_y1 = cy_bottom
    base_y0 = base_y1 - base_h
    draw.rounded_rectangle(
        [cx - base_w / 2, base_y0, cx + base_w / 2, base_y1],
        radius=base_h * 0.4, fill=lamp_color,
    )

    stem_w = unit * 0.06
    stem_h = unit * 0.20
    stem_y1 = base_y0
    stem_y0 = stem_y1 - stem_h
    draw.rectangle(
        [cx - stem_w / 2, stem_y0, cx + stem_w / 2, stem_y1],
        fill=lamp_color,
    )

    bowl_w = unit * 0.56
    bowl_h = unit * 0.20
    bowl_y1 = stem_y0 + bowl_h * 0.35
    bowl_y0 = bowl_y1 - bowl_h
    draw.ellipse(
        [cx - bowl_w / 2, bowl_y0, cx + bowl_w / 2, bowl_y1],
        fill=lamp_color,
    )

    flame_top = bowl_y0 - unit * 0.34
    flame_bottom = bowl_y0 + unit * 0.03
    draw.polygon(_flame_points(cx, flame_top, flame_bottom, unit * 0.15), fill=flame_outer)
    inner_top = flame_top + (flame_bottom - flame_top) * 0.18
    draw.polygon(_flame_points(cx, inner_top, flame_bottom, unit * 0.08), fill=flame_inner)


def make_icon(size):
    """主图标：iOS/Expo要求不带透明通道，整张实色铺满。scale=0.85让主体在
    小尺寸下（主屏幕图标实际显示得很小）也足够醒目，cy_bottom按图形自身
    高度算过，让整个灯+火焰的构图在画布里垂直居中，不是随手挑的数字。"""
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)
    draw_lamp(draw, size, size / 2, size * 0.804, scale=0.85)
    return img


def make_adaptive_foreground(size):
    """Android自适应图标前景层：透明底，内容收在安全区（不同厂商的遮罩形状
    会裁掉图标四周一圈，官方建议关键内容留在中心约66%范围内，这里保守一点
    用0.5的缩放）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_lamp(draw, size, size / 2, size * 0.679, scale=0.5)
    return img


def make_adaptive_background(size):
    img = Image.new("RGBA", (size, size), BG + (255,))
    return img


def make_monochrome(size):
    """Android 13+主题图标：单色剪影，透明底，系统会自己上色，这里统一画成
    纯白，形状（灯+火焰合并成一个轮廓）是唯一有意义的信息。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    draw_lamp(draw, size, size / 2, size * 0.679, scale=0.5,
              lamp_color=white, flame_outer=white, flame_inner=white)
    return img


def make_splash(size):
    """启动画面：logo在竖直方向整体居中（cy_bottom按构图高度算过，视觉中心
    落在画布中点附近），不是贴着底部或顶部。"""
    img = Image.new("RGBA", (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    draw_lamp(draw, size, size / 2, size * 0.62, scale=0.34)
    return img


os.makedirs(ASSETS_DIR, exist_ok=True)

make_icon(1024).save(os.path.join(ASSETS_DIR, "icon.png"))
make_adaptive_foreground(512).save(os.path.join(ASSETS_DIR, "android-icon-foreground.png"))
make_adaptive_background(512).save(os.path.join(ASSETS_DIR, "android-icon-background.png"))
make_monochrome(432).save(os.path.join(ASSETS_DIR, "android-icon-monochrome.png"))
make_icon(48).save(os.path.join(ASSETS_DIR, "favicon.png"))
make_splash(1024).save(os.path.join(ASSETS_DIR, "splash-icon.png"))

print("图标资源已全部生成到", ASSETS_DIR)
