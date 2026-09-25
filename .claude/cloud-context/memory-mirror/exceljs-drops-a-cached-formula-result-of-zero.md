---
name: exceljs-drops-a-cached-formula-result-of-zero
description: "ExcelJS omits a formula's cached result when it is exactly 0, so a round-tripped reconciliation cell reads back as a formula with NO result — asserting on it yields NaN, not 0."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 055a1cfa-7300-47ab-ab08-5ca6eeb78df3
  modified: 2026-08-04T20:29:11.316Z
---

A cell written as `{ formula, result: 0 }` comes back from `workbook.xlsx.load()` as
`{ formula }` — **the cached result is dropped because it is falsy**. A non-zero result survives
(`{"formula":"J7","result":850000}`); zero does not (`{"formula":"J7-500000-350000"}`).

**Why:** it bites exactly where it hurts most. The Monthly Closing Total sheet's **Difference** row
caches zero when the workbook is healthy, so a test that reads that cell to prove "the audit ties"
gets `Number(undefined)` → **NaN**, and reads as a failure of the thing being proven rather than as
a serializer quirk. The same shape appears in any reconciliation, delta or variance cell.

**How to apply:**
- Never assert a workbook ties by reading the difference cell's cached result. Read the **component
  rows** the difference is built from and re-add them in the test — those carry non-zero results and
  survive the round trip. That is also a stronger assertion: it proves the published numbers
  reconcile, not just that one cached number was written.
- The Units column beside it is usually a plain number rather than a formula, so it does survive as
  `0` and makes a good secondary check.
- The file itself is fine — Excel and LibreOffice recalculate on open. This is a **test-reading**
  trap, not a defect in the export. Do not "fix" it by avoiding zero.
- Seen 2026-08-04 in `tests/monthly-closing-export-store-split-filtered.test.ts`
  ([[store-sales-split-evenly-across-city-areas]]).
