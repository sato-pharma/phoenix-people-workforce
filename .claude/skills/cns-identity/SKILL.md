---
name: cns-identity
description: The CNS identity — the forest-green field, the connectome and the ginkgo built around Tebofortin, the line's hero (Ginkgo biloba leaves extract, 40 / Forte 80 / Intens 120 / Max 240 mg and the 40 mg/ml oral drops), with Conviban beside it. Carries the exact geometry of the invitation card and its name-only variant, the A4 line sheet, the measured pack inks, the two pack-lockup laws, the ginkgo mark that must never read as a heart, the seeded connectome texture and the self-hosted typefaces. Use when building an invitation, a round-table or speaker card, a guest one-sheet, a line or product sheet, a monthly closing sheet for the line, an event poster, a save-the-date or any personalised piece for Tebofortin, Conviban or a CNS team event. It does NOT replace sato-pharma-identity, which still governs certificates, documents, the business card and the website, and it does not govern Anti-Infective pieces — those are anti-infective-identity.
---

# CNS identity

The event and product look for the CNS line: a deep forest-green field with a
connectome drawn faintly across it, one name or one photograph held in the middle,
and a white foot carrying the facts, the Tebofortin packs and the company's own
Arabic calligraphy.

**Tebofortin is the line.** It carried **83% of CNS value** the last time that was
measured — 6.7M of **July 2026's** 8.1M, read on 11 August 2026 in the factory-price
work recorded under `cns-factory-price-basis-is-unresolved` — so it is the hero on
every piece and the others sit beside it. That is a price-basis figure, not a
closing figure: the Monthly Closing is the only sales truth, so re-read it there
before quoting the share anywhere a manager will see it. The line is Tebofortin, Conviban, Rispadex, Dopaminect and
Dolabactin; only the first two have pack art in this skill.

```
assets/
  tebofortin-40-ar-carton.png        1000×509   ratio 1.9646   Arabic 40 mg, lying flat
  tebofortin-forte-80-carton.png      974×747   ratio 1.3039   Forte 80 mg
  tebofortin-intens-120-carton.png    992×760   ratio 1.3053   Intens 120 mg
  tebofortin-max-240-carton.png       684×760   ratio 0.9000   Max 240 mg, standing
  tebofortin-drops-40-carton.png      653×760   ratio 0.8592   🔴 WHITE GROUND, NO ALPHA
  conviban-trio-carton.png           1000×330   ratio 3.0303   topiramate 25 / 50 / 100 mg
  connectome.svg · connectome-sheet.svg          the field texture, generated and seeded
  connectome-closing.svg                         the same, at the closing sheet's shorter field
  ginkgo-leaf.svg                                the botanical mark, one ink
  sato-arabic-navy.png · sato-pharma-reverse.png the house marks, as the sibling skill ships them
  fonts/                                         the four typefaces, self-hosted (397 KB)
reference/
  name-card.html        the card, name variant — 1200×1580, renders standalone
  invitation-card.html  the same card with the photograph in it
  line-sheet.html       the line sheet — 2480×3508, A4 at 300 dpi
  closing-sheet.html    the monthly closing sheet — 2480×3508, the month's result for the line
  connectome.py         the field texture generator
  fetch-fonts.py        rebuilds assets/fonts from Google Fonts
  verify.py             measures a RENDERED piece; exit 1 on any failure
examples/
  name-card.png         1200×1580, as rendered
  line-sheet.png        1240×1754 — HALF the print size, so the folder stays near its sibling's weight
  closing-sheet.png     1240×1754 — half print size as well
```

Everything in `reference/` is a **specimen**: the event, the guest, the date and
the venue are placeholders so each file renders on its own. Nothing in them is a
scheduled Sato event. The product facts are read off the cartons and are not.

## Rule zero

**A design the owner hands you is FINAL.** Fix defects — bleed, resolution, fonts,
colour space, cropped boxes, typos — and keep the look identical. This file is for
NEW pieces in this family; it never overrides something he supplied. Unsure
whether a change alters the look? Leave it and flag it.

**Never retouch the manufacturer's mark off a carton.** The packs are Marcyrl's
artwork; the piece around them is Sato's. Cut the carton out of its background and
change nothing inside its trim.

## Its two siblings

`sato-pharma-identity` still governs certificates, PDFs, the business card, the
website and anything that reads as a *document*. `anti-infective-identity` governs
Royafloxacin and Saginkgo event pieces. **This one governs CNS pieces and nothing
else.** The three share one skeleton — the field, the seam, the white foot, the
base bar, the Arabic wordmark, the micro label — and differ only where the line
differs.

