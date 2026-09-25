---
name: ped-line-closing-workbook-s1-quarter-bug
description: "The Ped Line sales-closing workbook's S1 (half-year) tab silently reports Q2-only numbers, and the Data→report chain is broken by a manual paste"
metadata: 
  node_type: memory
  type: project
  originSessionId: 742e83f7-58dc-4dcf-883f-cf319a67cadc
  modified: 2026-07-28T22:48:27.404Z
---

`Q1-Jun-2026 Sales Closing ( Ped Line ) Final.xlsx` (in `OneDrive/Desktop/Raw/sato 6-2026/sfe-x/`) — audited 2026-07-29.

**Calc chain:** `Data` (2,187 raw June rows) → `Total` (46 areas × 11 product/type grid, live SUMIFS on Area+Product+Type) → **`Formula` (hidden, ZERO formulas — a hand-pasted pivot)** → `Jun-2026` → `Q2-2026` → `S1` → `Ranking` (also hand-pasted). Jan–May tabs are frozen values with no formulas.

**Two confirmed defects:**
1. `S1` columns AE/AF (Lacto Family) and AH/AI (Grand Total) sum `Apr+May+Jun` instead of `Q1+Q2`. H1 sales show 7,012,772 EGP when the truth is 12,262,911 — understated 42.8%; achievement reads 67.74% instead of 60.76%. Root cause: `Q1-2026` uses a 41-column layout (extra "Lacto LF" block) while Q2/S1 use 36 columns, so those 6 columns were re-pointed at the months rather than at Q1's real AJ/AK/AM/AN.
2. `Ranking` row 27 (Behira 1) shows 0.435 vs the true 0.152 from `Jun-2026!AJ31`; ranks 17/18 are inverted; 6 real areas (incl. Bani suef at **-108%**) are omitted entirely.

**Why:** June closes at 107.65% achievement and is the number the line is judged on, so anything feeding S1/Ranking is decision-grade.

**How to apply:** `Total` reconciles to `Data` exactly (20,208 units) — trust it. Do NOT trust `Jun-2026` or anything downstream after editing `Data` until the `Formula` pivot is refreshed and re-pasted by hand. Verify any month tab with the cross-foot `M + Q + AE == AH`; every tab passes except S1. See [[sos-owner-standing-rules-from-session-369dd08d]] for the owner's related area/brick conventions.
