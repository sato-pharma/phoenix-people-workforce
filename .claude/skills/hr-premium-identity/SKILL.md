---
name: hr-premium-identity
description: The HR premium identity. This is the look of the Talent Acquisition New Starter Handbook (Sato Pharma, Human Resources, October 2026), which the owner named as the template on 12 October 2026. It is the house identity SATO-DIS-2026-01 (the three logo blues, the ink rule, the on-light mark, the engine-turned band) with a premium layer added: a security-microtext frame with corner tiles, an Arabic calligraphy watermark, a centred masthead, two-weight headlines, outline numerals, diamond markers, and a Phoenix running foot. There is also one night-navy-and-gold closing page. Use it whenever you build or restyle any normal Sato Pharma template, form, letter, handbook, guide or HR document (PDF or HTML-to-PDF). NEVER use it for the government forms (social-insurance Form 1, Form 6, the labour exit form). Those print exactly as the Authority issues them. The employment contract, its renewal annex and the non-renewal notice also keep the corporate house dress, by the owner's word on 12 October 2026.
---

# HR premium identity

This is the owner's chosen template for Sato Pharma's normal documents. He named it on 12 October
2026 (Cairo time), after the Talent Acquisition New Starter Handbook, Part One:

> "Save this identity as the HR premium identity … make all the normal templates or forms in Sato
> Pharma follow this perfect template. But not the governmental, the governmental as they are."

The specimen is `examples/specimen-new-starter-handbook-part-one.pdf`. It is NOT in this repository
copy, because it carries staff photographs; it lives only in the owner's own copy of this skill on his
machine (`~/.claude/skills/hr-premium-identity/`). It has 7 A4 pages, and the
owner reviewed each page in turn before naming it the template. `examples/page-2.png`, `page-3.png`, `page-6.png` and `page-7.png`
are 100 dpi screen-viewer renders of it. The pages with staff photographs are left out of the PNGs.
`reference/build-handbook.mjs` is the complete generator that produced it. Every measurement below
was taken from that file.

```
assets/
  sato-pharma-logo-on-light.svg   the house mark (SATO black, PHARMA blue), vector; masthead left
  sato-pharma-arabic-on-light.png the Arabic calligraphy (placeholder art, see below); masthead right + watermark
  sato-pharma-reverse.png         reverse mark, for the navy closing page
  sato-pharma-arabic-gold.png     the Arabic mark flattened to gold #D8B872, for the navy page
  phoenix-login-emblem.png        the ringed Phoenix emblem over rising bars; running foot + seal window
reference/
  build-handbook.mjs   the full generator: tokens, frame, band, seal, CSS, every page
  measure-foot.mjs     measures each page's lowest content against the footer rule
  tint-assets.mjs      recolours one-ink artwork (keeps the alpha, fills one flat colour)
  crop-team.mjs        the 3:4 head-and-shoulders crop law for staff photographs
examples/
  specimen-new-starter-handbook-part-one.pdf   the approved specimen (owner's machine only)
  page-2.png  page-3.png  page-6.png  page-7.png
```

## Rule zero

- **A design the owner hands you is FINAL.** Fix its defects, such as bleed, resolution, fonts,
  typos and cropped boxes. Never redesign it.
- **This identity restyles a document, never its content.** Keep every word, field, clause, table
  and signature cell. Only the dress changes.
- **Arabic legal text stays exactly as he supplied it.**
- **If you are unsure whether a change alters the meaning or the layout of a legal paper, ask
  first.**

## What it is, and what it is not

- **It IS the house identity `SATO-DIS-2026-01`, raised to premium.** It uses the same three blues
  sampled from the logo, the same on-light mark and the same 6 mm engine-turned band. The content
  pages keep the **ink rule**: lines and type only, with no filled areas. The only exceptions are
  the photographs and the marks. The repository module is `src/lib/hiring-pack/house-identity.ts`.
  Its `HOUSE_COLORS` are exactly the content-page palette below.
- **It is NOT `sato-pharma-identity`.** That skill is the SHARP system with brand blue `#0879b8`,
  used for the certificates, the business card and the website.
- **It is NOT `phoenix-pptx-design-reference`.** That is the black-and-orange Phoenix brand for
  decks.
- **Government forms are never touched.** Social-insurance Form 1, Form 6 and the labour exit form
  (`render-form1.ts`, `render-form6.ts`, `render-labour-exit.ts`) print as the Authority issues
  them. Restyling one makes it a form the insurance office can refuse.
- **Frozen designs need the owner's word before conversion.** He decided these individually, so
  ask him as multiple choice before restyling any of them:
  - the job offer letter (`src/lib/offers/`, which has its own brand and keeps the company seal)
  - the Spotlight sheet (its fills are approved exemptions)
  - the business card (his own final design)
  - the payroll exports, the monthly-closing workbook and the weekly exports