Against the Anti-Infective card, exactly four things change, and nothing else:

| | Anti-Infective | CNS |
|---|---|---|
| field | navy `#0b3685 → #000a26` | forest green `#2f6b33 → #04210f` |
| seam and brackets | Royafloxacin red + Saginkgo blue | Tebofortin leaf + Tebofortin amber |
| field texture | concentric arcs from the two bottom corners | the connectome |
| centre mark of the ruleset | an 8px white diamond | the ginkgo leaf |

The geometry — 1200×1580, the field ending at y 1150, the 430px foot, the 56px
base bar, the 84px margins, the 26/33 keyline frames, the role line at y 1113 —
is identical, deliberately, so a CNS card and an Anti-Infective card stack in one
pile and read as one company.

## Palette

Measured off the cartons, not chosen: each ink is the median of its hue family
across the pack photographs, which is the printed ink rather than a lit highlight.
`reference/` has nothing that samples them again — the numbers below are the set.

| Token | Hex | How it was measured, and where it is used |
|---|---|---|
| field green | `#2f6b33 0% → #1d5226 36% → #0f3a1a 70% → #04210f 100%` | a radial anchored on the carton's own dark panel, whose mode is `#2a5824` (42.5% of the Max carton's coloured pixels). **The four stops never change; the ellipse and its centre are scaled to the piece** — `1180px 820px at 50% 33%` on the card, `2600px 1900px at 50% 22%` on the sheet |
| base green | `#04210f` | the closing bar, and the shadow end the duotone is cut from |
| Tebofortin leaf | `#63b24a` | the ribbon green, read as `#63b14a` / `#65b34c` / `#65ae41` on three packs. Left half of every seam, the top-left bracket, the first product rule |
| Tebofortin amber | `#e5732a` | the Intens wordmark's orange, median `#e37329` / `#e77325`. Right half of every seam, the bottom-right bracket, the second product rule |
| leaf-hi / amber-hi | `#8fd36f` / `#ffa061` | the flanking product labels, highlights only |
| eyebrow green | `#a7e08f` | the eyebrow, the role line, the ladder's product names |
| name green | `#bdeaa9` | the name card's "guest of honour" label |
| pack blue | `#0b3089` | measured on the Intens wordmark and the manufacturer's mark. **Reserved** — it is one notch off the house navy `#0b3685`, so it reads as a mistake rather than an accent. Never put it on a piece |
| Conviban amber / sky / green | `#eda624` · `#5fa9d6` · `#28ad40` | the three strengths' own colours. Only on a piece about Conviban |
| ink / soft / faint / hair | `#0a1322` · `#6b7782` · `#8c98a4` · `#e4e9ee` | the white foot, unchanged from the house |

## Typography

- **Playfair Display** — the event title, the strength numerals, and a guest's Latin name. Nothing else.
- **Inter** — every label, fact and micro line.
- **Cairo** — the Arabic facts in the white foot (date, time, venue).
- **Amiri** — Arabic personal names. Never Cairo for a name; naskh carries a name, a UI face does not.
- Micro label: bold, UPPERCASE, tracking `.26em`–`.34em`. In Arabic, **no tracking** — it pulls joined letters apart.

🔴 **THE FOUR FACES ARE SELF-HOSTED IN `assets/fonts/`, AND THE CDN IS NOT LINKED.**
Headless Chrome on this machine fails DNS outright — `net::ERR_NAME_NOT_RESOLVED`,
and the whole page load fails, so no screenshot is written at all. Even where it
resolves, a slow fetch renders Playfair as a fallback serif and nothing in the file
says so. `reference/fetch-fonts.py` rebuilds the folder: latin for Playfair Display
and Inter, latin **and arabic** for Cairo and Amiri, 13 `@font-face` blocks over 8
woff2 files. Drop the arabic subsets and every Arabic line silently falls back to a
system face.

## The invitation card — 1200 × 1580

Drawn top to bottom. `reference/name-card.html` is the file; these are its numbers.

**Green field** `inset: 0 0 430px 0`, so the field ends at **y 1150**. Then the
connectome at **30%**, a `feTurbulence` grain at 5.5% overlay, a vignette, and a
double keyline frame inset **26px and 33px**.

**Head** at `top: 108px`, centred: eyebrow 11.5px → `SATO` 27px at `.66em` tracking
→ the event name **92px Playfair** → a ruleset **340px** wide (leaf rule, 38×33
ginkgo, amber rule) → the place line 10.5px at `.32em`.

