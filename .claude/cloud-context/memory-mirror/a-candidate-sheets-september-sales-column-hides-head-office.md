---
name: a-candidate-sheets-september-sales-column-hides-head-office
description: "A Sohag candidate sheet's \"September sales\" column counts TRACKED lines only (CNS, Anti Infective, Pedia), so a customer reading 0 can still hold a Head Office row — PS/0001556117 held one, Lacto Basic 2, 209.25 EGP — which is why a 45-customer re-point that was predicted to move no September money still flipped one September import row, and the CNS area pair stayed put anyway."
metadata:
  node_type: memory
  type: project
---

Filtering a candidate list on "sold nothing this month" filters on the TRACKED lines, because that is
what every closing surface reports. **Head Office is absent from those numbers by design** (see
[[head-office-products-are-not-tracked-weekly-golden-rule]]), so "0 in September" means *0 of CNS,
Anti Infective and Pedia* — never 0 rows.

Measured 2026-10-09 while re-pointing the 45 Sohag candidates of
[[his-sohag-ruling-of-2026-10-09-moves-eight-customers]]: the 45 were selected as the sheet rows with
no September sales, and the reconcile still moved **one** September row — PS/0001556117
مجاهد محمد ج – عرب الاطاولة, line **Head Office**, Lacto Basic 2, 1 unit, 209.25 EGP, batch
`28cd2d54`. The September **CNS** area pair was unaffected and stayed at UE5 847,786.09 / UE6
267,555.00 exactly as predicted.

**How to apply:** before promising "this move touches no published or reported money", read the
cohort's import rows grouped by `invoice_period` **and `official_line`**, not by the sheet's own
sales column. The row that surprises you will be Head Office, and it is Head Office that makes the
promise true rather than false — but say so from the data, not from the sheet.
