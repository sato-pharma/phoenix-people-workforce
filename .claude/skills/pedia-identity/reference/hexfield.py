#!/usr/bin/env python3
"""The Pedia field texture — the honeycomb.

The Lacto Advanced cans carry their claims in hexagon badges: Multi Vitamins, DHA & ARA,
Vitamin D3, Ca. That hexagon is Pedia's own recurring shape, so the texture is built
from it — but it does NOT trace the badges, which are the manufacturer's printed
artwork. This generates patches of honeycomb that fade out from a centre, as Sato's own
texture. Same idea, our own drawing.

Deterministic by seed, so the texture is identical on every render and a diff of two
cards never shows a moved cell.

    python hexfield.py --seed 7  --patches 9  --width 1200 --height 1150 --out ../assets/hexfield.svg
    python hexfield.py --seed 19 --patches 20 --width 2480 --height 2150 --out ../assets/hexfield-sheet.svg

Laws this encodes:

  · a PATCH, never a lattice. A honeycomb across the whole field reads as a wallpaper;
    a handful of patches that thin out toward their edges reads as a cluster of cells,
    which is what the badges are. Each patch picks its own cell size.
  · a cell's outline fades with its distance from the patch centre, and a few cells are
    dropped outright, so the edge of a patch is ragged rather than a clean hexagon of
    hexagons.
  · a few cells carry a faint FILL as well as the outline — the badges are solid.
  · the centre of the field is kept clear most of the time: it is where the title and
    the hero pack sit, and a texture running through the name is the defect.
  · ONE ink (white) at low opacity, never in the seam's colours. The seam owns gold and
    aqua; a texture that competes with them is the defect.
"""
import argparse
import math
import random


def hexagon(cx: float, cy: float, r: float) -> str:
    """A pointy-top hexagon of circumradius r, as an SVG points string."""
    pts = []
    for k in range(6):
        a = math.radians(60 * k - 30)
        pts.append(f"{cx + r * math.cos(a):.1f},{cy + r * math.sin(a):.1f}")
    return " ".join(pts)


def build(seed: int, patches: int, width: int, height: int, margin: int, clear: float):
    rng = random.Random(seed)
    centres: list[tuple[float, float, float]] = []
    guard = 0
    while len(centres) < patches and guard < patches * 600:
        guard += 1
        x = rng.uniform(margin, width - margin)
        y = rng.uniform(margin, height - margin)
        r = rng.uniform(0.07, 0.15) * width
        # keep the middle of the field mostly clear, but not always: a field with a hole
        # punched in its centre reads as a vignette, not a texture.
        inside = abs(x / width - 0.5) < clear and 0.22 < y / height < 0.78
        if inside and rng.random() > 0.18:
            continue
        # patches may overlap a little but not sit on top of each other
        if any(math.dist((x, y), (px, py)) < (r + pr) * 0.72 for px, py, pr in centres):
            continue
        centres.append((x, y, r))

    cells: list[tuple[float, float, float, float, bool]] = []  # cx, cy, r, opacity, filled
    for (px, py, pr) in centres:
        cell = rng.uniform(0.022, 0.045) * width  # circumradius of one cell, scaled to the piece
        dx = cell * math.sqrt(3)
        dy = cell * 1.5
        rows = int(pr / dy) + 2
        cols = int(pr / dx) + 2
        for j in range(-rows, rows + 1):
            for i in range(-cols, cols + 1):
                cx = px + i * dx + (dx / 2 if j % 2 else 0)
                cy = py + j * dy
                d = math.dist((cx, cy), (px, py))
                if d > pr or not (margin / 3 < cx < width - margin / 3 and margin / 3 < cy < height - margin / 3):
                    continue
                if rng.random() < 0.16 + 0.55 * (d / pr) ** 2:
                    continue  # ragged edge: the further out, the likelier a cell is missing
                opacity = max(0.05, 0.42 * (1 - d / pr) ** 0.9)
                cells.append((cx, cy, cell * 0.90, opacity, rng.random() < 0.09))
    return cells


def render(cells, width: int, height: int, ink: str) -> str:
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" fill="none">',
        f'<g stroke="{ink}" stroke-width="1.3" stroke-linejoin="round">',
    ]
    for cx, cy, r, op, filled in cells:
        fill = f' fill="{ink}" fill-opacity="{op * 0.34:.3f}"' if filled else ""
        out.append(f'<polygon points="{hexagon(cx, cy, r)}" stroke-opacity="{op:.3f}"{fill}/>')
    out.append("</g></svg>")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--patches", type=int, default=9)
    ap.add_argument("--width", type=int, default=1200)
    ap.add_argument("--height", type=int, default=1150)
    ap.add_argument("--margin", type=int, default=40)
    ap.add_argument("--clear", type=float, default=0.24,
                    help="half-width, as a fraction of the field, of the mostly-clear centre band")
    ap.add_argument("--ink", default="#ffffff")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cells = build(a.seed, a.patches, a.width, a.height, a.margin, a.clear)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(render(cells, a.width, a.height, a.ink) + "\n")
    print(f"{a.out}: {len(cells)} cells in {a.patches} patches")


if __name__ == "__main__":
    main()
