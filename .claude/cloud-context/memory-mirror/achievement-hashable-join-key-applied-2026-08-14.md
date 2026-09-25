---
name: achievement-hashable-join-key-applied-2026-08-14
description: "au.f_monthly_achievement rejoins on a hashable join_key not four IS NOT DISTINCT FROM cols; applied to prod+staging 2026-08-14 (PR #2109), do not redo/undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-13T23:35:51.062Z
---

`au.f_monthly_achievement` (the per-month engine behind `public.phx_sales_vs_target_range` /
`au.f_sales_vs_target_range`, the Sales-vs-Target range report) rejoined its `keys` CTE back to
`actuals` and `tgt` with four-column `IS NOT DISTINCT FROM` predicates. Those are NULL-safe on
purpose (a sale with no line / area / product must not zero out) but **un-hashable**, so each rejoin
ran as a nested loop. **Applied to PROD (`ozucdzovmcqvepbozvqf`) AND staging
(`cifwmndunmlxjhyjugxa`) 2026-08-14, PR #2109 — do NOT redo or undo.**

**Was:** `left join actuals ac on (4 cols) is not distinct from` + same for `tgt`. On prod 2026-07:
847,356 + 702,756 rows removed by join filter, ~510 ms/month burned. Through the range reporter this
was **7.0% of all prod DB time** (2,752,709 ms / 2,261 calls, 1,217 ms mean, 7,044 ms max).

**Now:** each side builds one text `join_key = concat_ws(chr(31), coalesce(line,chr(30)),
coalesce(area,chr(30)), coalesce(direct_region,chr(30)), coalesce(product,chr(30)))` and the rejoins
are plain `= k.join_key`, which the planner hashes/merges. Measured **848→351 ms/month**; the range
report **818→401 ms** for the 2-month window. The two rejoins drop ~510 ms → ~26 ms.

**Correctness precondition:** equal `join_key` ⟺ all four columns pairwise `IS NOT DISTINCT FROM`,
because the NULL-marker `chr(30)` and the delimiter `chr(31)` are control characters that never occur
in a line/area/region/product code. **If a code ever starts containing chr(30)/chr(31), revisit.**
Proven output-identical on prod for both data months — full 19-col rows diffed both ways with EXCEPT
against a throwaway copy of the exact migration body: 2026-07 965 rows, 2026-08 669 rows, zero
symmetric difference; live function confirmed 965/669 after apply.

**Trap avoided:** the live function was `STABLE PARALLEL SAFE` (marked by
`pg_health_parallel_safe_reporting_chain`). `CREATE OR REPLACE` resets any unstated characteristic to
its default, so the migration **re-declares `parallel safe`** — omitting it would have silently
regressed it to PARALLEL UNSAFE. Verified live `proparallel='s'` after apply. Nothing else changed:
channel filter still absent, `direct_region_code` carrying + grouping, `region_dm`, rep columns from
`lam` alone, strict `=` seat join, `has_actual` off `coalesce(ac.matched)`; revoke-PUBLIC + grant
service_role re-applied.

Ledger version `20260813233309` (name `achievement_hashable_join_key`) drifted from the filename
`20260814100000_achievement_hashable_join_key.sql` — normal MCP-stamps-own-clock behaviour, matched
by name like the two prior fixes. Pinned by `tests/achievement-hashable-join-key.test.ts`.

Fourth of a same-session perf run: [[sales-vs-target-cost-is-inside-au-monthly-attribution]]
(attribution #2101, the floor under this one) and
[[weekly-dashboard-keyset-pagination-applied-2026-08-14]] (#2107) are two of the others.
