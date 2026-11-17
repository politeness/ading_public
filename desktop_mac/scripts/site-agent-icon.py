"""
Normalize Agent icons into the landing-page style: extract the glyph, scale it proportionally and center it on a same-size white rounded tile.

Vendor originals vary (some have a white square, some shadowed rounded corners, some full-bleed transparency), so side by side their sizes and backgrounds don't match.
The originals used in the app are untouched; this only generates copies for the website.

Usage: python3 scripts/site-agent-icon.py <source> <output.png>
"""
import sys
from PIL import Image, ImageDraw

SIZE = 96          # output size; shown at 20~24px on the page, enough for Retina
GLYPH = 0.64       # glyph size relative to the tile
RADIUS = 0.24      # corner radius relative to the side length

source = Image.open(sys.argv[1]).convert("RGBA")
pixels = list(source.getdata())
# Kept pixels: opaque and not white / light gray (drops the original's white tile and its faint shadow)
keep = Image.new("L", source.size, 0)
keep.putdata([255 if a > 128 and (r + g + b) / 3 < 215 else 0 for r, g, b, a in pixels])
# Position and scale use only the dark main glyph; faint marks like the light-gray "CN" in the Qoder CN corner are ignored so the glyph isn't shrunk or shifted
core = Image.new("L", source.size, 0)
core.putdata([255 if a > 128 and (r + g + b) / 3 < 150 else 0 for r, g, b, a in pixels])
left, top, right, bottom = core.getbbox() or keep.getbbox() or (0, 0, *source.size)

scale = SIZE * GLYPH / max(right - left, bottom - top)
glyph = Image.new("RGBA", source.size, (0, 0, 0, 0))
glyph.paste(source, (0, 0), keep)
glyph = glyph.resize((max(1, round(source.width * scale)), max(1, round(source.height * scale))), Image.LANCZOS)
offset = (round(SIZE / 2 - (left + right) / 2 * scale), round(SIZE / 2 - (top + bottom) / 2 * scale))

tile = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(tile).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=round(SIZE * RADIUS), fill=(255, 255, 255, 255))
layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
layer.paste(glyph, offset, glyph)
tile.alpha_composite(layer)
tile.save(sys.argv[2])
