---
name: weekly-module-audit-2026-08-15
description: "Full Weekly Sales module audit 2026-08-15 — what is clean, and what the 2,667 price mismatches really are. The 2 alias conflicts were RULED and reconciled the same day: weekly PS 32328 moved DO002 to DO001 and RM 64774 moved TE004 to TE005, so weekly and monthly now agree. Do NOT act on the old \"awaiting ruling, do not change either mapping\" line — restoring either mapping would re-open a settled conflict."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b612b65-4e36-471e-997c-1c2d24313b24
  modified: 2026-08-15T12:21:40.519Z
---

Full audit of Weekly Sales on prod, 2026-08-15, over 51 batches / 7 distributors / 38,490 rows.

**Clean and re-checkable:** `total_rows`, `total_net_qty`, `total_stock_qty`, `total_sales_qty`,
`total_return_qty` match their rows exactly on all 51 batches. `orphan_rows 0`, `dup_week 0`,
`dup_cycle_slot 0`, `rows_unknown_master 0`, `rows_no_line 0`.

**`total_sales_value` never ties to full precision, and that is BY DESIGN — do not "fix" it.** The
header is rounded to 2 dp at insert while rows keep 3+ dp, so at 6 dp **31 of 51 batches differ** and
at 2 dp **4 differ** (the four whose row sum ends in a half cent rounding the other way). Worst
single batch 0.005 EGP, whole-module absolute 0.111835, **net signed 0.008495 EGP** over 38,490 rows.
Compare at 2 dp and always read the magnitude — an earlier headline of "zero mismatches" this session
came from a coarser tolerance and overstated it.

**2,667 "price mismatches" are NOT a defect — do not "fix" them.** Each of 6 products carries one
uniform row price against a master price that has since changed: SS001 203.78 vs 190.08 now,
SA001 126.72 vs 111.15, LA003 159.588 vs 209.25, LA004 171.864 vs 209.25, LA001/LA002 225.06 vs
270.00. Rows correctly keep the price they were valued at. A row price differing from today's master
proves nothing on its own.

**34 rows with no region** are all `Unallocated POS` (PS) — a deliberate bucket, not missing data.

**The 470 IGNORE rows are GONE — deleted from prod 2026-08-15 on the owner's "fix all those", do NOT
recreate.** They were June Overseas rows for three other manufacturers' products (13512 Trencedia,
35098 Vonopep, 47057 Lacto LF) carrying 1,390 net + 4,174 stock units at zero value into the June
dashboard, while every upload after #2153 excludes such rows outright. Confined to exactly two
batches — PS 2026-06-20 (234 rows) and PS 2026-06-27 (236 rows). Deleted with every header column
moved in the SAME statement (`total_rows`, `importable_rows`, net/stock/sales/return/bonus qty);
`total_sales_value` did not move because the rows were valued at zero. `weekly_sales_rows` went
38,490 → 38,020 and `product_code = 'IGNORE'` is now 0 rows.

**Reversible:** the rows are in `public.zz_backup_weekly_ignore_rows_20260815` with grants revoked
from `anon`/`authenticated`/`public` and RLS enabled — `get_advisors(security)` reports only "RLS
enabled, but no policies exist", which is the intended service-role-only state, NOT an exposure
([[ad-hoc-backup-tables-are-anon-readable]]). Restoring means re-inserting and moving the two headers
back by the same amounts.

**2 alias conflicts** out of 34 codes aliased in both Weekly and Monthly — sent as an XLSX with
dropdowns 2026-08-15, **awaiting ruling, do not change either mapping**:
`PS 32328` (weekly DO002 Dopaminect 1mg 36.45 vs monthly IGNORE — every row is a tender branch,
1,227 de-cumulated units / 44,724.15 EGP) and `RM 64774` (weekly TE004 vs monthly TE005, 2 stock-only
rows, zero value). The `PS 32328` ruling also decides whether the 4,738.50 restored into the June
headers belongs there.

**How to apply:** this is the audit baseline — re-run the header-vs-rows check before asserting the
module is healthy ([[weekly-batch-header-drifts-from-its-own-rows]],
[[weekly-ignore-aliases-can-contradict-monthly-sos]],
[[direct-is-not-cumulative-but-is-de-cumulated-anyway]]).

## 2026-09-04 — both alias conflicts were RULED and applied on 2026-08-15

The section above says the two conflicts were sent as an XLSX and are **"awaiting ruling, do not
change either mapping."** The owner ruled the same day. That sentence is now the dangerous kind
of stale: it reads as a live instruction to preserve mappings that have already been deliberately
changed, so acting on it would re-create the conflict the audit found.

Live in production `ozucdzovmcqvepbozvqf`:

| alias | weekly | monthly | agree? |
| --- | --- | --- | --- |
| `PS` / `32328` | `DO001` (updated 2026-08-15 15:01 Cairo) | `DO001` (2026-08-15 15:08) | yes |
| `RM` / `64774` | `TE005` (updated 2026-08-15 15:01) | `TE005` (2026-08-06 15:51) | yes |

So weekly `PS 32328` moved **DO002 to DO001** and weekly `RM 64774` moved **TE004 to TE005** — in
both cases weekly was brought onto the monthly mapping, which is the direction the
monthly-closing golden rule would predict. The two rows were written seven minutes apart on the
afternoon of the audit.

The rest of this audit — the price-mismatch explanation especially — was not a question and still
stands. Only the alias hold is closed.
