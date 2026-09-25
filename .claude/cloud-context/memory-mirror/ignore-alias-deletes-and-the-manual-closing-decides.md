---
name: ignore-alias-deletes-and-the-manual-closing-decides
description: "IGNORE is the only SoS product mapping that DELETES rather than misplaces — and the owner's own manual closing, not the distributor file, decides whether a SKU counts"
metadata: 
  node_type: memory
  type: project
  originSessionId: f3deb2a3-78c9-4188-9750-0ce65dec6904
  modified: 2026-08-09T20:26:28.274Z
---

A wrong product alias misfiles units between products, so some total somewhere still moves. An
alias set to **`IGNORE` deletes the rows before they ever reach `source_of_sales_import_rows`** — no
product total shifts, no reconciliation breaks, nothing goes red. It is the highest-blast-radius,
lowest-visibility mapping in the system, and `IGNORE` rows are invisible to every after-the-fact
check (`source_of_sales_reference_issues` is empty; only `import_batches.rows_ignored` counts them).

**Why:** auditing this on 2026-08-09 found Rispadex 2 mg (Ibn Sina `640646`, EGD `10407`) set to
IGNORE since 2026-07-08 — 1,382 units, and every one of the 168 lines carried
`Supplier Name: MARCYRL / 103805`, the same supplier account as Conviban. It looked exactly like
Phoenix deleting real sales. It was not: the owner's **own** manual closing counts **zero** Rispadex
2 mg in every month (Raw vs Manual, `THREE-WAY_DETAILED_Raw-SoS-Manual_Jan-Jun_2026.xlsx`: Apr 8/0,
May 523/0, Jun 71/0). The IGNORE was making Phoenix agree with him.

**How to apply:** never judge an IGNORE from the distributor file alone — the distributor shipping it
only proves stock moved, not that it is part of a line. Check the owner's own closing workbooks for
that product label; zero in every month means the IGNORE is correct. Conversely, an IGNORE on a
retail distributor whose **tender twin** carries the same code as a real product is deliberate
de-duplication, not deletion (PS `32328` = IGNORE, PS-T = DO001, 1,220 units — the fix for the
212-unit Overseas double count). Beware near-miss brands: `Anoxicam` 20 mg is Pharma Kim's and
correctly ignored; `Royanoxicam` 8 mg (RY001) is ours. Related:
[[sos-item-codes-are-per-distributor-namespaces]], [[closing-uses-total-qty-not-effective-units]].
