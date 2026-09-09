"""Generate build/icon.{ico,png} — the app icon.

A placeholder, but a real one: electron-builder fails the Windows build outright when
`win.icon` points at a file that is not there, and Windows needs a genuine multi-size
.ico rather than a renamed PNG.

The mark is a measuring rule, which is what a QC operator actually does all shift.
Replace it with real branding whenever there is any; the build only cares that the file
exists and is a valid icon.

    python3 scripts/make_icon.py
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "build")

SIZE = 1024  # drawn large, then downsampled, so the small sizes stay clean
BACKGROUND = (15, 23, 42, 255)  # matches the app shell
ACCENT = (56, 189, 248, 255)
INK = (226, 232, 240, 255)


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    return mask


def draw_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rectangle((0, 0, size, size), fill=BACKGROUND)

    # The rule itself.
    bar_left, bar_right = int(size * 0.16), int(size * 0.84)
    bar_top, bar_bottom = int(size * 0.40), int(size * 0.62)
    draw.rounded_rectangle(
        (bar_left, bar_top, bar_right, bar_bottom), radius=int(size * 0.035), fill=INK
    )

    # Graduations, alternating long and short, hanging from the top edge.
    ticks = 9
    span = bar_right - bar_left
    for index in range(1, ticks):
        x = bar_left + round(span * index / ticks)
        long_tick = index % 2 == 1
        depth = (bar_bottom - bar_top) * (0.55 if long_tick else 0.32)
        width = max(2, int(size * (0.016 if long_tick else 0.012)))
        draw.rectangle((x - width // 2, bar_top, x + width // 2, bar_top + depth), fill=BACKGROUND)

    # An accent underline, so the mark still reads at 16px where the ticks blur away.
    draw.rounded_rectangle(
        (bar_left, int(size * 0.70), bar_right, int(size * 0.76)),
        radius=int(size * 0.02),
        fill=ACCENT,
    )

    image.putalpha(rounded_mask(size))
    return image


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    master = draw_icon(SIZE)

    png_path = os.path.join(OUT_DIR, "icon.png")
    master.resize((512, 512), Image.LANCZOS).save(png_path, format="PNG")

    # Every size Windows asks for; without 256 the installer and shortcut look blurry.
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    master.resize((256, 256), Image.LANCZOS).save(ico_path, format="ICO", sizes=sizes)

    print(f"wrote {os.path.relpath(png_path)} and {os.path.relpath(ico_path)}")


if __name__ == "__main__":
    main()
