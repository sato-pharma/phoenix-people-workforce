# The visits door reads the vendor table once

`crm_visits_unified` (migration `20261024005000_crm_visits_unified_one_scan.sql`) is replaced in place. Nothing about its output changes: the same 63 columns in the same order, `security_invoker = true`, the same grants (postgres and service_role only). The md5 of every row over its whole history is identical before and after: 87,709 rows before 2026-07-01, 35,736 in July-August, 25,039 from September on.

## What was slow

The door split `ireports360_visits` on the first team start into two `UNION ALL` branches, so one read scanned that table twice. The second branch asked whether the rep already had a Phoenix entry that day twice, each time against a materialized CTE over `phoenix_crm_rep_entry_days()`. A function scan carries no statistics and no index, so the planner walked all 542 rows of that CTE once per vendor row. On one October day that was 4,052 join-filter evaluations thrown away, and the cost grows with both the rows and the number of entry days.

## What it is now

One scan, with the start bound as an ordinary filter. The two checks read `phoenix_crm_rep_entry_days_cache` directly, so they use its primary key `(hr_key, entry_day)` and its partial index `(agent_crm_id, entry_day)`. `phoenix_crm_rep_entry_days_calc()` stays the only body that computes an entry day.

## Measured on production (nine interleaved runs of each shape)

| Shape | Before | After |
| --- | --- | --- |
| One day (22 Oct) | 17.0 ms | 7.0-7.8 ms |
| A month straddling the first team start | 563.1 ms | 320-336 ms |
| A month entirely before it | 405.9 ms | 410.0 ms (no entry-day check runs, nothing to save) |

## `crm_checkins_unified` is deliberately not touched

It carries the same construct. The same rewrite was built, proved byte-identical over all 142,363 of its rows and measured: 11.3 to 11.8 ms on a day and 419.5 to 411.8 ms on a month, no gain. Its cost is the rows it returns, not the entry-day check. Measure again before changing it.

## Rolling back

Re-apply the `crm_visits_unified` statement of `20261023153000`, unchanged.

Pinned by `tests/phoenix-crm-visits-everywhere.test.ts`.
