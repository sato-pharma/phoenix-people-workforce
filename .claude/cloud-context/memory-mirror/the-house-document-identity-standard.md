---
name: the-house-document-identity-standard
description: "The approved Sato Pharma document identity — what \"put it in the system template\" means, the palette measured from the logo, the ink rule, and what is exempt. REOPENED by the owner 2026-09-11: both logos (Sato top, Phoenix bottom), blue overrides orange, eight rejected sets. The OFFICIAL Phoenix logo is the RINGED emblem over rising bars."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3a225fa2-02ae-4edc-b5f9-0feb98b6a83e
  modified: 2026-09-11T19:07:37.364Z
---

**The owner approved `SATO-DIS-2026-01 v1.0` on 2026-09-05 as the house format for every document
the company issues.** The specimen WAS `xlsx/Sato-Pharma-Document-Identity-Standard.pdf` (10 pages,
A4), with drafts beside it as `-Draft1-filled`, `-Draft2-nozebra`, `-Draft3-zebra`, `-Draft4`.
**None of them is in `xlsx/` or `Document-Library/` any more (searched 2026-09-11; `xlsx/` has no
backup)** — the live reference for v1.0 is the code, `src/lib/hiring-pack/house-identity.ts`.

**It is the COMPANY's identity (Sato Pharma), not the Phoenix app's** — he corrected this explicitly.
Never dress a company document in Phoenix brand colours.

**"Put it in the system template" is a standing instruction.** When he says it against any document,
rebuild it on this format without asking again: the mark, the legal line, the brand rule, the title
block, house tables, the signature block and the running footer. **"Make it a letter"** means the
plain letterhead with the registry strip at the foot. **"Premium"** adds the purpose line and the
legal recital.

**The palette is MEASURED FROM THE LOGO, not chosen** — sample it, never invent a shade:

| Role | Hex | Where it came from |
| --- | --- | --- |
| Ink | `#000000` | the SATO wordmark |
| Brand Deep | `#0A527D` | the wave's darkest stroke — titles, headings, table headers |
| Brand Blue | `#0A6BA6` | the PHARMA wordmark — the 0.7 mm brand rule |
| Brand Light | `#1482C2` | the wave's lightest stroke — callout edges |
| Zebra tint | `#F2F6FA` | Brand Blue at 6% on white |

**Brand Deep REPLACES the navy `#0B2A4A`** the documents carried. That navy is in no part of the
logo — it came from the old Word originals. The owner did not follow the "Deep vs navy" question when
it was put to him in those words; he answered by approving the sheet. **Do not re-ask it.**

🔴 **THE INK RULE — no filled areas, anywhere.** Owner instruction, and the constraint every other
decision answers to: these print in volume on office machines. Colour is carried by **lines and
type, never by area** — no masthead band, no filled table headers, no tinted panels. Measured
9.97% → 3.18% page coverage, a ~69% toner saving. **The ONE exception is the zebra row, which he
asked for by name** ("ZEBRA TABLED") at 6%, replacing the row hairline rather than joining it.

🔴 **Government forms are EXEMPT, permanently** — social-insurance Form 1, Form 6 and the labour exit
form are Authority facsimiles. No letterhead, no palette, no house geometry. Restyling one makes it
a form the office can refuse. See [[social-insurance-form-1-prints-as-issued]].

**Two traps this standard exists to stop, both already reached print:**

- **The white-wordmark logo on white paper** — `sato-pharma-logo.png` sets "SATO" in white, so the
  letterhead reads "PHARMA". On paper the answer is always `sato-pharma-logo-on-light.png`.
- **Latin values inside Arabic prose print REVERSED** unless pinned left-to-right, and every string
  comparison still passes. Measured: bare renders `2026 / 09 / 05`; U+202A and U+2066 both render it
  correctly. Do not judge Arabic direction from a screenshot — measure the glyph x-positions.

**Still outstanding: there is NO vector master of the logo.** The only artwork is 401 × 158 px —
exactly 300 dpi at the 34 mm letterhead size, with no headroom. It cannot be enlarged. Recovering the
original `.ai`/`.eps`/`.svg`, or redrawing it, is the last quality gain and costs no ink.

**How the specimen is built** (it is HTML printed by Chrome, matching how these documents already
work — see `src/lib/hiring-pack/render-shared.ts`, which explains why a PDF library cannot set
Arabic): source in the session scratchpad, logos inlined as base64, printed with
`chrome --headless=new --print-to-pdf`, then `pdf-lib` stamps the metadata. Page numbers, section
numbers and the contents are **generated at load**, never typed — they had already drifted once.

## 2026-09-11 — the owner REOPENED the design (nothing approved yet)

He said SATO-DIS-2026-01 does not satisfy him and asked for a new default set (PDF, Excel, email
HTML) as recommendations first, not implemented. His own words, binding on the next version:

- **A mixture** — corporate like Sato Pharma, with the strength of a system like Phoenix.
- **Both logos: Sato at the TOP, Phoenix at the BOTTOM**, each in its ORIGINAL colours. This
  narrows "never Phoenix" above: the Phoenix LOGO now appears, the Phoenix PALETTE still does not.
- **Orange and blue do not match — BLUE OVERRIDES.** Orange appears only inside the Phoenix logo.
- **The OFFICIAL Phoenix logo — two files are proven WRONG by his own rejection:**
  `phoenix-main-logo.png` (bird only — "not the official logo") and the brand-sheet lockup
  `phoenix-required-brand.png` / `phoenix-logo-reference.png` (bird, PHOENIX with the orange X,
  PEOPLE • PERFORMANCE • INTELLIGENCE — "you are putting the wrong phoenix logo", on Set 8). Neither
  is used anywhere in the app. What `src/config/system-settings.ts` actually configures is the RINGED
  emblem with rising bars: `iconLogo` phoenix-bird-icon.png, `loginEmblem` phoenix-login-emblem.png,
  `adminSidebarLockup` phoenix-sidebar-lockup.png (emblem + PHOENIX / WORKFORCE). **SETTLED by the
  owner the same night: he sent that ringed emblem and wrote "This is the original contract logo of
  Phoenix"**, then ordered every Phoenix mark in the system audited and fixed to it (PR #3715).
  That includes the LOCKED portal identity banner's cream watermark: shown a before/after, he
  answered "yes to watermark", so its ringless bird became the ringed emblem. Do not restore it.
- **No big filled blocks** (printer ink); print and online variants may differ.

Eight attempts were rejected that day, all kept in `xlsx/SATO-Document-System-2026-09-11/` — do not
re-propose them: a full-bleed blue panel (Set 4), orange hairline accents (5), offer-letter grids of
boxed cells with black number squares (6, "i donot like set 6"), a per-element chooser ("NO
COMBINATION I LIKED"), and the signature-card family on cream with orange, a script name and a navy
wave (7, his hardest rejection). Set 8 that evening — white paper, Sato top, the brand-sheet lockup at
the foot, blue lines only — was rejected on the logo.
