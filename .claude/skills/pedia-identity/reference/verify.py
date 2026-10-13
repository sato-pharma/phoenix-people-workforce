#!/usr/bin/env python3
"""Measure a rendered Pedia piece. The pixels are the artifact; the CSS is not.

Every defect this family has had was correct in the stylesheet and wrong on the
page — a reflection running through a caption, a date wrapping to two lines, a
hexagon cluster that read as a molecule diagram. None of those is visible in source.

    python verify.py ../examples/name-card.png --card
    python verify.py ../examples/line-sheet.png --sheet
    python verify.py ../examples/closing-sheet.png --closing

Exit code is 1 if anything failed, so it can gate a build.
"""
import argparse
import sys

import numpy as np
from PIL import Image

BASE_TEAL = (3, 36, 39)        # #032427 — the closing bar
SEAM_GOLD = (193, 126, 17)     # #c17e11
SEAM_AQUA = (62, 171, 149)     # #3eab95


def near(a, b, tol=6):
    return all(abs(int(x) - int(y)) <= tol for x, y in zip(a, b))


def ink_columns(a, y0, y1, thresh=232):
    """Columns holding ink between two rows, as a boolean per column.

    A hairline spanning the full width POLLUTES a column measurement — it makes
    every column look inked and reports 0 margin where there are 250 clear pixels.
    Pick a band with no full-width rule in it, or the number is meaningless.
    """
    band = a[y0:y1, :, :3].min(axis=2)
    return (band < thresh).any(axis=0)


def check_card(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im)
    out = []
    out.append(("size 1200x1580", im.size == (1200, 1580), f"{im.size}"))
    out.append(("base bar closed", near(a[1570, 0], BASE_TEAL), f"{tuple(a[1570,0])}"))

    seam = a[1146]
    out.append(("seam gold on the left", near(seam[200], SEAM_GOLD, 10), f"{tuple(seam[200])}"))
    out.append(("seam aqua on the right", near(seam[1000], SEAM_AQUA, 10), f"{tuple(seam[1000])}"))

    # The role line sits at ONE y across the whole set — a name card that forgets to
    # raise its guest block by 84px drifts, and only a cross-card comparison catches
    # it. Measured by LUMINANCE, never by darkness: the type here is white on a dark
    # green field, so a dark-ink threshold reports the whole block as one solid band.
    lum = a[..., 0] * .299 + a[..., 1] * .587 + a[..., 2] * .114
    prof = (lum[1000:1150, 300:900] > 150).sum(axis=1)
    bands, start = [], None
    for i, v in enumerate(prof):
        y = 1000 + i
        if v > 2 and start is None:
            start = y
        if v <= 2 and start is not None:
            bands.append((start, y - 1))
            start = None
    role = bands[-1][0] if bands else -1
    out.append(("role line starts at y 1113", role == 1113, f"y={role}, lines {bands}"))

    # the foot's left margin, measured in a band with no full-width rule in it
    cols = ink_columns(a, 1176, 1200)
    left = int(np.argmax(cols)) if cols.any() else -1
    out.append(("foot left margin 83-85", 83 <= left <= 85, f"{left}"))

    # the Arabic wordmark is laid TO the trim and never past it; it is drawn at
    # 12%, so its densest ink is about 220 — a threshold of 230 stops finding the
    # wordmark and starts finding the carton instead
    band = a[1150:1500, :, :3].min(axis=2)
    inked = (band < 243).any(axis=0)
    right = len(inked) - 1 - int(np.argmax(inked[::-1])) if inked.any() else -1
    out.append(("wordmark runs to the trim", right >= 1194, f"right-most ink x={right}"))

    return out


def check_sheet(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im)
    out = []
    out.append(("size 2480x3508 (A4 at 300dpi)", im.size == (2480, 3508), f"{im.size}"))
    out.append(("base bar closed", near(a[3500, 0], BASE_TEAL), f"{tuple(a[3500,0])}"))
    seam = a[2144]
    out.append(("seam gold on the left", near(seam[400], SEAM_GOLD, 10), f"{tuple(seam[400])}"))
    out.append(("seam aqua on the right", near(seam[2100], SEAM_AQUA, 10), f"{tuple(seam[2100])}"))

    # the packs must not touch. Measure the clear gaps in the pack band.
    band = a[2520:2850, :, :3].min(axis=2) < 238
    cols = band.any(axis=0)
    runs, run = [], 0
    for c in cols:
        if c:
            if run:
                runs.append(run)
            run = 0
        else:
            run += 1
    gaps = sorted(r for r in runs if 20 < r < 400)
    out.append(("no two packs touch", len(gaps) >= 2, f"clear gaps px {gaps[:6]}"))
    return out


ZEBRA = (240, 242, 242)        # the base teal laid over white at 6% — the ONE fill allowed


def check_closing(path):
    """The closing sheet. Its hard rules are arithmetic and typographic, not decorative:
    the units total must NOT be a number, and the foot must carry no fill but the zebra."""
    im = Image.open(path).convert("RGB")
    a = np.asarray(im)
    out = []
    out.append(("size 2480x3508 (A4 at 300dpi)", im.size == (2480, 3508), f"{im.size}"))
    out.append(("base bar closed", near(a[3500, 0], BASE_TEAL), f"{tuple(a[3500,0])}"))

    seam = a[1242]
    out.append(("seam gold on the left", near(seam[400], SEAM_GOLD, 10), f"{tuple(seam[400])}"))
    out.append(("seam aqua on the right", near(seam[2100], SEAM_AQUA, 10), f"{tuple(seam[2100])}"))

    # 🔴 THE UNITS TOTAL IS AN EM DASH, NOT A SUM. Units of cans, a millilitre syrup and
    # sachets are not one quantity, so the total row's units cell carries a
    # rule and nothing else. Measured, not trusted: a numeral in that cell is ~40px tall
    # and a dash is ~4. This is the check that stops a later edit "completing" the table.
    cell = a[2830:2900, 1250:1500, :3].min(axis=2) < 232
    rows = np.where(cell.any(axis=1))[0]
    tall = int(rows[-1] - rows[0] + 1) if len(rows) else 0
    out.append(("units total is a dash, not a sum", 0 < tall <= 14, f"ink is {tall}px tall"))

    # the ink rule in the foot: the zebra row is the ONLY filled area. A filled header,
    # a filled total row or a tinted achievement cell all fail here.
    out.append(("zebra row is base teal at 6%", near(a[1755, 900], ZEBRA, 3), f"{tuple(a[1755,900])}"))
    out.append(("the row above it is unfilled", near(a[1669, 900], (255, 255, 255), 1), f"{tuple(a[1669,900])}"))

    # the foot's left margin, read in the notes band where no cluster hangs into the margin
    cols = ink_columns(a, 3230, 3262)
    left = int(np.argmax(cols)) if cols.any() else -1
    out.append(("notes left margin 251-253", 251 <= left <= 253, f"{left}"))

    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--card", action="store_true")
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--closing", action="store_true")
    a = ap.parse_args()
    rows = check_closing(a.path) if a.closing else (
        check_sheet(a.path) if a.sheet else check_card(a.path))
    bad = 0
    for name, ok, detail in rows:
        if not ok:
            bad += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {name:34s} {detail}")
    print(f"{len(rows) - bad} passed, {bad} failed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
