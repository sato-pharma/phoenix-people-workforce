---
name: pedia-identity
description: The Pedia identity — the deep teal field, the honeycomb and the three-hexagon cluster built around Lacto Advanced, the line's hero (improved infant formula, stage 1 and stage 2, 400 g), with Ivyronc ivy leaf syrup and Guamusin sachets beside it. Carries the exact geometry of the invitation card and its name-only variant, the A4 line sheet, the A4 monthly closing sheet, the rep ranking workbook's chrome, the measured pack inks (gold and aqua), the equal-optical-area pack law, the hexagon mark, the seeded honeycomb texture and the verifier. Use when building an invitation, a round-table or speaker card, a guest one-sheet, a line or product sheet, a monthly closing sheet for the line, the rep ranking workbook's chrome, an event poster, a save-the-date or any personalised piece for Lacto Advanced, Ivyronc, Guamusin or a Pedia team event. It does NOT replace sato-pharma-identity (certificates, documents, the business card, the website), nor cns-identity, nor anti-infective-identity.
---

# Pedia identity

The event and product look for the Pedia line: a deep teal field with a honeycomb
drawn faintly across it, one name or one photograph held in the middle, and a white
foot carrying the facts, the packs and the company's own Arabic calligraphy.

It is the third sibling of `cns-identity` and `anti-infective-identity`. **The
skeleton is shared on purpose** — the geometry, the seam, the foot, the base bar,
the micro labels — so a Pedia card stacks with a CNS card and reads as one company.
Only the colours, the mark, the texture and the products change.

**Lacto Advanced is the line.** Measured from the Monthly Closing engine for
September 2026 (total 2,786,792 EGP): Lacto Advanced 1 — 52.2%, Lacto Advanced 2 —
34.5%, Ivyronc — 11.8%, Guamusin — 1.5%. Lacto Advanced was 93.7% of the line in
July and 92% in August. **Never quote a share on a piece without re-reading the
closing** — the Monthly Closing is the only sales truth and these figures move.

```
assets/
  lacto-advanced-pair-cans.png     ratio 1.0086   stage 1 and stage 2 cans, ONE picture
  ivyronc-syrup-pack.png           ratio 0.7328   bottle and carton
  guamusin-sachet-pack.png         ratio 1.443    carton and sachet row, cut by a traced polygon
  hex-cluster.svg                  the mark, one ink through currentColor
  hexfield.svg · hexfield-sheet.svg · hexfield-closing.svg · hexfield-ranking.svg
                                   the honeycomb at the card, line sheet, closing sheet and ranking field
  sato-arabic-navy.png · sato-pharma-reverse.png   the house marks, copied from cns-identity
reference/
  name-card.html · invitation-card.html   1200×1580
  line-sheet.html · closing-sheet.html    2480×3508, A4 at 300 dpi
  ranking-chrome.html                     one masthead and nine letterhead bars
  hexfield.py                             the texture generator
  verify.py                               measures a RENDERED piece; exit 1 on any failure
examples/
  name-card.png    1200×1580 as rendered
  line-sheet.png · closing-sheet.png   1240×1754, HALF the print size
```

**Fonts are not duplicated.** Every page links
`../../cns-identity/assets/fonts/fonts.css` — the same four self-hosted faces
(Playfair Display, Inter, Cairo, Amiri) — so this skill depends on `cns-identity`
being present. The CDN is not linked: headless Chrome here fails DNS outright.
`cns-identity/reference/fetch-fonts.py` rebuilds the folder.

Everything in `reference/` is a **specimen**: the event, the guest, the date and the
venue are placeholders so each file renders on its own, and the closing sheet's
figures are arithmetic that lands on exactly 100.0%. The product facts are read off
the packs.

## Rule zero

**A design the owner hands you is FINAL.** Fix defects — bleed, resolution, fonts,
colour space, cropped boxes, typos — and keep the look identical. This file is for
NEW pieces. **Never retouch the manufacturer's mark off a pack**: cut the pack out of
its background and change nothing inside its trim.

## Against the CNS card, exactly four things change

| | CNS | Pedia |
|---|---|---|
| field | forest green `#2f6b33 → #04210f` | deep teal `#1c7f6c → #032427` |
| seam and brackets | Tebofortin leaf + amber | Lacto gold + stage-1 aqua |
| field texture | the connectome | the honeycomb |
| centre mark of the ruleset | the ginkgo leaf | the three-hexagon cluster |

## Palette

Measured off the packs, not chosen.

| Token | Hex | Where |
|---|---|---|
| field teal | `#1c7f6c 0% → #136356 36% → #0a4645 70% → #032427 100%` | a radial; **the four stops never change**, the ellipse and its centre scale to the piece |
| base | `#032427` | the closing bar; the zebra row is this at 6% over white, `(240, 242, 242)` |
| Lacto gold | `#c17e11` (hi `#f0b94a`, lo `#8a5a0c`) | the can lid and label band. **Left** half of every seam |
| Lacto aqua | `#3eab95` (hi `#7fd9c6`, lo `#2a7a69`) | the stage-1 can. **Right** half of every seam |
| eyebrow / name | `#a9e3d6` / `#c4efe5` | the eyebrow, role line, "guest of honour" label |
| ink / soft / faint / hair | `#0a1322` · `#6b7782` · `#8c98a4` · `#e4e9ee` | the white foot, unchanged from the house |

**Reserved — never on a piece:** Lacto Advanced 2's indigo `#191e68`. It is one step
off the house navy and reads as a mistake rather than an accent.

**Product inks, only on a piece about that product:** Ivyronc green `#2e8c2e` and
yellow-green `#d1e43d`; Guamusin blue `#0476be` and yellow `#e8de3b`.

