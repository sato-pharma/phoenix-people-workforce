---
name: sato-pharma-identity
description: Sato Pharma's visual identity — the "SHARP" design system (navy ink, one brand blue, 1px rules, micro labels, 90° corners), the real logo files including the Arabic calligraphic wordmark (ساتو فارما), the certificate design (A4 landscape, Pinyon Script name, Arabic watermark), the business card (Montserrat), the satopharma.com website tokens and components, and the LinkedIn post identity (navy, white and flat gold, 1080×1350). Use whenever building or styling anything for Sato Pharma or the Future Talents Program — a certificate, PDF, poster, card, email, slide, LinkedIn or social post, web page, app screen or dashboard — in any repo.
---

# Sato Pharma identity

Everything needed to reproduce the Sato Pharma look in a new place: real artwork, licensed
fonts, exact tokens, and the working code the two live products use.

Skill folder: this skill exists in two copies that must stay word-for-word identical — the owner's
machine-wide copy at `C:/Users/satoh/.claude/skills/sato-pharma-identity/`, and
`.claude/skills/sato-pharma-identity/` in the Phoenix Workforce repository, so worktrees and cloud
sessions have it too. When both load, the machine-wide copy wins, so a change goes into both. The
full pack — with the satopharma.com website images, product photos and a sample certificate — is
kept at `F:\Sato Identity\` on the owner's laptop only.

## Inside Phoenix Workforce — read this first

This skill is Sato Pharma's identity for the Future Talents certificates, the business card, the
website and new stand-alone pieces. **It does not restyle Phoenix.** When the work is inside the
Phoenix Workforce repository:

- **Company documents keep the house identity `SATO-DIS-2026-01`** (`src/lib/hiring-pack/house-identity.ts`),
  with its three logo blues and the INK RULE (no filled areas). Do not swap in this skill's single
  brand blue or its navy bands. Every frozen look in `AGENTS.md` §4 (offer letter, Spotlight sheet,
  payroll exports, closing workbook, weekly exports) stays exactly as it is.
- **Do not copy `assets/sato-pharma-arabic.png` into `public/brand/`.** It is the same drawing as
  Phoenix's placeholder mark before the owner had the dots under the baseline removed, so it would
  put them back and fail `tests/phoenix-official-logo.test.ts`. The placeholder stays until the owner
  sends the official file himself.
- Phoenix already has its own business card generator (`src/lib/business-cards/`); that design is
  the owner's and final — `reference/certificate/business-card.ts` is not a template for it.

```
assets/
  sato-pharma.png           dark mark, for white grounds       355×134
  sato-pharma-reverse.png   reverse mark, for navy grounds
  sato-pharma-arabic.png    real Arabic calligraphic wordmark   1136×842, cropped to its ink
  sato-pharma-arabic-gold.png  the same wordmark flattened to gold #c8a462 (LinkedIn posts)
  website-logo.svg          the website header logo
  fonts/certificate-name.ttf  Pinyon Script (OFL) — the certificate name only
  fonts/sans-bold.ttf, sans-regular.ttf  Montserrat (OFL) — the business card
  fonts/OFL.txt, README.md  licence (must travel with the fonts) and the reasoning
reference/certificate/      FTP-Portal src/lib at 8370eef — the PDF documents
reference/website/          Sato-Pharma-Website at 1b83c5e — Tailwind + React components
reference/linkedin/         the LinkedIn post template (post.html) and its layout proof
```

Copy files out of this folder into the target repo. Never link to this folder from a project —
it exists on this machine only, and a repo that points here breaks everywhere else.

## Rule zero

**A design the owner hands you is FINAL.** When asked to audit or fix one of his designs, fix defects
(bleed, resolution, fonts, colour space, typos) and keep the look identical. This identity is for
NEW work; it never overrides a design he supplied. Unsure whether a change alters the look? Leave it
and flag it.

## Palette

| Token | Hex | Use |
|---|---|---|
| brand blue | `#0879b8` | the one accent: seams, eyebrows, links, focus, selection |
| blue dark / light | `#06628f` / `#5db7e8` | hover; light is the blue that reads on navy |
| ink | `#111820` | headings, navy bands and masses |
| navy | `#17304d` | the certificate name (a hairline at INK reads black; this reads navy) |
| body | `#45515a` | running text |
| soft / faint | `#69757e` / `#8a959d` | secondary text, micro labels, quiet rules |
| line / hair | `#dde4e8` / `#e1e7eb` | 1px keylines and dividers |
| canvas | `#f2f5f7` | tinted ground; alt `#e9eef1` |
| tint / tint line | `#f3f9fc` / `#b9d8e9` | blue-tinted chips and figure strips |
| on navy | ink.rule `#26313b`, edge `#3a4652`, label `#6f7c86`, muted `#9aa6af`, text `#8d9aa4` |
| status | success `#15803d`, warning `#b45309`, danger `#b91c1c` |
| gold (LinkedIn only) | on white `#a07a3a`, on navy `#c8a462` — flat, like foil; see "LinkedIn post" |