**Marks** — the reverse logo at `left: 84px; top: 56px; height: 58px`; a square date
seal at `right: 84px; top: 52px`, 118×118, a 1px white keyline at 30% over a 26%
black ground, plus a 5px inset white glow at 4.5%, the day in 44px Playfair over a
34px leaf→amber rule over the month in 9px micro.

**The guest.** Two variants, one y.

- *Photograph* (`invitation-card.html`): a 452×566 **white mat with 13px padding**
  at `top: 346px`, the image `object-fit: cover` with a 1px inset keyline at 17%
  black, brackets 58px at ±17px — leaf top-left, amber bottom-right. The guest
  block follows at `top: 944px`: the invitation line between two 62px fading rules
  → the Arabic name 52px Amiri → the Latin name 22px Playfair at `.17em` → the role
  11.5px in eyebrow green at `.28em`.
- *Name only* (`name-card.html`), for a guest who sent no photograph: **do not draw
  an empty plate.** The field runs straight through and the name becomes the
  subject — 96px Amiri, white, `white-space: nowrap`, in a 680×500 block at
  `top: 400px`, inside the same bracket pair, with the Arabic wordmark behind it at
  5%. The name is said **once**: strip the Arabic line out of the guest block and
  raise that block to `top: 1028px` — **exactly 84px, the height the Arabic line and
  its margin occupied** — so the role line lands at the set's shared y.

🔴 **THE ROLE LINE STARTS AT y 1113 ON EVERY CARD, BOTH VARIANTS.** It is the one
measurement that proves a mixed set hangs together, and `verify.py` reads it off
the render by **luminance**, never by darkness — the type is white on a dark field,
so a dark-ink threshold reports the whole guest block as one solid band and the
check passes while the card is wrong.

**Seam** `bottom: 430px`, **8px**, leaf for the left half and amber for the right.
This is the identity's signature; it closes the field into the white.

**White foot**, y 1150 → 1524:

- the Arabic wordmark FIRST in the markup so it paints behind everything: `left: 796px; top: -5px; width: 400px; opacity: .12`
- the facts column at `left: 84px; top: 26px; width: 352px` — Date / Time / Venue, each a 9.5px micro label, a **23px** line, an 18px Cairo line, separated by a 1px rule. 🔴 **23px, not the Anti-Infective's 25px**: "Wednesday 18 November 2026" wraps to two lines at 25px in 352px and pushes the Time rule down. A long weekday is the common case, not the edge case
- the pack lockup at `right: 140px; top: 52px`, Intens 120 **218px** tall with `margin-right: 34px`, Forte 80 **208px**

**Base bar** 56px of base green, 10.5px micro at each end.

## The two pack-lockup laws

**Two packs — the card.** Bottoms aligned, Intens in front (`z-index: 2`), on a 1px
`-webkit-box-reflect`, which is how a packshot sits on a surface.

1. **Never overlap them.** Measured on the render: **42px clear** at x 755.
2. **Do not shrink them to make room.** The facts column and the right offset move
   first. The CNS pair is 218/208 rather than the Anti-Infective's 230/219 because
   these cartons are **wider** — ratio 1.305 against 1.19 — so at the same height
   they are 26px wider each and collide with the facts column.
3. Name both products somewhere on the piece. On the card that is the two vertical
   flank labels beside the guest.

**Three or more — the sheet.** Different laws, because the two-pack rules break.

4. 🔴 **EQUAL OPTICAL AREA, NOT EQUAL HEIGHT.** Five packs shot at five angles
   cannot share a height: the 40 mg lies flat (ratio 1.9646) and the Max stands
   (0.9000), so one height makes the flat one more than twice the width of the
   standing one and the row reads as a mistake. Each height is
   **`sqrt(92000 / ratio)`** — 216 / 266 / 266 / 320 / 327 px — so every pack covers
   the same area, bottoms aligned, and the row reads as one set. Write the heights
   out in the CSS rather than computing them, so a pack swapped later is
   re-measured instead of silently rescaled.
5. 🔴 **NO REFLECTION ON A ROW OF THREE OR MORE.** A reflection takes no layout
   space, so with a caption under each pack the tails run straight through the type
   — and five of them read as water rather than as a surface. The card keeps its
   reflection; the row does not.
6. **The drops carton has a WHITE GROUND and no alpha.** Its white face leaks into
   the white background through the thin box edge, so a flood-fill cut-out comes
   back with holes punched through the pack. It ships as a tight crop on white and
   may therefore sit **only on the white foot** — never on the green field.

## The ginkgo

