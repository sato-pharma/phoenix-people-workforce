---
name: anti-infective-identity
description: The Anti-Infective identity — the navy-field invitation and one-sheet look built for the Royafloxacin 500 mg + Saginkgo 120 mg combination (first used for the Delta 3 "SATO ENT CIRCLE" round-table, Sharkia, October 2026). Carries the exact geometry of the personalised invitation card, the name-only variant for a guest with no photograph, the consolidated one sheet, the duotone portrait law that makes ten unrelated snapshots read as one set, the pack lockup rules and the Arabic wordmark placement. Use when building an invitation, a round-table or speaker card, a guest one-sheet, an event poster, a save-the-date or any personalised piece for Royafloxacin, Saginkgo or an Anti-Infective team event. It does NOT replace sato-pharma-identity, which still governs certificates, documents, the business card and the website.
---

# Anti-Infective identity

The event look for the Anti-Infective line: a deep navy field, one
photograph or one name held in the middle of it, and a white foot carrying the
facts, the two cartons and the company's own Arabic calligraphy.

Built and proved on the Delta 3 round-table with ENT consultants in Sharkia —
**SATO ENT CIRCLE**, Oriental Restaurant Zagazig, 6 October 2026 — ten
personalised invitations plus a consolidated sheet. Every measurement in this
file was taken off the rendered pixels of that set, not off its source.

```
assets/
  royafloxacin-500-carton.png   transparent cut-out   1057×888   ratio 1.1903
  saginkgo-120-carton.png       transparent cut-out   1203×1005  ratio 1.1970
  sato-arabic-navy.png          ساتو فارما flattened to one ink  1136×842  ratio 1.3492
  sato-pharma-reverse.png       the reverse mark, for the navy field
reference/
  invitation-card.html          the approved card, verbatim — 1200×1580
  one-sheet.html                the consolidated sheet — 2480×2552
  portrait-pipeline.py          the crop law, the duotone, and the two rescues
examples/
  invitation-card.png           a card with a photograph
  name-only-card.png            a card for a guest who sent none
  one-sheet.png                 all ten on one page
```

## Rule zero

**A design the owner hands you is FINAL.** Fix defects — bleed, resolution,
fonts, colour space, cropped boxes, typos — and keep the look identical. This
file is for NEW pieces in this family; it never overrides something he supplied.
Unsure whether a change alters the look? Leave it and flag it.

## Its relationship to `sato-pharma-identity`

A sibling, not a successor. That skill still governs certificates, PDFs, the
business card, the website and anything that reads as a *document*. This one
governs *event pieces*, and it departs from the SHARP rules in four named,
deliberate ways:

| SHARP says | Here, because |
|---|---|
| no gradient washes | the field is a radial navy; flat navy at A4-and-up reads as dead ink |
| no soft shadows | the title and the guest name carry a soft shadow; the one sheet gives each card a drop shadow because it is depicting ten physical cards |
| one brand blue | two product colours carry the combination — Royafloxacin red and Saginkgo blue — and they appear only as seams, rules and brackets |
| no reflections | the two cartons sit on a 1px `-webkit-box-reflect`, which is how a packshot sits on a surface |

Everything else holds: **90° corners only, no border-radius anywhere**, rules
measured to what sits on them, real photographs only, the micro label as the one
voice of every label, and the Arabic wordmark never retyped in a font.

## Palette

| Token | Hex | Use |
|---|---|---|
| field navy | `#0b3685` 0% → `#052462` 36% → `#001641` 70% | the ground, as a radial falling to base navy at 100% — bright at 33% down on the card, 22% on the one sheet |
| base navy | `#000a26` | the closing bar, and the shadow end of the duotone (`#030e30`) |
| Royafloxacin red | `#d20000` | left half of every seam, the top-left bracket, the first product rule |
| Saginkgo blue | `#0384db` | right half of every seam, the bottom-right bracket, the second product rule |
| roya-hi / sag-hi | `#ff5c5c` / `#63bcf4` | highlights only |
| eyebrow blue | `#67c2f6` | the eyebrow, the role line, the "guest of honour" label on navy |
| name blue | `#7fcdf8` | the name-only card's label |
| ink | `#0a1322` | the white foot's headings |
| soft / faint | `#69757e` / `#8c98a4` | the Arabic facts, the micro labels |
| hair | `#dde4e8` | the foot's 1px dividers |

## Typography