- **No company seal on a hiring paper.** The seal belongs to the job offer alone. The specimen's
  diamond seal is an ornament for the closing page, not a company stamp. Never put it on a
  document someone signs.

## Palette

**Content pages:** white paper, the house blues.

| Token | Hex | Use |
|---|---|---|
| ink | `#000000` | values in fact lists, legal body text |
| deep | `#0A527D` | titles, headlines, names, the band, 0.7 pt strip rules, the outer frame keyline, diamond markers |
| blue | `#0A6BA6` | micro labels and eyebrows, the 1.2 pt callout rule, the frame microtext |
| light | `#1482C2` | outline numerals, the inner frame keyline, ornaments, the quote mark |
| hair | `#B9C7D4` | 0.4 to 0.5 pt dividers and column rules |
| muted | `#5A6B7C` | secondary text, captions, the foot |
| body | `#1A1A1A` | running text |

**The closing page:** night navy and gold. The owner set the ink rule aside for this one page.

| Token | Hex | Use |
|---|---|---|
| navy | `#0A1B2E` | the page ground |
| panel | `#0C2136` | the feature panel's ground, which stays **plain** (see the stripes lesson) |
| gold | `#C9A45C` | headline accent, frame, band, rules, kicker |
| light gold | `#E4CC8E` | seal microtext, the signature ink |
| deep gold | `#A8843F` | inner keylines, the second tick |
| text / soft / muted | `#F1F4F8` / `#C5CFDA` / `#8B9BAE` | headline / body / labels |
| hair / gold hair | `#22344A` / `#4F4B3C` | row rules / gold-family dividers |

Tinted artwork for the navy page: the Arabic mark is `#D8B872` and the signature is `#E3C98A`.
Both come from `reference/tint-assets.mjs`.

## Typography

- **Body:** `"Segoe UI Variable Text", "Segoe UI", Tahoma, Arial, sans-serif`.
- **Headlines and numerals:** `"Segoe UI Variable Display", "Segoe UI", sans-serif`.
- **Georgia** is used for one thing only: the opening quote mark of a personal note.
- 🔴 **Segoe UI is a Windows system font, and it cannot be committed or shipped.** A document
  rendered on a Linux server (Railway) will not have it. Before the identity goes into
  server-rendered papers, either establish where the PDF is actually rendered or choose a licensed
  open substitute and get the owner's approval for it. Never commit a Microsoft font file.
  **Where it stands (12 October 2026):** the repository's papers use
  `PREMIUM_LATIN_FONT_STACK` in `src/lib/hiring-pack/premium-identity.ts` — Segoe UI first, then
  Noto Sans, which the production image installs (`font-noto` in the `Dockerfile`). So a paper
  printed on the server sets its Latin lines in Noto Sans. Whether to keep that, or ship a licensed
  open face for both, is the owner's decision and was put to him; until he answers, it stays.
- **Arabic** keeps the repository's `ARABIC_FONT_STACK` (Tahoma first). Never letter-space Arabic.

| Element | Size and weight |
|---|---|
| headline | two weights in one `h1`: a light line at 29 pt, weight 250, tracking −0.6 pt, then a bold block line at 50 pt, weight 700, tracking −1.6 pt, both in deep. Page 2 uses 25 / 37 pt |
| chapter numeral | 58 pt, weight 200, **outline only** (`color: transparent; -webkit-text-stroke: .6pt` light) |
| route and step numerals | 17 to 26 pt outline. The current step is filled deep, weight 700 |
| lead | 11.2 pt / 1.55 |
| body | 9 to 9.8 pt / 1.5 to 1.6 |
| micro label | 7 pt, weight 700, UPPERCASE, tracking 1.6 pt, in blue. This is the one voice of every label |
| fact list | `dt` 6.4 pt micro in blue, `dd` 10 pt in ink |
| masthead | title 8.5 pt, weight 700, tracking 2.6 pt, deep. Subtitle 6.8 pt, tracking 1.3 pt, muted |
| foot | 6.8 pt muted. Page number 9 pt deep |

## Page anatomy (A4 portrait, 210 × 297 mm)

`@page { size: A4; margin: 0 }`. Each page is a `section.page` measuring 210 × 297 mm, with
`overflow: hidden` and padding of **15.5 mm top and 17 mm sides**. The content column is therefore
176 mm. Set `print-color-adjust: exact` and `border-radius: 0 !important` on everything.

