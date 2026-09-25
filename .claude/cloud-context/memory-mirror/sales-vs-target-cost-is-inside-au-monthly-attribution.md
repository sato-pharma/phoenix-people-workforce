---
name: sales-vs-target-cost-is-inside-au-monthly-attribution
description: "phx_sales_vs_target_range is a thin wrapper; 64% of its time is au.f_monthly_attribution, which carries the Office golden rule and must not be rewritten casually"
metadata:
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-13T20:42:50.952Z
---

**Found by the `db-health-snapshot` cron on 2026-08-14, not by a person** — once
`phx_closing_channel_totals` was fixed, this became the heaviest query in production:
**1,214 ms mean, 7,044 ms max, 156 calls per 6-hour window.**

Do not go looking in `public`. It is a thin wrapper and the work is all in `au`:

```
phx_sales_vs_target_range
  -> au.f_sales_vs_target_range     loops once per month in the range
    -> au.f_monthly_achievement     746 ms per month
      -> au.f_monthly_attribution   479 ms   <- 64% of the cost
      -> au.f_line_area_map_asof      3 ms
      -> au.f_seat_occupant_asof     12 ms   (300 calls, 2 per map row)
```

**Cost shape: ~762 ms fixed + ~167 ms per additional month** (1 month 762 ms, 2 months 929 ms,
measured warm). The range is capped at 24 months, so the ceiling is **~4.5–6.5 s**, NOT the ~18 s
a linear reading of the per-month loop suggests. Don't raise it as an emergency; don't dismiss it
either.

It is **CPU-bound, not I/O-bound** — every buffer was `shared hit`, zero reads — so no index will
touch it. The `max_exec_time` of 7,044 ms against a measured 762 ms is contention under load, not
a wider date range (only 2 months of data exist and wider requests get clamped by the
`2026-07-01` floor), which makes it evidence for the compute-size question, not a query defect.

**FIXED 2026-08-14, applied to production — do NOT redo.** PR #2101 /
`20260814010000_attribution_preaggregate_before_seat_join`. `au.f_monthly_attribution`
**461 → 313 ms**, `phx_sales_vs_target_range` Jul–Aug **873–929 → 762/734 ms**. Two changes only:
it joined all 19,677 fact rows to the seat map and *then* grouped to 838 — it now **groups first
and joins the 838**; and `priced` was trimmed from `fa.*` to the nine columns actually read
(carrying the rest through the CTE tuplestore cost ~43 ms). The sort it removes came from a
**136× misestimate** (145 rows planned, 19,677 returned) picking GroupAggregate+Sort over
HashAggregate — same class as `20260811000200`.

**The precondition that makes it equivalent:** `(line_code, area_code)` must stay unique in
`au.f_line_area_map_asof` — otherwise the join fans out and the sums change. Verified for all 8
period-ends (150 rows, 150 distinct keys, 0 dupes). **If a seat model change ever allows two rows
per (line, area), this rewrite silently double-counts.**

**Rejected after measuring, don't repeat:** `fact as materialized` is *slower* (203 vs 188 ms).
Marking the chain `PARALLEL SAFE` (PR #2099) bought nothing — see
[[public-functions-are-parallel-unsafe-by-default]].

**Still true:** this function carries the Office allocation golden rule — see
[[owner-office-allocation-rule-value-share]] and [[office-golden-rule-is-mechanically-locked]].
The rewrite changed only grouping ORDER and one projection width; every filter, join predicate,
sum and emitted column is character-identical, proven by a 14-column FULL OUTER JOIN over all 8
periods (5,979 rows, 0 mismatches, 70,001,594.19138270 EGP both sides) plus an unchanged
`f_monthly_achievement` md5. **Any further change here needs that same proof, not an eyeball.**

**Why:** the wrapper name is in `public` and every instinct is to optimize there; the real cost is
two levels down in a schema most sessions never open.

**How to apply:** when a `phx_*` RPC is slow, run `pg_get_functiondef` FIRST and follow the
wrappers down before measuring anything. Several `phx_*` reporters are one-line wrappers over
`au.f_*`. See [[every-db-round-trip-crosses-the-atlantic]].
