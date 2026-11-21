from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "beast-chess" / "source.png"
OUTPUT = ROOT / "public" / "images" / "beast-chess"

# Measured directly from the supplied 1254×1254 board. Rows are ordered top-to-bottom.
X_EDGES = (80, 237, 394, 550, 705, 861, 1016, 1173)
Y_EDGES = (72, 198, 321, 442, 565, 686, 807, 928, 1049, 1174)

PIECES = {
    "upper": {
        (0, 8): "lion",
        (6, 8): "tiger",
        (1, 7): "dog",
        (5, 7): "cat",
        (0, 6): "rat",
        (2, 6): "leopard",
        (4, 6): "wolf",
        (6, 6): "elephant",
    },
    "lower": {
        (0, 0): "tiger",
        (6, 0): "lion",
        (1, 1): "cat",
        (5, 1): "dog",
        (0, 2): "elephant",
        (2, 2): "wolf",
        (4, 2): "leopard",
        (6, 2): "rat",
    },
}

# Blank land cells used to recover the underlying wood texture without repainting it.
REPLACEMENTS = {
    (0, 8): (1, 8),
    (6, 8): (5, 8),
    (1, 7): (0, 7),
    (5, 7): (6, 7),
    (0, 6): (1, 6),
    (2, 6): (3, 6),
    (4, 6): (3, 6),
    (6, 6): (5, 6),
    (0, 0): (1, 0),
    (6, 0): (5, 0),
    (1, 1): (0, 1),
    (5, 1): (6, 1),
    (0, 2): (1, 2),
    (2, 2): (3, 2),
    (4, 2): (3, 2),
    (6, 2): (5, 2),
}

# Stronger, kind-specific animal colors. Each palette keeps enough tonal range
# to preserve the original illustration's eyes, stripes and fur details.
KIND_COLORS = {
    "elephant": ("#3d5666", "#cad5dc"),
    "lion": ("#8b5200", "#ffd24a"),
    "tiger": ("#7c2800", "#ff8b24"),
    "leopard": ("#704200", "#e8aa32"),
    "wolf": ("#586a79", "#d4dde4"),
    "dog": ("#75442c", "#dda071"),
    "cat": ("#607887", "#f3f8f8"),
    "rat": ("#75614e", "#d3bfa4"),
}


def cell_box(x: int, y: int) -> tuple[int, int, int, int]:
    image_row = 8 - y
    return X_EDGES[x], Y_EDGES[image_row], X_EDGES[x + 1], Y_EDGES[image_row + 1]


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    scale = 4
    large = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    ImageDraw.Draw(large).rounded_rectangle(
        (0, 0, large.width - 1, large.height - 1),
        radius=radius * scale,
        fill=255,
    )
    return large.resize(size, Image.Resampling.LANCZOS)


def extract_piece(source: Image.Image, side: str, x: int, y: int) -> Image.Image:
    left, top, right, bottom = cell_box(x, y)
    crop = source.crop((left + 7, top + 9, right - 7, bottom - 9)).convert("RGBA")
    crop.putalpha(rounded_mask(crop.size, 24))
    return crop


def smoothstep(value: float, low: float, high: float) -> float:
    if value <= low:
        return 0.0
    if value >= high:
        return 1.0
    progress = (value - low) / (high - low)
    return progress * progress * (3 - 2 * progress)


def colorize_animal(piece: Image.Image, side: str, kind: str) -> Image.Image:
    """Tint the animal silhouette while preserving the supplied wooden base."""
    rgb = piece.convert("RGB")
    alpha = piece.getchannel("A")
    grayscale = rgb.convert("L")
    dark, light = KIND_COLORS[kind]
    color_input = (grayscale.point(lambda value: min(255, 80 + value * 2))
                   if side == "lower" else grayscale)
    tinted = ImageOps.colorize(color_input, black=dark, white=light).convert("RGBA")
    tinted.putalpha(alpha)

    width, height = piece.size
    inset_x = max(7, round(width * 0.05))
    inset_y = max(7, round(height * 0.07))
    mask = Image.new("L", (width, height), 0)
    mask_pixels = mask.load()
    rgb_pixels = rgb.load()
    alpha_pixels = alpha.load()

    for y in range(inset_y, height - inset_y):
        for x in range(inset_x, width - inset_x):
            if alpha_pixels[x, y] < 32:
                continue
            red, green, blue = rgb_pixels[x, y]
            luminance = 0.299 * red + 0.587 * green + 0.114 * blue
            if side == "lower":
                # Dark-brown lower-side animals against a pale wooden base.
                weight = 1 - smoothstep(luminance, 115, 170)
            else:
                # Cream-colored upper-side animals against a dark wooden base.
                weight = smoothstep(luminance, 145, 205)
            if weight:
                mask_pixels[x, y] = round(weight * alpha_pixels[x, y])

    return Image.composite(tinted, piece, mask)


def clean_board(source: Image.Image) -> Image.Image:
    board = source.copy()
    for (x, y), (replacement_x, replacement_y) in REPLACEMENTS.items():
        left, top, right, bottom = cell_box(x, y)
        replacement = cell_box(replacement_x, replacement_y)
        inset = 4
        patch = source.crop((
            replacement[0] + inset,
            replacement[1] + inset,
            replacement[2] - inset,
            replacement[3] - inset,
        ))
        board.paste(patch, (left + inset, top + inset))
    return board


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    piece_dir = OUTPUT / "pieces"
    piece_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as input_image:
        source = input_image.convert("RGB")

    clean_board(source).save(OUTPUT / "board.png", optimize=True)
    for side, pieces in PIECES.items():
        for (x, y), kind in pieces.items():
            colored_piece = colorize_animal(extract_piece(source, side, x, y), side, kind)
            colored_piece.save(piece_dir / f"{side}-{kind}.png", optimize=True)

    print(f"Prepared beast-chess board and 16 pieces in {OUTPUT}")


if __name__ == "__main__":
    main()
