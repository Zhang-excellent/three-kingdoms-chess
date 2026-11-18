from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


BACKGROUND = (239, 229, 213, 255)
DENSITY_SIZES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}
ADAPTIVE_SIZES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}


def centered_square(source: Image.Image) -> Image.Image:
    side = min(source.width, source.height)
    left = (source.width - side) // 2
    top = (source.height - side) // 2
    return source.crop((left, top, left + side, top + side))


def paste_fitted(canvas: Image.Image, source: Image.Image, scale: float) -> None:
    side = round(canvas.width * scale)
    fitted = source.resize((side, side), Image.Resampling.LANCZOS)
    offset = (canvas.width - side) // 2
    canvas.alpha_composite(fitted, (offset, offset))


def legacy_icon(source: Image.Image, size: int, round_icon: bool) -> Image.Image:
    supersample = 4
    large_size = size * supersample
    canvas = Image.new("RGBA", (large_size, large_size), BACKGROUND)
    paste_fitted(canvas, source, 0.94)
    if round_icon:
        mask = Image.new("L", canvas.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, large_size - 1, large_size - 1), fill=255)
        canvas.putalpha(mask)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def adaptive_foreground(source: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    paste_fitted(canvas, source, 0.82)
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Android launcher icons from one square-croppable image.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--res-dir", type=Path, default=Path("android/app/src/main/res"))
    args = parser.parse_args()

    with Image.open(args.source) as input_image:
        source = centered_square(input_image.convert("RGBA"))

    for density, size in DENSITY_SIZES.items():
        output_dir = args.res_dir / f"mipmap-{density}"
        output_dir.mkdir(parents=True, exist_ok=True)
        legacy_icon(source, size, False).save(output_dir / "ic_launcher.png", optimize=True)
        legacy_icon(source, size, True).save(output_dir / "ic_launcher_round.png", optimize=True)

    for density, size in ADAPTIVE_SIZES.items():
        output_dir = args.res_dir / f"mipmap-{density}"
        adaptive_foreground(source, size).save(output_dir / "ic_launcher_foreground.png", optimize=True)

    print(f"Generated Android launcher icons in {args.res_dir.resolve()}")


if __name__ == "__main__":
    main()