1. **Frame.** This is one SVG over the whole sheet, drawn in mm (`frame()`).
   - The outer keyline is inset 6 mm, deep, 0.26 mm.
   - The inner keyline is inset 8.8 mm, light, 0.09 mm.
   - A line of **security microtext** runs between them on all four sides. It is 1.12 mm Segoe UI
     600 in blue, fitted with `textLength`, and reads upwards on the left side and downwards on
     the right.
   - The microtext phrase is the document's own words, for example `SATO PHARMA · NEW STARTER
     HANDBOOK · HUMAN RESOURCES · HEAD OFFICE · TALENT ACQUISITION`.
   - **Corner tiles** are 5.2 mm squares: white fill, a 0.25 mm deep stroke, an inner light square,
     and a rotated-square pip.
2. **Watermark.** The Arabic calligraphy at 5% opacity, 112 mm wide, placed `right: 11mm;
   bottom: 21mm`, inside the frame and behind everything. **Never crop its right edge.** Arabic
   begins there.
3. **Masthead.** A grid of `34mm | 1fr | 28mm` with a 6 mm gap.
   - Left: the on-light mark at 34 mm.
   - Centre: the document title, then a rule ornament (two 9 mm hairlines around a 1.3 mm light
     diamond), then the subtitle (`Human Resources · Head Office · October 2026`).
   - Right: the Arabic mark at 28 mm.
4. **Band.** The engine-turned band sits 3.5 mm under the masthead.
   - It is 1.5 mm tall, 176 mm wide, with a 6 mm wave, a 0.26 mm stroke, in deep.
   - It is an **inline vector SVG** (`band()`).
5. **Hero.**
   - A chapter numeral plus a micro eyebrow whose hairline runs out to the column edge.
   - The two-weight headline.
   - The **tick**: three rules in a row. 14 mm blue at 1.2 pt, then 3 mm light, then 1.2 mm hair.
   - A lead paragraph.
   - Optionally, a **fact list**: a 0.7 pt deep top rule, 0.4 pt hair row rules, and a 25 mm label
     column.
6. **Sections.** Each opens with a section head (`.shead`): a micro label plus a hairline to the
   column edge. The block vocabulary:
   - **Strips** have a 0.7 pt deep top rule and cells separated by 0.4 pt hair verticals.
   - **Callouts** have a 1.2 pt blue left rule.
   - **Route strips** are a numbered timeline: outline numerals, **diamond markers** (rotated
     squares, never circles) on a hairline, and the current step filled.
   - **Numbered aims and steps** sit in 2 or 3 columns.
   - **Duty lists** use outline numbers.
   - **KPI cells** each have a rule-topped measure line.
   - The **organogram** is a double-keyline plate with corner ticks for the head, a stem to a 0.7 pt
     bar, and columns of tree lists with diamond nodes.
   - **Portraits** are 3:4, with an offset engraved block and square corner marks.
7. **Running foot.** Placed `bottom: 12.5mm`, 17 mm from each side, with a 0.5 pt hair top rule.
   - Left: the Phoenix emblem at 6.5 mm and `PHOENIX WORKFORCE` (6.4 pt, bold, deep).
   - Centre: `Sato Pharma · <department> · SATO-DIS-2026-01 v1.0`.
   - Right: the section name in micro, then the page number at 9 pt in deep.
   - Content must end **at least 1 mm above the foot rule.** The specimen measures 1.1 to 9.3 mm.

**Square corners everywhere.** Hierarchy comes from rules and weight, never from shadows, gradients
or rounded boxes.

## The closing page ("not the end")

Use a closing page to end a part or a pack. On the specimen it is page 7.

- **Ground and frame.** The ground is navy. The frame uses the gold palette (`GOLD_FRAME`). The
  masthead uses the reverse mark at 36 mm and the gold Arabic mark. The band is gold.
- **Kicker.** A gold diamond, then `PART ONE · COMPLETE`, then a gold-hair rule.
- **Headline.** 30 pt light in `text`, then a 60 pt bold line in gold.
- **Stamp.** A 29 mm square stamp on the right: a 0.7 pt gold keyline plus an inner deep-gold
  keyline.
- **Route of the whole document.** Done steps have gold-filled diamonds. Future steps have gold
  numerals and an outlined diamond.
- **Feature panel.** The ground is plain `panel` with a 0.7 pt gold border, a 0.3 pt deep-gold
  keyline inset 1.3 mm, and 4 mm corner ticks. Inside it:
  - a **52 mm diamond seal**: keylines, microtext along its four edges, an engine-turned field and
    a window holding the Phoenix emblem
  - a kicker
  - a headline
  - "sealed" rows, where each value is a row of small deep-gold squares
- **Sign-off.** `See you in Part Two.` on the left. On the right, the owner's signature (vector,
  `currentColor` light gold, positioned absolutely above the name so it adds no height), then a
  12 mm gold rule, `Omar Gawish`, and `HR Manager, Sato Pharma`.
- **Foot.** The same running foot in gold. The right side reads `END OF PART ONE ◆`.

## Production rules learned on the specimen

Each of these cost a reprint.

- **Build HTML, then print it with Chrome.**
  `chrome.exe --headless=new --disable-gpu --user-data-dir=<temp profile> --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf=<out.pdf> file:///<page.html>`
  Embed every image as a data URI so each page file stands alone.
