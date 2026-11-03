# 앱 아이콘 만들기: 어두운 바탕 + 빨강·파랑 캔들 + 상승 선 (원본 POWER CHART와 같은 그림)
# FAKE TRADING은 원본과 작업 표시줄에서 구분되게 오른쪽 아래에 주황 동그라미 "F"를 얹는다 (2026-10-30)
# 사용법: python tools/make_icon.py tools/icon_src.png src-tauri/icons
#   첫 인자 = 1024px 원본 PNG를 저장할 곳, 둘째 인자(있으면) = 앱 아이콘 폴더 → 크기별 PNG와 icon.ico를 다시 만든다
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import sys

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=(18, 21, 26, 255), outline=(44, 51, 61, 255), width=16)
UP, DOWN = (255, 77, 79, 255), (61, 139, 255, 255)
candles = [(250, 640, 760, 560, 700, DOWN), (420, 470, 690, 520, 640, UP), (590, 360, 560, 400, 520, UP), (760, 220, 470, 260, 420, UP)]
for x, hi, lo, top, bot, col in candles:
    d.line([x, hi, x, lo], fill=col, width=22)
    d.rounded_rectangle([x - 55, top, x + 55, bot], radius=14, fill=col)
d.line([(180, 820), (420, 700), (600, 560), (850, 300)], fill=(255, 176, 32, 255), width=26, joint="curve")

# FAKE 표시: 작게 보여도 알아보게 크고 진하게
cx, cy, r = 735, 735, 250
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 138, 61, 255), outline=(18, 21, 26, 255), width=28)
font = None
for name in ("segoeuib.ttf", "arialbd.ttf"):
    try:
        font = ImageFont.truetype(name, 340)
        break
    except OSError:
        pass
d.text((cx, cy + 8), "F", font=font, fill=(255, 255, 255, 255), anchor="mm")

img.save(sys.argv[1])

if len(sys.argv) > 2:
    out = Path(sys.argv[2])
    sizes = {"32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512, "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71, "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142, "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310, "StoreLogo.png": 50}
    for name, s in sizes.items():
        img.resize((s, s), Image.LANCZOS).save(out / name)
    img.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
    print("아이콘", len(sizes) + 1, "개 →", out)
