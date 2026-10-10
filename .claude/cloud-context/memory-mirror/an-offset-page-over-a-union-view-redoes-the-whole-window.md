---
name: an-offset-page-over-a-union-view-redoes-the-whole-window
description: "After the roster index, ONE statement was half of all remaining Phoenix database time — the Plan Verification board OFFSET-paging `crm_plan_entries_unified` at 791.7 ms x 192 calls, because `crm_plan_entry_id` is SYNTHESISED by the view and so can never be indexed for the sort, making every page produce and quicksort the entire month; the fix was the probe-then-keyset-days read three sibling doors already used, 17.1s -> 2.2s for a 37,161-row window, and the auth trio was already fixed so it was never the lever."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
---

Found 2026-10-10 answering his "is their any bigger win?" after the roster index shipped (PR 5738,
see [[two-thirds-of-db-time-was-an-unindexed-upper-btrim-lookup]]). Fixed in PR 5739.

🔴 **RANK THE NEXT WIN FROM A pg_stat_statements DELTA ACROSS THE FIX, NEVER FROM THE CUMULATIVE
TABLE.** Cumulative totals still carried the pre-index cost, so they said the visits view was worst;
the delta between two reads said the opposite. Post-index, over the same window:

| bucket | calls | time | mean | share |
| --- | --- | --- | --- | --- |
| everything else | +61,599 | 173,075 ms | **2.81 ms** | 55.9% |
| `crm_plan_entries_unified` | +229 | 84,447 ms | **368.8 ms** | **27.3%** |
| `crm_visits_unified` | +911 | 33,569 ms | 36.8 ms | 10.8% |
| `crm_checkins_unified` | +190 | 18,530 ms | 97.5 ms | 6.0% |

One SHAPE inside the plan bucket was **192 calls x 791.7 ms = 152,003 ms**, about half of all
database time left: `plan_kind = $1 AND plan_date >= $2 AND plan_date <= $3 ORDER BY
crm_plan_entry_id LIMIT $4 OFFSET $5` — `fetchPlanRows` in `src/lib/crm/plan-board.ts`.

🔴 **AN OFFSET PAGE CANNOT STOP EARLY, AND OVER A `UNION ALL` VIEW IT RE-MATERIALISES BOTH
BRANCHES.** `crm_plan_entry_id` is **synthesised by the view** for its Phoenix branch, so no index can
ever serve that `ORDER BY` — Postgres must produce every row in the window and quicksort them all to
hand back a thousand. Measured on the month board's real window (weekly, 2026-08-25..2026-10-07,
**37,161 rows, 44 days** — the month plus the straddle margin):

| | one request | the whole window |
| --- | --- | --- |
| OFFSET | 452.6 ms, 17,790 buffers, **sorts 31,000 rows for its 1,000** | 38 pages, **~17.1 s**, ~676,000 buffers |
| probe + keyset days | 49.1 ms, 1,739 buffers, sorts 1,054 | 1 + 44, **~2.2 s**, ~78,000 buffers |

**The repo had already solved this exact fault three times** — `readCompanyWindow` in
`src/lib/crm/reads.ts` (an UNORDERED probe page, then one keyset-cursored request per calendar day,
4 at a time), used by the visits and check-in doors and taken by the plan SCAN in
`rep-doctor-lists.ts` on 2026-10-01 with the same numbers. The BOARD was the last door still on
OFFSET. **So before designing a paging fix here, look for the existing helper.** The probe is what
keeps a small window at one request: no `ORDER BY`, so the Append stops at 1,000 rows and never
touches the second branch (70.5 ms).

**Prove the slicing equal with `EXCEPT ALL` both ways, not with counts.** A `generate_series` day
join against the single window scan: 37,161 = 37,161, **0 rows either side**, 438 plans both ways. A
null `plan_date` is excluded by `.eq("plan_date", day)` exactly as by the `gte`/`lte` pair.
**Do NOT slice a window that cannot be cut on the date:** a `month` window keys on
`plan_month`/`plan_year` and carries no `plan_date` at all, and a window naming agents is already
narrow.

🔴 **THE AUTH TRIO IS NOT A LEVER — IT WAS ALREADY FIXED, AND LOOKING LIKE A WIN IS THE TRAP.**
PostgREST served **122,832 round trips in 83 minutes** (~1,480/min) for **16,121** authenticated
requests = **~7.6 DB round trips per request**, three of them the auth trio. But
`src/lib/auth/server.ts` already runs them in one `Promise.all` and wraps resolution in React
`cache()`, and each costs 0.05-0.08 ms. The diffuse 2.81 ms "everything else" bucket is round-trip
COUNT, not a slow statement — there is no single fix in it.

Still unfixed and his call, not a defect: the CRM asks for visits **one request per calendar day**,
a **9.6x** multiplier (a month in one call 119 ms; 30 day-calls ~1,140 ms), because the fixed roster
cost is paid 30 times for 1/30th of the data.
