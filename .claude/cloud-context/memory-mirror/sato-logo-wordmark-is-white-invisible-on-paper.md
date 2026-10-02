---
name: sato-logo-wordmark-is-white-invisible-on-paper
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: THE INK RULE - no filled areas, anywhere ... no masthead band, no filled table headers ... Brand Deep REPLACES the navy #0B2A4A (see `the-house-document-identity-standard`). Older text follows: The Sato Pharma logo's \"SATO\" wordmark is WHITE, so the brand name vanishes on any white background — every printed/exported document needs a recoloured or reversed variant."
metadata:
  type: reference
---

`public/brand/sato-pharma-logo.png` (401x158, RGBA, transparent background) is a **reversed
(knockout) logo**. Measured with PIL: 24,712 opaque pixels, of which **9,525 are near-white** — that
white block is the word **"SATO"**. Only "PHARMA" is blue. On a white page or a white DOCX/PDF
background the company name **disappears entirely** and the mark reads as "PHARMA" alone.

**Why:** it was cut for dark UI surfaces (the app's navy header), not for print. Nothing in the repo
flags this, and a thumbnail on a dark editor background looks perfectly fine — the defect only
appears once it is placed on white, which is where every exported document puts it.

**SOLVED 2026-08-27 — an on-light asset now EXISTS; stop re-deriving the fix.**
`public/brand/sato-pharma-logo-on-light.png` is the paper-safe variant: **SATO in black,
PHARMA in blue**, generated from the official file by recolouring the 9,419 opaque near-white
pixels (r,g,b>200, alpha>=40) to `#000000` and touching nothing else — so it is the same artwork
to the pixel, not a redraw. The owner supplied a reference image of exactly this treatment and the
generated file matched it. **Use it for every white/printed surface** (XLSX, DOCX, PDF); keep the
original `sato-pharma-logo.png` for dark surfaces only. Because it exists, a document no longer
needs a navy masthead just to make the logo legible — a white header with the on-light mark over a
thin `#0868A8` rule is the subtler treatment, and is what the Monthly Closing workbook uses.

**How to apply:** never drop the ORIGINAL file straight onto a white document. Two working variants,
generated on 2026-08-26 for the Sato employment contract:
- **On a dark band** — use the file as-is over a navy field (`0B2A4A`), and brighten the blue
  "PHARMA" pixels to `7CC4F0` so both words carry. This is the better-looking option: it gives the
  page a masthead.
- **On white** — recolour the ~9,525 near-white pixels to navy `(11,42,74)` and leave the rest.

Detect it the same way next time: count opaque pixels where `r,g,b > 200`. If that count is a large
share of the mark, it is a knockout logo. Do not judge by eye against a dark background.


**The brand blue, sampled from the mark itself (2026-08-27):** the dominant non-white colour is
**`#0868A8`** (rgb 8,104,168 — 9,683 px), with `#085080` as the deep shade and `#1888D0`/`#1888C8`
as the lighter wave strokes. Use these rather than inventing a blue when a whole document or
workbook has to be branded Sato — the owner asked for "subtle identity and colors, not Phoenix"
on 2026-08-26, which means retiring Phoenix orange (`#F97316`) and clay (`#7C2D12`) from any
Sato-branded export. Re-measured the white share the same day at 40% (8,684 of 21,726 opaque px,
alpha>=200) — the same defect this file already describes, confirmed independently.

Related: [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]]
