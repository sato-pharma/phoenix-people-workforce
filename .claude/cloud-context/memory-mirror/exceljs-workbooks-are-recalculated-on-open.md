---
name: exceljs-workbooks-are-recalculated-on-open
description: "Every xlsx this repo writes is FULLY recalculated by Excel on open — a formula's cached result is decoration, so any report cell whose formula computes something different from the app is wrong the moment the file opens"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ff721f65-99c8-4ef2-92f2-305a08d0d465
  modified: 2026-08-11T14:07:25.439Z
---

**A cached formula result in an ExcelJS workbook is decoration, not a value.** ExcelJS writes
`calcPr calcId="171027"` (Excel 2010) and **no `calcChain.xml`** — the `calcChain.xml` in
`node_modules/exceljs/lib/xlsx/` is an unused template, never referenced by `xlsx.js`. A modern
Excel seeing a lower calcId than its own does a **full recalculation on load**. So whatever
`{ formula, result }` you cached is discarded before the reader sees it.

**Why this bites here:** every report sheet in `monthly-closing-export.ts` was written as
`F(sumifs(Calc!…), <the app's number>)`. Readers therefore saw the SUMIFS, never the app's number.
The two only agree when the sheet being summed contains exactly the population the app computed
over — and the hidden `Calc` sheet holds `phx_closing_distributor_product`, i.e. distributor
invoice lines keyed by GEOGRAPHIC region, while the closing applies five TS transforms on top
(direct injection, area merge, **organogram region grouping**, store city split, targets).

Measured 2026-08-11 on production 2026-07: the SQL layers agree perfectly (0 disagreeing cells over
869 area×product cells, 3 lines), yet **18 of 22 region subtotals exported wrong** — Anti Infective
UE-1/UE-2 recalculated to **zero** (those codes exist only in `au.line_area_map`, never in the
sales rows), CNS OT was −329,320.95, CNS AB −177,609.81, CNS D1 +212,604.13. CNS was worst hit
*because it has no direct sales*, so nothing set `hasMergedDirect` and its subtotals stayed live.

**How to apply.** A REPORT cell must be a value. Live formulas are fine only when they reference
cells **on their own sheet** (the Contr% cells do) or when the sheet is deliberately an independent
re-add with a Difference row (the closing's visible `Data` + `Total` pair). Never "fix" a
divergence by flagging individual rows static — that was tried three times here
(`hasMergedDirect`, `storeSplitAdjusted`, `markMergedAreaRowsStatic`), and each hand-maintained
list went stale the next time a closing rule was added. Fixed permanently by
`fix(closing): stop the exported Closing Matrix recalculating away from the screen`, which removed
`DataRefs` from `writeMatrixSheet` entirely so the sheet cannot reach `Calc` even by accident;
`tests/closing-export-matches-screen.test.ts` fails on any Calc-backed cell on that grid.

**Still open, and NOT the same bug:** the Comparison / Rankings / Summary tabs group by the
GEOGRAPHIC region while the Closing Matrix groups by the ORGANOGRAM — internally consistent on each
tab, but one workbook showing two different region groupings. Needs an owner ruling, not a fix.
See [[closing-export-applies-a-store-split-the-frontend-does-not]] for the older, unrelated
"frontend right, XLSX wrong" causes.
