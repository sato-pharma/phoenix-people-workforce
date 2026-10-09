---
name: a-line-scoped-re-resolve-leaves-the-other-lines-contradictions
description: "`reconcile-month-customer-map.ts --line=<x>` selects pairs that contradict on THAT line only; a customer wrong on another line alone is never considered, so a clean `--line=cns` verification can sit beside 149 still-wrong Pedia and Anti Infective rows in the same repaired batch."
metadata:
  node_type: memory
  type: project
---

The repair is per `(distributor, customer)` and **ignores the period** — the script says so — but the
**selection** is per line: `pairsToRepair` skips every row whose `normalizedLine(official_line)` is
not the `--line` argument. So a pair is only repaired if it contradicts the active map *on the line
you named*. Its other lines' rows then come along for free, which is what makes the dry run's list
wider than the line asked about and hides the gap: the run looks like it covered everything.

Measured on 2026-10-09 after `--period=2026-09 --line=cns --apply` re-pointed 2,643 rows across 8
files: **September CNS contradictions were genuinely 0**, and in the very same repaired batch
`28cd2d54` there were still **91 Pedia rows (29,230.88 EGP)** and **58 Anti Infective rows
(10,955.80 EGP)** contradicting, plus 930 Head Office rows (566,113.86) that are correctly left
alone. Those customers were wrong on Pedia or Anti Infective but not on CNS, so they were never
candidates.

**Why:** a line-scoped verification query answers exactly the line it was scoped to, and reads as a
whole-month all-clear. The second run's own dry run confirmed the same figures to the pound from the
other direction, which is the cross-check worth doing.

**How to apply:** after any `--line=` run, re-ask the contradiction count **per line** before saying
a month is clean — join `source_of_sales_import_rows` to the active `source_of_sales_customer_map`
and group by `official_line`, not by the line you repaired. Note `validation_state` is `'valid'`,
not `'validated'` (a wrong literal returns all-null and reads as no data), and remember Head Office
is tracked in no closing, so its contradictions are left in place. Related:
[[a-customer-map-re-resolve-stales-a-pre-october-office-spread]],
[[a-mismatch-query-hides-the-row-that-matches]].