- **Draw ornaments as inline vector SVG, never as a CSS background tile.** Chrome rasterises a
  background tile into the PDF, and the band printed soft.
- 🔴 **Never fill an area with vector hairlines.** Screen PDF viewers draw every line at least one
  pixel wide. On 12 October 2026 a texture of 0.035 to 0.07 mm gold lines turned the closing
  panel into heavy gold stripes on screen, and the owner rejected it. On paper you would not have
  seen them.
  - Render an engraved field to a high-resolution PNG and embed it as an image. The seal does this
    with sharp at 2000 px (`sealField`).
  - Or leave the ground plain.
  - A single keyline is fine. A field of many lines is the danger.
- **Photographs follow one crop law** (`crop-team.mjs`): 3:4, 600 × 800, the head filling 55% of
  the height, and 9% headroom. A row of faces then reads at one size.
- **One-ink artwork is recoloured, never redrawn** (`tint-assets.mjs`).
- 🔴 **Nothing inside a `position: fixed` frame may carry an SVG `transform`.** A fixed element is how
  Chrome repeats the frame on every printed page, and Chrome paints its transformed SVG children on
  the FIRST page only. On 12 October 2026 the rotated side microtext and the turned corner pips
  vanished from page two of every multi-page paper. Lay rotated text on a `<textPath>` and draw a
  turned square as a four-point polygon. CSS rotation on an HTML element is not affected.
- **On a paper set to its last millimetre, add nothing that takes a line.** The reference number the
  papers carry rides the masthead's name line; on a line of its own it cost 3.2 mm and pushed two
  papers onto an extra sheet. Measure page counts on the NUMBERED render — that is what gets filed.
- **A full-bleed frame needs `@page { margin: 0 }`**, because a fixed element is clipped to the page
  area. Chrome then has nowhere to draw a footer template, so page numbers are written onto the
  finished PDF instead (`paper-pdf.ts` in the repository).
- **The Arabic mark is placeholder art.** It was generated and then hand-edited, and the owner is
  replacing it himself. It is the repository's `public/brand/sato-pharma-arabic-on-light.png`,
  pinned by `tests/phoenix-official-logo.test.ts`. Never regenerate it. Swap it only when he sends
  the official file.

## Writing for it

- Simple, warm, human English. Short sentences. Write to the reader as "you".
- **Never mention AI**, agents or how the document was made.
- Use **names, never codes**: people by name and title, departments by name.
- Make each page earn its place. Never pad a section to fill a column.

## Verify the printed PDF, not the HTML

1. Run `pdfinfo out.pdf`. It must show one PDF page per designed page. An overflow adds a page.
2. Run `node reference/measure-foot.mjs <page.html> <chrome.exe> <profileDir>`. Every page must
   show 1 mm or more of space above the foot rule.
3. Run `pdftoppm -r 80 -thinlinemode solid -png out.pdf z`. This mimics a screen viewer. Look for
   stripes, moiré, a soft band or heavy hairlines.
4. Zoom at 300 dpi (`pdftoppm -r 300 -x … -y … -W … -H …`) on the band, the frame microtext, any
   seal and the signature. They must be crisp.
5. Look at every page before you send anything.

## Rolled out to the normal templates (12 October 2026)

Done in one wide pull request. The shared layer is `src/lib/hiring-pack/premium-identity.ts`, built
once beside `house-identity.ts`. The account — his words, what wears it, what does not, and why —
is `docs/agents-owner-rules.md`, "The HR premium identity"; the module rule is in
`.claude/rules/hiring-documents.md`; `tests/hr-premium-identity.test.ts` pins it on the rendered
papers.

- **Wears it:** both clearances, both custody receipts, the worker data form, the English certificate
  of experience, the English salary letter, and the current version of every HR paper.
- **Keeps the corporate dress, by his word the same evening** ("the contract keep corporate as it
  was"): the employment contract, every version of it, and with it the renewal annex (pinned
  identical to the contract's masthead) and the non-renewal notice.
- **An archived version keeps the dress it was signed in.** Only the current version wears it.
- **Never touched:** the government forms and the frozen designs above. `houseLetterhead()` is
  unchanged, so the payslip and the other papers that call it keep the house dress.
- **Still his to decide:** the frozen designs, the other `houseLetterhead()` papers, the Latin face on
  the server, and whether the foot keeps `SATO-DIS-2026-01 v1.0`. Never decide these for him.