## Typography

- **Latin UI and documents:** `"Helvetica Neue", Helvetica, Arial, sans-serif` — no download.
- **Arabic:** Cairo (Google Fonts, weights 400/600/700). In Next: `Cairo({ subsets: ['arabic','latin'], weight: ['400','600','700'], variable: '--font-cairo' })`, stack `var(--font-cairo), Tahoma, sans-serif`. Arabic overrides every Latin family under `[dir='rtl']`.
- **Micro label** — the one voice of every label, eyebrow and index: 10.5px, bold, UPPERCASE, tracking 0.2em (PDF: 7.2pt bold, 1.3pt tracking). In RTL it is 12px with **no** letterspacing — tracking pulls joined Arabic letters apart.
- **Eyebrow** = micro in brand blue.
- **Pinyon Script** sets exactly one thing: a person's name on a certificate.
- **Montserrat** sets the business card end to end (bold for name/role/labels, regular for phone/email).

## SHARP rules (non-negotiable)

1. Every corner is 90°. No `rounded-*`, no border-radius. (Only exception: the business card's contact discs.)
2. No soft shadows, no glows, no gradient washes. Hierarchy comes from 1px rules and weight.
3. One brand blue. Navy masses, white paper, hairline greys. (The LinkedIn post is the one place
   gold replaces the blue accents — see below.)
4. No circles as furniture — no pie charts, ring gauges or round seals. Seals are square tiles.
5. A rule is measured to what sits on it (an underline is the word's width; a divider is the column's).
6. Navy bands close with a 3px brand-blue **seam** and may carry the `.ink-grid` (white 3% hairlines, 56px).
7. Real photographs only; no stock illustrations.
8. Charts are drawn to scale or not at all.

## Arabic wordmark (ساتو فارما)

`assets/sato-pharma-arabic.png` is the company's own calligraphy — never retype it in a font.

- As a **watermark**: flatten to one ink colour and draw it very faint (certificate 10% ink; website 3.5% on white, 5% white on navy), large, on the right (left in RTL), behind everything else.
- **Never crop the right edge.** Arabic reads right to left, so the right edge is where both words BEGIN; bleeding it off the page cuts off the س and the ف. Lay its ink to the trim, don't pass it.
- It is a raster on purpose: Arabic shaping in PDF needs a CID font pipeline; the image avoids it.
- Keep its ratio 1136:842 — measure the file rather than hard-coding if the artwork is replaced.

## Logo usage

- `sato-pharma.png` on white/light grounds; `sato-pharma-reverse.png` on navy.
- The PNGs carry ~7% clear space per side. When aligning the mark to text, align its **ink**, not its file edges (`satoMarkInk()` in `reference/certificate/sato-mark.ts` measures it).
- In PDFs with no transparency, flatten the alpha against the exact ground colour or edges halo.
- If the artwork can't load, set the company name as type — a document must never lose whose it is.

## Certificate anatomy (A4 landscape, 842×595pt)

Drawn in this order (a PDF has no z-index; order is depth):
1. **Arabic watermark** first — 285pt tall, top at y=111, right side, ink to the trim, 10% ink.
2. **Head band**: navy, 104pt, the reverse mark centred at 50pt tall, closed by a 3pt brand seam.
3. **Frame**: double keyline inset 20 and 27pt, with corner ticks.
4. "THIS IS TO CERTIFY THAT" micro label, then the **name** in Pinyon Script, navy `#17304d`, fill + 0.3pt stroke in the same colour, 68pt stepping down to a 28pt floor (never truncate), baseline 268; a 26-band rectangle-clip gloss (only ~3 bands lit, a thin sliver just above the x-height). Rule under the name is the name's width and colour.
5. **Citation**: one centred sentence naming Sato Pharma, lines balanced, never ending a line on a function word.
6. **Honour** chip (tinted) for top three only; **figures strip** tinted, 22pt figures, floor at y=400.
7. **Foot**: signature column (Omar Anwar Gawish, HR Section Head · Sato Pharma) and provenance column (verification id + QR), rules in FAINT, rows on the same baselines.
8. **Seal**: square ink tile, 64pt, keyline inset 6pt, year reversed out.
9. **Base bar**: navy with seam, `SATO PHARMA · FUTURE TALENTS PROGRAM 2026`.

No transparency anywhere — tints are mixed against the paper. Constants live at the top of
`reference/certificate/certificate-pdf.ts`.

## Business card (90×50mm, Egyptian size)

White face with a 3pt brand seam down the leading edge; navy back with the reverse mark at 35% of
card width, a hairline the mark's ink width, and `WWW.SATOPHARMA.COM`, seam on the mirrored edge.
Name wraps before it shrinks. Contact rows (phone, email, address, website) each behind a
brand-blue disc with a white glyph. Everything aligns to one 14pt margin. 3mm bleed on outer
edges, butted cards, crop marks. Code: `reference/certificate/business-card.ts`.

## Website (satopharma.com)

- Tokens: `reference/website/tailwind.config.ts` — copy the `colors`, `fontFamily` and `maxWidth.container` (1440px) blocks.
- Classes: `reference/website/globals.css` — `.micro`, `.eyebrow`, `.ink-grid`, `.paper-grid`, `.field` (square input, 1px line, blue focus), `.field-label`, `.container-x`, and the premium layer (`.tick-rule-x/y`, `.text-outline-ink`, `.link-draw`, `.marquee-track`, `rv-*` entrances, `.mask-reveal`) with print and reduced-motion overrides.
- `sharp.tsx`: `Micro`, `Eyebrow`, `SectionHead`, `SectionTitle`, `IconTile`, `SealCheck`, `FrameTicks`, `HoverTicks`, `Seam`, `InkGrid`, `ArabicWatermark`, `GhostNumeral`, `Tag`, `RuledGrid`.
- `premium.tsx` (`motion/react` + `next-intl` for RTL direction): easing `[0.16, 1, 0.3, 1]`, `SplitTitle`, `DrawLine`, `MaskReveal`, `Parallax`, `ScanLine`, `StaggerGroup/Item`, `Marquee`, `ReadingProgress`.
- `button.tsx` and `record-2026.tsx` (the certificate verification record page) as worked examples.
- Components import `cn` from `@/lib/utils` (clsx + tailwind-merge) and `next/image`; the watermark expects the Arabic PNG served at `/ftp/2026/sato-pharma-arabic.png` — change the path to wherever you put it.

## Porting the PDF code

`reference/certificate/` is a dependency-free, hand-written PDF writer (Node builtins only):
`pdf.ts` (writer, Helvetica metrics, rects/paths/clip, images), `truetype.ts` (embeds a TTF as
`/FontFile2`; refuses CFF/OTF), `sato-mark.ts` (decodes the PNGs, flattens alpha, measures ink),
`qr.ts` + `verification.ts` (square-module QR), `certificate-pdf.ts`, `business-card.ts`,
`journey-pdf.ts` + `journey.ts` (supplies `satoBadge` and date helpers the certificate imports).
It is copied from the FTP portal, so it expects a `Journey` object and reads assets from
`public/` — adapt the input type and the asset paths, keep the geometry. Needs Node ≥ 22.6 to
run `.ts` directly, or compile with the project's TypeScript.

## LinkedIn post (1080×1350, 4:5) — approved 2026-10-29

The owner's LinkedIn identity, approved on the Dr Salma Labib welcome post. **The look is FINAL**:
each new post changes the words, the portrait and the portrait's geometry — never the palette, the
gold or the layout. Template: `reference/linkedin/post.html` (every line to change is marked
`EDIT`); `reference/linkedin/layout-proof.png` shows the grid with a placeholder where the photo goes
(the real photo's white ground makes its box invisible, so the text never looks covered).

**Anatomy**, top to bottom, on white paper with an 80px margin:
1. Gold corner brackets (44px, 1.5px) inset 30px in all four corners — gold `#a07a3a` on white, `#c8a462` on navy.
2. Head: the dark Sato mark top left, a grey micro label top right (`PEOPLE ANNOUNCEMENT`), a 1px grey rule.
3. Left column, 372px: a gold micro eyebrow (`WELCOME TO THE TEAM`), the name at 100px — first line
   regular, surname bold, each line within about 460px — then a gold 1px rule ending in a small gold
   lozenge, then one sentence at 24px naming Sato Pharma and the person, the name in bold ink.
4. Right: the portrait standing on the band — a chest-up photo on a white studio ground whose bottom
   edge cuts through the body, placed so its bottom edge is the band's top edge.
5. Navy band, 310px, closed at the top by a 3px gold seam, with the 56px ink grid at 2.5%: two figures
   (gold micro label over a 40px white bold value, a 1px divider between them), a hairline, then
   `SATO PHARMA` and `WWW.SATOPHARMA.COM`. The Arabic wordmark in gold at 16% sits on the right,
   236px tall, its right edge on the trim (never cropped).

**Gold is flat ink, never metal**: no gradient, sheen, glint, glow or texture — exactly as a foil
stamp prints. Gold replaces the blue accents on this piece only; the logo keeps its own colours.

**Making a new post:**
1. Copy into one working folder: `post.html`; `assets/sato-pharma.png`; `assets/sato-pharma-arabic-gold.png`;
   `assets/fonts/sans-regular.ttf` and `sans-bold.ttf` into `fonts/`.
2. Prepare the portrait as `portrait.png`: lift only the near-white ground to pure white so the photo's
   edges vanish — Python/PIL: `lut=[v if v<240 else min(255, round(240+(v-240)*1.5)) for v in range(256)]`,
   then `im.point(lut*3)`. The subject (all below 240) is untouched. Never retouch the person.
3. Fit the portrait (`.portrait` left/width): `left:330px; width:800px` suits a near-square crop. Then
   check, on the render: the body clears the text column's right edge (x 452) by 24px or more at every
   height the text occupies; the subject stays inside the right trim; the head sits below the head rule.
4. Render at 2× with Edge (no Chrome needed):
   `msedge --headless=new --disable-gpu --hide-scrollbars --user-data-dir=<folder>/.edge --force-device-scale-factor=2 --window-size=1080,1350 --virtual-time-budget=3000 --screenshot=<folder>/post.png file:///<folder>/post.html`
   → 2160×2700 PNG.
5. Look at the PNG, and measure: the right trim column and the photo's edges must read pure white
   (255), and no sentence may end on a single word (`text-wrap: pretty` is on the lede).

**Words**: only facts that are on record (name, title, date — read the date from Phoenix, never guess);
never invent a person's background. The caption goes with the picture, in English, a few short
paragraphs and a handful of hashtags (`#SatoPharma` first). Never mention how the post was made.

## Licences

- Pinyon Script and Montserrat: SIL OFL 1.1 — may be committed and shipped; `OFL.txt` must go with them. Do not substitute a Windows/system font: embedding permission (fsType) is not redistribution permission.
- Font files must be TrueType-outline (`glyf`) builds, not `.otf`/CFF.
- The logos are Sato Pharma's own artwork — for Sato Pharma work only.

## Verify the output, not the source

Render the page and look at it (open the PDF, screenshot the page) before calling it done.
Every defect in the certificate's history — a cropped Arabic letter, a mark aligned by its
file edge, a name reading black — was correct in the code and wrong on the page.
