---
name: period-card-call-tables-use-the-tight-density
description: The Phoenix CRM rep period card's call tables use the TIGHT density — cell padding 1.1mm and line-height 1.30 — so the closing panels land on the last call page instead of a near-empty extra sheet. Owner ruling 2026-10-07.
metadata:
  type: feedback
---

The rep period card (`<rep>-period-card-<from>-to-<to>.html` + `.pdf`, A4 portrait, house
identity `SATO-DIS-2026-01 v1.0`) renders its call tables at **`th, td { padding: 1.1mm 1.8mm }`**
plus **`table.calls tbody td { line-height: 1.30 }`**. Everything else keeps the original
rhythm — the lede, the score block, the two closing panels, the headings and all other body
type stay at `line-height: 1.45`.

**Why:** at the original 1.5mm / 1.45 density, Hassan El Sherbiny's 1-6 October card ran to 5
pages with the last sheet only a third full: *What the field told him*, *Still open on his
seat* and *How to read this* alone. Page 4 was genuinely full — the closing panels could not
be pulled up by any page-break rule. Measured 2026-10-07, four variants, only the density
change reached 4 pages:

| change | pages |
| --- | --- |
| let the `.cols` flex block fragment | 5 — byte-identical; Chrome will not split that flex row at all |
| + `h2` margin-top 5mm → 3.4mm | 5 |
| + cell padding 1.5mm → 1.1mm | 5 |
| + call-table line-height 1.30 | **4** |

The owner was shown the cost (page 1 pulls one extra row up; call rows sit tighter) and ruled
**"keep the tighter call tables"**.

**How to apply:** regenerating or writing a new period card, start from the tight values — do
not restore 1.5mm / 1.45 and do not reach for `break-inside: avoid` on the closing block, which
does nothing here. This is a density ruling for THIS document only; it does not reach
`scripts/field-day/print-day.mjs`, which builds the field-day papers and keeps its own.

**There is no generator** — the card's HTML is its own source, so the values live in that file.
Verify a change by rendering with headless Chrome and counting `/Type /Pages … /Count`; that
path reproduces the original render byte-for-byte. See [[the-house-document-identity-standard]].
