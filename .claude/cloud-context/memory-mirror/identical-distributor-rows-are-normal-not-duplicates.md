---
name: identical-distributor-rows-are-normal-not-duplicates
description: "There is no invoice-number column on `source_of_sales_import_rows`, so a duplicate check grouped on customer+product+qty+value+date flags 923 CNS September rows that are legitimate repeat invoice lines — the same share it flags in July and August, which are PUBLISHED."
metadata:
  node_type: memory
  type: reference
  originSessionId: 9828b8ae-f17d-4189-8df8-a7baee24cd4f
  modified: 2026-10-10T12:36:59.779Z
---

Measured on production 2026-10-10, grouping `source_of_sales_import_rows` of validated batches by
`batch_id, distributor_code, client_code, product_code, qty, bonus_qty, value, invoice_date,
area_code` and counting the surplus of each group:

| Line | Jul | Aug | Sep |
| --- | --- | --- | --- |
| CNS | 1.7% of value | 1.4% | 1.5% |
| Anti Infective | 2.0% | 3.1% | 4.0% |
| Pedia | 0.3% | 20.6% | 0.3% |
| Head Office | 11.5% | 8.9% | 23.9% |

July and August are published. Every line and every month carries the pattern at a similar rate, so
it is the ordinary shape of a distributor sheet — one customer buying one product more than once in
a month, on the same or a null invoice date — not a double-added book. (The percentage is an upper
bound: it multiplies the surplus count by the group's row value.)

**Why:** the table has no invoice number and no line number from the source sheet, so nothing in the
data distinguishes a genuine second line from a re-added one. A check that cannot tell them apart
cannot be evidence of either.

**How to apply:** never report this as a duplicate finding. The real duplicate guard is the month's
completeness read — books present, missing 0, drift 0 — and the row/unit/value tie against the
stored closing. If a book really were added twice its whole total would double and the tie would
break. See [[verify-the-emitted-artifact-never-the-source]].
