from PIL import Image, ImageDraw
import os
import math

icons_dir = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(icons_dir, exist_ok=True)

def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size

    # ── 圆形背景（纯色深蓝紫）──────────────────────────
    cx, cy = s / 2, s / 2
    draw.ellipse([0, 0, s - 1, s - 1], fill=(89, 86, 213, 255))

    # ── 书本（简洁两页，白色）──────────────────────────
    pad = int(s * 0.20)
    mid = s // 2
    by0 = int(s * 0.22)
    by1 = int(s * 0.70)
    gap = max(1, int(s * 0.025))   # 书脊间隙

    # 左页
    draw.rectangle([pad, by0, mid - gap, by1], fill=(255, 255, 255, 255))
    # 右页（略透明区分）
    draw.rectangle([mid + gap, by0, s - pad, by1], fill=(255, 255, 255, 200))

    # 左页横线
    lpad = int(s * 0.06)
    line_h = max(1, int(s * 0.025))
    line_gap = int((by1 - by0) / 5)
    for i in range(1, 4):
        ly = by0 + line_gap * i
        w = (mid - gap - pad - lpad * 2)
        short = w if i != 3 else int(w * 0.55)
        draw.rectangle([pad + lpad, ly, pad + lpad + short, ly + line_h],
                       fill=(89, 86, 213, 120))

    # ── 对话气泡（右下，简洁圆角矩形）─────────────────
    if size >= 48:
        br = int(s * 0.20)
        bx0 = int(s * 0.52)
        bx1 = int(s * 0.88)
        bby0 = int(s * 0.58)
        bby1 = int(s * 0.84)
        br2 = max(2, int(br * 0.4))

        # 气泡白底
        draw.rounded_rectangle([bx0, bby0, bx1, bby1], radius=br2,
                                fill=(255, 255, 255, 255))
        # 气泡尾
        tail = [
            (bx0 + int((bx1-bx0)*0.15), bby1),
            (bx0 - int(s*0.04), bby1 + int(s*0.09)),
            (bx0 + int((bx1-bx0)*0.38), bby1),
        ]
        draw.polygon(tail, fill=(255, 255, 255, 255))

        # 三个点
        dot_r = max(1, int(s * 0.030))
        dot_y = (bby0 + bby1) // 2
        total_w = bx1 - bx0
        spacing = total_w // 4
        for i in range(3):
            dx = bx0 + spacing * (i + 1)
            draw.ellipse([dx - dot_r, dot_y - dot_r,
                          dx + dot_r, dot_y + dot_r],
                         fill=(89, 86, 213, 255))

    return img

for size in [16, 48, 128]:
    img = draw_icon(size)
    path = os.path.join(icons_dir, f"icon{size}.png")
    img.save(path)
    print(f"OK: {path}")