🔴 **IT IS A CIRCULAR SECTOR, NOT TWO LOBES, AND IT IS WIDER THAN IT IS TALL.**
Blade 189 × 104, ratio 1.82: a true arc of radius 104 about the stalk head, running
155° to 25°, with **straight** sides down to the stalk and a narrow **slit** on the
centre line. Two earlier drafts built it from bezier lobes with a wide V notch, and
at 25–40px — the only size this mark is ever used at — both read as a playing-card
heart. Never narrow it to fit a column: scale it down or leave it out.

It ships as one ink through `currentColor`, so a caller sets the colour and the
mark never carries a second one. It appears as the centre of the ruleset (38×33 on
the card, 72×63 on the sheet), in the sheet's corner seal, and beside a section
head in the foot. Never a watermark — that is the Arabic wordmark's job — and never
outlined.

## The connectome

Every Tebofortin carton carries a dot-and-line network over a brain outline. That
is Marcyrl's printed artwork, so this does **not** trace it: `reference/connectome.py`
generates a net of the same character, deterministically from a seed, as Sato's own
texture. Same idea, our own drawing.

```bash
python reference/connectome.py --seed 11 --nodes 74 --width 1200 --height 1150 --max-edge 215 --out assets/connectome.svg
python reference/connectome.py --seed 23 --nodes 150 --width 2480 --height 2100 --margin 70 --max-edge 300 --out assets/connectome-sheet.svg
```

- **Cap the edge length.** The first pass joined nearest neighbours with no cap and
  drew chords straight across the field and through the guest's name. 215px on the
  card, 300px on the sheet.
- **Drawn at 30%**, in one white ink, never in leaf or amber. The seam owns the
  accent colours; a texture that competes with them is the defect.
- Nodes are jittered and never snapped — a lattice reads as a graphic pattern, a
  connectome reads as a nervous system — and a handful are hubs at double radius,
  because a single radius reads as confetti.

## The line sheet — 2480 × 3508

**A4 portrait at 300 dpi**, deliberately, because this is a printed sheet. It is not
the Anti-Infective one-sheet's job: that one depicts ten printed invitation cards,
this one is the line.

