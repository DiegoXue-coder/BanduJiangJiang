from PIL import Image, ImageDraw
import os

icons_dir = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(icons_dir, exist_ok=True)

for size in [16, 48, 128]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([0, 0, size - 1, size - 1], fill=(79, 142, 247, 255))
    m = size // 5
    draw.rectangle([m, m, size - m - 1, size - m - 1], fill=(255, 255, 255, 200))
    draw.line(
        [size // 2, m, size // 2, size - m - 1],
        fill=(79, 142, 247, 255),
        width=max(1, size // 16),
    )
    path = os.path.join(icons_dir, f"icon{size}.png")
    img.save(path)
    print(f"OK: {path}")
