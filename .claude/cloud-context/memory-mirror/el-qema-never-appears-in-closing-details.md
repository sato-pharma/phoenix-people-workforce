---
name: el-qema-never-appears-in-closing-details
description: "OWNER RULE, LIVE — El Qema's sales stay in totals and achievements but its NAME reaches nobody but Super Admin. Detail rows are REMOVED (09-10); the standard workbook's distributor/rankings/gaps/summary/Calc sheets and Source Coverage KEEP its money under `—` (09-14, his choice). Never relabel as a real distributor; never 'align' the two surfaces."
metadata:
  node_type: memory
  type: project
  originSessionId: d4c0f7f1-f648-4233-aaf3-01d653c69719
  modified: 2026-09-14T20:14:08.384Z
---

Owner, 2026-09-09: *"I want the El Qema to be shown in the achievements only, never show in details
… never anyone know that these sales are from Al Qimma, but they appear in their total and
achievements but not in the details."*

**Two surfaces, two answers — both his, neither a precedent for the other:**

- **Detail rows (Data sheet, details tab, Store Split entries): REMOVED** — 2026-09-10, "remove them
  completely from details". Blank columns were tried first and announced the hidden money.
- **Distributor breakdowns in the standard closing workbook (Distributor Comparison, Rankings & Mix,
  Gaps & White-Space, Summary & Insights, hidden Calc) and Source Coverage: KEEP THE MONEY, NO NAME**
  — 2026-09-14. Asked "remove completely vs keep money under a blank distributor", he chose the
  latter knowing an unnamed `—` distributor then holds ~70% of Pedia. Customers of El Qema fold into
  one `—` customer.

**Why 09-14 happened:** those sheets are built from the closing COMPARISON leaves, whose loaders took
no viewer; a CEO Pedia August download named El Qema on 6 sheets (84 `QM` rows on Calc) while its
Data sheet was clean. Fixed by `maskComparisonLeaves` / `maskSourceCoverage` in
`closing-source-mask.ts`, with the viewer REQUIRED on `loadMonthlyClosingComparison`,
`loadMonthlyClosingComparisonFromRows` and `loadMonthlySourceCoverage`.

🔴 **NEVER RELABEL AS ANOTHER REAL DISTRIBUTOR** — offered by him, declined: false records in the
auditor's file. `—` is not a source.

**How to apply:** mask at the READ boundary after every computation (split, scope) and before every
render; Super Admin and `scope: "system"` reveal. Verify on the EMITTED workbook as a non-Super-Admin
(CEO build), not the source — the 09-14 leak passed every source-level test.
Still unchecked: the Source of Sales dashboard's own breakdown was masked separately
(`maskPortalSosDashboard`); the Executive Report's comparison has not been measured.