**Colour meaning on the closing sheet:** aqua is at or above 100%, gold is below.

## The mark and the texture

**The cluster** is three hexagons, one large and two small, taken from the
arrangement of the badges on the Lacto cans (Multi Vitamins, DHA & ARA, Vitamin D3,
Ca). One ink through `currentColor`; it sits at the centre of the ruleset, in the
corner seal and beside a foot section head. Never a watermark, never outlined.

**The honeycomb** is generated, not traced — the badges are the manufacturer's
artwork. `reference/hexfield.py` draws **patches** of cells that thin out from a
centre, never a lattice (a lattice reads as wallpaper), each patch at its own cell
size, a few cells dropped, a few filled. One ink, white, low opacity — never in gold
or aqua, which belong to the seam. The centre is kept clear for the title.
The shipped SVGs are the set; regenerating with other seeds gives a different
texture of the same character.

```bash
python reference/hexfield.py --seed 7 --patches 9 --width 1200 --height 1150 --out assets/hexfield.svg
```

## The pack law

Three packs shot at three angles cannot share a height. **Equal optical area,
bottoms aligned**: each height is `sqrt(A / ratio)`, written out in the CSS rather
than computed so a swapped pack is re-measured.

- Line sheet, A = 130000: Lacto 359, Ivyronc 421, Guamusin 300 px — **no reflection**
  (it takes no layout space, so it runs through the captions).
- Ranking masthead foot, A = 62000: Lacto 248, Ivyronc 291, Guamusin 207 px, on a 1px reflection.
- Card, two packs: Lacto pair 262 px in front, Ivyronc 252 px, `margin-right: 34px`,
  never overlapped (34 px clear measured) and never shrunk to make room.

The Lacto cans are **one picture of both stages**; never split it. Name every
product on the piece. The baked reflections were trimmed off the Lacto and Ivyronc
cut-outs, and Guamusin was cut by a hand-traced polygon because an auto flood-fill
leaked into its blue panel.

## The closing sheet — what is a business rule, not design

- 🔴 **IT REPORTS; IT NEVER COMPUTES.** Every sales and every target figure is read
  from the published Monthly Closing. A sheet that re-derives either half is the bug.
- 🔴 **THE UNITS COLUMN IS NEVER TOTALLED.** Cans, millilitre syrup and sachets are
  not one quantity. The total row's units cell is an em dash and `verify.py --closing`
  measures its ink (a numeral is ~35 px tall, a dash 4). The line totals by value.
- 🔒 **THE FOOT OBEYS THE INK RULE; THE FIELD DOES NOT.** No filled area in the foot
  except the 6% zebra row.
- No people on it. By area and by presentation, nothing else.

## The rep ranking chrome

`ranking-chrome.html` renders one masthead (`?piece=full`, 2480×1382) and nine bars
(`?piece=strip&tab=<ranking|who|product|filter|trend|districts|regions|months|units>`,
2480×176). Excel can draw none of this, so it is rendered and embedded as pixels.
**Not one figure and not one month is rendered into the artwork** — they are cells,
built from the month being exported. A worked sheet gets the bar, never the
masthead, because Excel's frozen pane would pin a tall masthead over the table.

**Not done here, and a separate ask:** the code-side dress (a `PEDIA_RANKING_DRESS`,
`public/brand/pedia-ranking/`, and widening `isRepRankingLine` so the Pedia
workbook picks this up). Until then the Pedia ranking workbook does not wear this
chrome; this folder is the artwork only.

## Rendering

HTML plus headless Chrome (the in-app browser cannot drive `file://`). Both the page
URL and `--screenshot` must be **absolute**; a relative one fails with
`ERR_NAME_NOT_RESOLVED` or `Failed to write file`, which reads like a font failure.

```bash
chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir=<scratch> --force-device-scale-factor=1 \
  --window-size=2480,3508 --virtual-time-budget=22000 \
  --screenshot="<ABSOLUTE>/closing-sheet.png" "file:///<ABSOLUTE>/reference/closing-sheet.html"
```

The sheets are authored at **2480×3508 CSS px** — a `1240×1754` window crops them.
Window size is the page size; the shipped examples are downscaled afterwards.
Give fonts a real budget: 11 s for a card, 22 s for a sheet.

## Verify the rendered pixels, never the source

```bash
python reference/verify.py examples/name-card.png --card
python reference/verify.py <full-size render>/line-sheet.png --sheet
python reference/verify.py <full-size render>/closing-sheet.png --closing   # FULL size, not the half-scale example
```

It measures the size, the base bar `(3, 36, 39)`, the seam's gold left and aqua
right, the role line at y 1113, the foot's left margin, the wordmark running to the
trim, that no two packs touch, the units dash and the zebra row. Exit 1 on any
failure. All three pass on the shipped renders (7, 5 and 8 checks). The
position-dependent closing check reads the dash at `y 2830–2900, x 1250–1500`; move
it if the table's rows change.

## What was rejected

- **Indigo on a piece** — it is Lacto 2's ink and sits a notch off the house navy.
- **Tracing the badge hexagons** — manufacturer artwork; the cluster and honeycomb are our own drawing.
- **Auto flood-fill for Guamusin** — leaked into the blue panel; hand-traced instead.
- **Equal height for the packs** — the Ivyronc carton stands and the Guamusin row lies flat.
- **A reflection on a row of three** — it runs through the captions.
- **118 px headline figures on the closing sheet** — two 10,000,000 figures crowd; 110 px.
- **Copying the fonts** — one self-hosted set, linked from `cns-identity`.
