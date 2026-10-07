---
name: the-house-print-css-break-recipe-lives-in-print-day-mjs
description: "The house print CSS's page-break recipe is `thead { display: table-header-group }` + `tr { break-inside: avoid }` and NEVER `table { page-break-inside: avoid }` — it lives in scripts/field-day/print-day.mjs:123-125, and a hand-written deliverable that puts `avoid` on the table instead strands headings and thins pages."
metadata:
  node_type: memory
  type: project
  originSessionId: 35b44469-be05-434e-98f8-ff8164de6273
  modified: 2026-10-07T19:46:35.967Z
---

`scripts/field-day/print-day.mjs` lines 123-125 hold the correct three lines, and every
deliverable the generator emits inherits them:

```css
thead { display: table-header-group; }
tr    { break-inside: avoid; page-break-inside: avoid; }
.rep  { break-inside: avoid; page-break-inside: avoid; margin-bottom: 2mm; }
```

**There is deliberately NO `page-break-inside: avoid` on `table`.** A table is allowed to split;
only a ROW is kept whole, and the header row repeats on the continuation page.

**The defect to look for in a HAND-WRITTEN deliverable** (the ones with no generator — the
production-planner handbook, the Sahar Khalil guide) is the inverse: `table { … page-break-inside:
avoid; }` and no `tr`/`thead` rule at all. A table that then does not fit the remaining space is
pushed WHOLE to the next page, which strands its heading at the bottom of the page before and
leaves that page thin. Measured on the handbook, 2026-10-07: three thin pages (1,904 / 2,133 /
2,044 chars) became two (2,181 / 2,177), the 1,904 one gone, at the same 15-page count. The fix is
`table { page-break-inside: auto; break-inside: auto; }` plus the two lines above.

**Watch two things when checking whether a file already has the rule:**

- `/thead\s*\{[^}]*display/` FALSE-POSITIVES on the house CSS. The section comment
  `/* ─── masthead ──── */` followed by `.masthead { display: flex; … }` matches it. Grep for
  `display: table-header-group` literally instead.
- The `section { page-break-inside: auto; }` anchor line is indented **two** spaces in these
  files, not four — a scripted edit assuming four fails with "rule not found".

**The repeated header row is the proof the fix took.** Total extracted text rises by exactly the
header row's characters (+34 on the handbook) while the page count holds, and the header string
appears on both the page the table starts on and the one it continues onto. See
[[a-pdf-page-count-from-the-first-count-is-a-subtree]] for counting the pages correctly, and
[[period-card-call-tables-use-the-tight-density]] for the density half of the same audit.