- **Playfair Display** — the event title, and the guest's Latin name. Nothing else.
- **Inter** — every label, fact and micro line.
- **Cairo** — the Arabic facts in the white foot (date, time, venue).
- **Amiri** — Arabic personal names. Never Cairo for a name; naskh carries a name, a UI face does not.
- Micro label: bold, UPPERCASE, tracking `.26em`–`.34em`. In Arabic, **no tracking** — it pulls joined letters apart.

## The invitation card — 1200 × 1580

Drawn top to bottom. The numbers are the approved ones; change them only with a
reason you can measure.

**Navy field** `inset: 0 0 430px 0`, so the navy ends at **y 1150**. Radial
`1180px 820px at 50% 33%` with stops `#0b3685 0%, #052462 36%, #001641 70%,
#000a26 100%`. The stops never change; **the ellipse and its centre are scaled to
the piece** — the one sheet draws the same four stops at
`2600px 1900px at 50% 22%` — so size them to what you are drawing rather than
copying this line across. Then a `feTurbulence` grain at 5.5% overlay, then a
vignette, then a double keyline frame inset **26px and 33px**.

**Head** at `top: 108px`, centred: eyebrow 11.5px → `SATO` 27px at `.66em`
tracking → the event name **92px Playfair** → a ruleset 300px wide (red rule,
white 8px diamond, blue rule) → the place line 10.5px at `.32em`. (The one
sheet's place line is 20px at `.34em` — the tracking opens as the type grows.)

**Marks** — the reverse logo at `left: 84px; top: 56px; height: 58px`; a square
date seal at `right: 84px; top: 52px`, 118×118, a 1px white keyline at **30%**
over a **26% black** ground (the one sheet's seal is 224×224, keyline 26% over
`rgba(0,8,34,.46)`), plus a 5px inset white glow at 4.5%, the day
in 44px Playfair over a 34px red→blue rule over the month in 9px micro.

**Portrait** at `top: 346px`, 452×566 **white mat with 13px padding**, the image
`object-fit: cover` with a 1px inset keyline at 17% black. The mat is what lifts
a photograph off the navy; do not tint it.

**Guest block** at `top: 944px`: the invitation line between two 62px fading
rules → the Arabic name **52px Amiri** → the Latin name 22px Playfair at `.17em`
→ the role 11.5px in eyebrow blue at `.28em`.

**Seam** `bottom: 430px`, **8px**, red for the left half and blue for the right.
This is the identity's signature; it closes the navy into the white.

**White foot**, y 1150 → 1524:

- the Arabic wordmark FIRST in the markup so it paints behind everything: `left: 796px; top: -5px; width: 400px; opacity: .15`
- the facts column at `left: 84px; top: 26px; width: 352px` — Date / Time / Venue, each a 9.5px micro label, a 25px line, an 18px Cairo line, separated by a 1px rule
- the pack lockup at `right: 154px; top: 48px`, Royafloxacin **230px** tall with `margin-right: 34px`, Saginkgo **219px**

**Base bar** 56px of base navy, 10.5px micro at each end.

### The pack lockup — four rejected designs' worth of rules

1. **Never overlap the two cartons.** Negative margins were tried and rejected outright. Measure the gap on the render: 42px clear on the card, 73px on the one sheet.
2. **Do not shrink them to make room.** When they stopped fitting, the facts column came down from 470px to 352px and its figures from 27px to 25px — the packs stayed at 230/219.
3. They sit **aside** each other on the right of the foot, bottoms aligned, Royafloxacin in front (`z-index: 2`).
4. Name them in full somewhere on the piece. On the one sheet that is an **In combination** block: each product name with a 3px rule in its own colour, joined by a quiet `+`.

### The Arabic wordmark — six iterations' worth of rules

- **Flatten to one ink and draw it faint and large.** `assets/sato-arabic-navy.png` is already flattened to `#001a52` with the antialiased lightness folded into alpha. On navy, add `filter: brightness(0) invert(1)` to make it white and drop it to 5%.
- **Never crop the right edge.** Arabic reads right to left, so the right edge is where *both* words begin. Lay its ink to the trim; do not pass it. The asset carries no transparent margin — its ink box fills the file edge to edge — so at the approved placements the ink lands **4px inside the trim on the card** and **8–9px on the one sheet**, which is the same thing the margin check below means by "right 4–5". Measure it at a threshold of 240 or looser: the wordmark is drawn at 15% and its densest ink is only about 217, so tightening to 230 stops finding the wordmark and starts finding the carton instead — 154px in on the card, 247px on the sheet, which are just the two `plock` right offsets.
- **About 62% of its ink belongs behind the cartons**, leaving ساتو clear on the open white. That proportion is the approved one — 62.5% on the card, 62% on the sheet.
- **Position it by its ink centroid, not its box.** The artwork is bottom-heavy: the oval sweep and فارما carry the weight low while only thin ascenders reach the top, so **its ink centre is at 63.2% of the file's height**, not 50%. Centring the *file* on a name puts the name visibly high. Measure and place:

```python
a = np.asarray(Image.open('sato-arabic-navy.png').convert('RGBA'))
rows = (a[..., 3] > 25).astype(np.float32).sum(axis=1)
cy = float((rows * np.arange(len(rows))).sum() / rows.sum())   # -> 0.632 * height
```

## The name-only card

For a guest who sent no photograph. **Do not draw an empty plate.** A white
placeholder was built once and rejected: *"remove the photo placeholder and make
the navy background as it is, and premium-polish the name itself."*

The navy runs straight through where the portrait would sit, and the name becomes
the subject — 96px Amiri, white, `white-space: nowrap`, inside a 680×500 block at
`top: 400px`. What keeps it in the set is the **bracket pair** marking the same
optical space the portraits occupy: a 58px red corner at top-left, a 58px blue
corner at bottom-right, both offset 17px outward. Behind the name, the Arabic
wordmark at 5% white, placed by the centroid rule above. Under it, a red and a
blue 56×3 rule.

The name is said **once**, large. Strip the Arabic line out of the guest block
below and leave it the label, the Latin name and the role, then raise that block
to `top: 1028px` so the role line still lands at the set's shared y.

One size for all the name cards, set by the longest — measured at 96px they came
within 8% of each other, so a single size leaves them optically identical.
**If the fit loop scales long names UP, the names are wrapping**: measure with
`white-space: nowrap` or the measurement is of a wrapped block, not a name.

## The one sheet — 2480 × 2552

Not a contact sheet. The same identity at poster scale, with the ten cards five
across and two down.

Margin **97px** each side, gap **34px**, each card **430×566** (the card's own
1200:1580). Header chrome at **1.9×** the card's, footer at **1.6×** — scaled from
the card rather than invented, which is why it reads as the master of the set.
Grid at `top: 636px`; the seam, white foot and 90px base bar close it exactly as
on a card. Each card gets a 1px white keyline at 16% plus a drop shadow, because
it is depicting a printed card as an object.

## Rendering

HTML plus headless Chrome. The in-app browser pane cannot drive `file://` pages.

```bash
chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir=<scratch> --force-device-scale-factor=1 \
  --window-size=1200,1580 --virtual-time-budget=11000 \
  --screenshot=out.png card.html
```

Ship **1×** for sending and **2×** (`--force-device-scale-factor=2`) for print.
Give fonts a real budget — 11s for a card, 20s+ for the one sheet; a short budget
silently renders Playfair as a fallback serif and nothing in the file says so.

## Verify the rendered pixels, never the source

Every defect this identity has had was correct in the CSS and wrong on the page.
Run these over the whole set:

- **every file the exact size**, and the bottom-left pixel `(0, 10, 38)` — proof the base bar closed
- **the role line at one identical y on every card** (1120 on the 1580 card). A name card that forgets to raise its guest block drifts, and only a cross-card comparison catches it
- **margins**: left 83–84, right 4–5 — the right is the wordmark deliberately run to the trim
- **the gap between the cartons**, in pixels, every time the foot changes
- **the wordmark's ink centre against the name's centre** — target 0px
- **portrait tone across the set**: `check()` in `portrait-pipeline.py`. A healthy set clips 0.9–5.6% of pixels at 253+; one at 14% is an overexposed original, not a grading mistake

Two traps worth naming. A hairline that spans the full width **pollutes a column
measurement** — skip its rows or you will measure 81px of clear space where there
are 299. And printing Arabic to a Windows console throws
`UnicodeEncodeError: 'charmap'`; prefix `PYTHONIOENCODING=utf-8`.

## What was rejected, and why

Kept because the reasons are not re-derivable:

- a dark foot — the white foot is the contrast that makes the navy read
- the products shrunk, and the products overlapping — both refused outright
- a white nameplate for a guest with no photo
- the wordmark at 540px and at 520px — both cropped the calligraphy; 500 is the ceiling on a 1200 card
- the wordmark at 250px — read as a stamp rather than a watermark
- cropping the wordmark's right edge to fit
