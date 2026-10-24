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

## And then it stopped joining the customers it never reads (`20261024180000`, 2026-10-24)

The door inner-joined `phoenix_crm_customers` on the Phoenix branch to emit `customer_validated`, and
`customer_name` through the person cache. An inner join must be executed even when a read selects neither
column, because it can remove rows; a LEFT join to a unique key cannot, so Postgres drops the node entirely.
The rows could not change here: `customer_id` is NOT NULL with its foreign key, and `customer_validated` is
coalesced to false so it stays two-state. The one word `left` was the whole change.

**Measured on production, both bodies as temporary views in ONE session, alternating, six runs each with the
first discarded** — so warmth and server noise fall on both equally:

| | Before | After |
| --- | --- | --- |
| Buffers (shared hit) | 22,508 | 8,808 (−13,700, −61%) |
| Server-side execution | 182.712 ms | 150.160 ms |
| Round trip including network | 358.336 ms | 284.688 ms |
| `phoenix_crm_customers` nodes in the plan | 1 | 0 |

🔴 **The buffers are the win, not the milliseconds.** The 13,700 fewer buffer reads match the 13,703 the
branch shed when measured in isolation, and they are stable. The round trip is not: an earlier alternating
pass over the same two bodies put it at 227.527 → 213.059 ms, a −6.4% against this pass's −20.6%. Quote the
buffers; quote a millisecond figure only with the pass it came from.

**Identity, in the same session:** all 148,814 rows — all time, every column — hash the same md5
`5a6976bcf91c994b338516e4d8c690ca` from both bodies. Across the apply, production's 1–23 Oct window (10,111
rows) hashed `77c08f610a785e59b806b9f78ba5dc3e` before and after, and staging's whole view (126,330 rows)
`7f3ba1fef909960a9008ecb7ca8abc63` before and after.

🔴 **The pre-existing pin was green on either word.** `tests/phoenix-crm-visits-everywhere.test.ts` asserted
`includes("join public.phoenix_crm_customers customer on customer.id = p.customer_id")`, which is a substring
of the left-join text, so it could never have caught an inner join. It now asserts the `left join` clause
whole and refuses a bare one with `!/(?<!left )join public\.phoenix_crm_customers/`; both directions were
checked by flipping the word in the live migration and watching the new assertion fire by its own headline.

**Rolling back this change alone:** re-apply the `crm_visits_unified` statement of `20261024005000`,
unchanged.
