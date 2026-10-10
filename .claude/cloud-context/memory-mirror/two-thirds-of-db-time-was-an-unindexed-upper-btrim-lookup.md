---
name: two-thirds-of-db-time-was-an-unindexed-upper-btrim-lookup
description: "66.3% of ALL Phoenix database time was `phoenix_crm_started_team_reps()` rebuilding a 39-row roster, because its LATERAL matches `upper(btrim(e.hr_id))` against `employees` and no index could serve that expression — 39 reps x a 56-page seq scan = ~45 ms per call, and `crm_visits_unified` calls it twice, `crm_plan_entries_unified` three times; one expression index took a single-day read from 99.9 ms to 38.4 ms, and the app's one-request-per-calendar-day slicing costs 9.6x on top."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
  modified: 2026-10-10T09:10:22.854Z
---

Measured on production 2026-10-10 answering his "how to accelerate performance to max".

🔴 **`pg_stat_statements` BUCKETED BY VIEW IS THE FIRST READ, AND IT NAMED THE WHOLE PROBLEM IN ONE
QUERY.** Three views were **66.3% of all database time on 2.1% of the calls**, while every other
statement in Phoenix averaged **1.8 ms**:

| bucket | calls | total | mean |
| --- | --- | --- | --- |
| `crm_visits_unified` | 3,023 | 429,785 ms | 142.2 ms |
| `crm_plan_entries_unified` | 512 | 147,582 ms | 288.2 ms |
| `crm_checkins_unified` | 457 | 95,998 ms | 210.1 ms |
| everything else | 187,845 | 342,239 ms | **1.8 ms** |

**The cause was one unindexable expression.** `phoenix_crm_started_team_reps()` resolves each seat
occupant's CRM id with a `left join lateral … where upper(btrim(e.hr_id)) = upper(btrim(o.occupant_hr_id))`.
`employees` is 213 rows / **56 pages**, and no index matched that expression, so each of the ~39 reps
cost a full scan: ~2,190 buffer hits, **~45 ms per call of the function**. `crm_visits_unified` calls
it **TWICE** (two `NOT EXISTS` clauses) and `crm_plan_entries_unified` **THREE** times. So a
single-day CRM read spent **~95 ms of its ~100 ms rebuilding a 39-row roster and 0.36 ms reading the
visits** — the roster was 87% of the work. Fixed by
`create index employees_hr_id_upper_trim_idx on public.employees (upper(btrim(hr_id)))` (PR 5738):

| | before | after |
| --- | --- | --- |
| `crm_visits_unified`, one day | 99.9 ms / 5,185 buffers | **38.4 ms / 1,028 buffers** |
| `crm_plan_entries_unified`, one day | ~288 ms live mean | **23.2 ms / 1,272 buffers** |
| the roster function alone | 45 ms / 2,190 buffers | **~2.5 ms / 89 buffers** warm |

It took **22,269 index scans in its first minutes** live. A `lower(btrim(hr_id))` twin took **zero** —
the function's `lower(...)` output is a hash-join key, never an index probe; the `drop index` for it
was **declined by the classifier** and left unapplied (unused, not harmful) — see
[[a-production-delete-is-declined-by-the-classifier]].

🔴 **THE REMAINING MULTIPLIER IS THE APP, AND IT IS 9.6x.** The CRM asks for visits **one request per
calendar day**. A whole month in ONE call is **119 ms**; thirty single-day calls are **~1,140 ms** for
the same rows, because the fixed roster cost is paid 30 times for 1/30th of the data. For a month the
real visit scan genuinely dominates (14,849 of 15,740 buffers, ~1 buffer/row); for ONE day it is 135
data buffers against 881 roster buffers. Collapsing the slicing is an application change and his
scale decision, not a defect to fix unasked.

**Why the roster cannot simply be inlined away:** both `phoenix_crm_started_team_reps()` and
`phoenix_crm_started_team_seats()` are `STABLE SECURITY DEFINER` with `SET search_path TO 'public'`,
and **a `SET` clause blocks SQL-function inlining** — so each appearance is an opaque function scan
the planner cannot push filters into (it estimates `ROWS 60` against 39/49 actual). Removing the
`search_path` pin would inline them and is a **security regression on a SECURITY DEFINER function** —
never do it. Making them cheap means materialising the roster, not unpinning it.

**Where the time was NOT:** the container sat at **0.23 of 24 vCPU (1%)** and the database at
**3 active connections of 200**. A slow Phoenix is not evidence of a busy box — see
[[a-supabase-stall-costs-a-minute-not-15-seconds]].

Traps hit on the way: `round(double precision, integer)` does not exist (cast to `numeric`);
`crm_plan_entries_unified`'s date column is **`plan_date`**, not `visit_date`; a `create temp table`
benchmark harness is **declined by the classifier**, so time it with repeated
`explain (analyze, buffers)` instead; and `RAISE NOTICE` output never comes back through
`execute_sql`.