The green field runs 0 → 2150 and carries the title block (chrome at **1.9×** the
card's: eyebrow 22px, SATO 51px, TEBOFORTIN 175px, ruleset 646px), the **strength
ladder** at `top: 1020px` — 40 / 80 / 120 / 240 as 186px Playfair numerals with the
unit as a separate label beside each, never `40mg` set as one word, which reads as
a part number — then the Arabic line and the standardisation sentence. The seam is
**16px** here, 1.9× the card's 8px. The white foot carries the five presentations
under the equal-area law and a three-column note; the base bar is 100px.

## The closing sheet — 2480 × 3508

The month's result for the CNS line, in the line's own identity. Same A4 at 300 dpi,
same field → seam → white foot → base bar, but the proportions invert: the green
field is **1250** tall against the line sheet's 2150, because here the tables are the
subject and the chrome is not. `connectome-closing.svg` is the texture cut to that
height — the sheet texture would crop badly.

The field carries the title (**148px**, not the line sheet's 175px — *MONTHLY
CLOSING* is fifteen characters and at 175px it runs past the 252px margins; measure
a title before reusing a size), the month, the **SPECIMEN** stamp, and the three
headline figures at `top: 830px` in the engine's own order: **sales, target,
achievement**. The achievement numeral is the one number on the sheet allowed a
colour — leaf at or above 100%, amber below.

The white foot carries two tables and a three-column note.

**Four laws govern it, and three of them are business rules, not design ones.**

- 🔴 **IT REPORTS; IT NEVER COMPUTES.** Every sales figure *and* every target figure
  is read from the **published Monthly Closing** for the month named in the field —
  the one source of truth for both halves, system-wide. A sheet that re-derives
  either half from its own query, its own table or its own period is the bug, never
  a variant, and it will disagree with the screens the managers read. Fill it from
  the closing or do not fill it.
- 🔴 **THE UNITS COLUMN IS NEVER TOTALLED.** Units of different products and
  different concentrations are not addable — 96,000 tablets of 40 mg and 24,000 ml
  of drops are not 120,000 of anything. The total row's units cell is an em dash
  **deliberately**, the note beside it says why, and `verify.py --closing` measures
  the ink in that cell so a later edit cannot quietly "complete" the table. The line
  totals by **value**.
- 🔒 **THE FOOT OBEYS THE INK RULE; THE FIELD DOES NOT.** The field is identity
  chrome and carries its gradient. A data table a manager reads is a *document*, so
  the house rule governs it: **no filled areas at all except the 6% zebra row** —
  no filled header, no filled total row, no tinted achievement cell. The colour
  lives in the numeral.
- **There are no people on it.** A rep ranking is personal performance data and does
  not belong in a design template. By area and by presentation, nothing else.

Two sizing notes. Cells are **38px**, not the line sheet's 25px: at 300 dpi that is
9 pt against 6 pt, and this sheet is *read* where the line sheet is *looked at*.
And the table is `table-layout: fixed` over a `<colgroup>`, never auto over a
min-width — a column that decides its own width is a column that can push the sheet
past the trim.

Every number in the shipped file is **specimen arithmetic**: the areas sum to the
total, the shares sum to 100, and the line lands on exactly **100.0%** so that no
reader can mistake it for a real month. The area names are the structure, not data.


## Rendering

HTML plus headless Chrome. The in-app browser pane cannot drive `file://` pages.

```bash
chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir=<scratch> --force-device-scale-factor=1 \
  --window-size=1200,1580 --virtual-time-budget=11000 \
  --screenshot="<ABSOLUTE windows path>.png" \
  "file:///F:/.../reference/name-card.html"
```

Two invocation traps, both of which cost a render here:

- 🔴 **Pass the page as an absolute `file:///` URL.** A bare relative filename is
  treated as a host and the run dies with `net::ERR_NAME_NOT_RESOLVED` — which
  reads exactly like a failed font fetch and sends you looking at the wrong thing.
- 🔴 **`--screenshot` must be an absolute path too.** Chrome resolves it against its
  own working directory, not the shell's, and answers a relative one with
  `Failed to write file … (0x3)` **after** loading the page successfully.

Ship **1×** for sending and **2×** (`--force-device-scale-factor=2`) for print. Give
fonts a real budget — 11s for a card, 22s for the sheet.

## Verify the rendered pixels, never the source

```bash
python reference/verify.py examples/name-card.png  --card
python reference/verify.py examples/line-sheet.png --sheet
python reference/verify.py examples/closing-sheet.png --closing   # at FULL size, not the half-scale example
```

It measures the size, the base bar's closing pixel `(4, 33, 15)`, the seam's two
halves, the role line's y, the foot's left margin (83–85), the wordmark running to
the trim, and — on the line sheet — that no two packs touch. On the closing sheet it
measures the two rules that are worth a check: that the **units total is a dash and
not a sum** (a numeral there is ~35px of ink, a dash is 4), and that the **zebra row
is the only filled area** in the foot. Exit 1 on any failure, so it
can gate a build.

**It was proved by breaking the card twice and watching its own assertions fire**,
each restored from a patch rather than from `git checkout`, which would have taken
the rest of the work with it:

| Break | What fired |
|---|---|
| the seam's two halves swapped | *seam leaf on the left* and *seam amber on the right*, exit 1 |
| the guest block dropped 20px | *role line starts at y 1113* → `y=1133`, exit 1 |
| the units column totalled (`360,000` for the dash) | *units total is a dash, not a sum* → `ink is 35px tall`, exit 1 |
| every row given the 6% fill, not just the even ones | *the row above it is unfilled* → `(240, 242, 241)`, exit 1 |

Two traps worth naming beyond that. A hairline that spans the full width
**pollutes a column measurement** — pick a band with no full-width rule in it or
you will read 0 margin where there are 250 clear pixels. And printing Arabic to a
Windows console throws `UnicodeEncodeError: 'charmap'`; prefix `PYTHONIOENCODING=utf-8`.

## Portraits

The portrait law is **inherited verbatim** from `anti-infective-identity` — the mat,
the crop, the grey-world balance, the percentile normalise, the regrade, the
highlight knee, and `check()` reading a healthy set as clipping 0.9–5.6% of pixels
at 253+. Use that skill's `reference/portrait-pipeline.py` as it stands.

One constant changes: `SHADOW` becomes **`#07271a`**, the green field's base lifted
exactly as that skill lifts `#000a26` to `#030e30`. 🔴 **That constant is UNPROVEN** —
no CNS portrait set has been graded through it yet. Grade a real set, run `check()`,
and record what it reads before trusting it.

## What was rejected, and why

Kept because the reasons are not re-derivable:

- a bezier ginkgo with a wide notch, twice — both read as a heart at the only size the mark is used at
- a connectome with no edge-length cap — it drew chords through the guest's name
- reflections under the five-pack row — they ran through the captions
- one height for all five packs — the flat 40 mg came out twice the width of the standing Max
- a Google Fonts `<link>` — the page load fails outright here and writes no screenshot
- `pack blue` on a piece — one notch off the house navy, so it reads as a mistake
- the facts column at the Anti-Infective's 25px — a long weekday wraps
