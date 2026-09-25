---
name: attribution-rollup-applied-to-prod-2026-08-14
description: "monthly attribution rollup gating au.f_monthly_achievement is LIVE on prod, proven piastre-identical — do NOT redo/undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-14T16:28:50.816Z
---

Applied to PRODUCTION `ozucdzovmcqvepbozvqf` on 2026-08-14 (migration
`20260814160000_monthly_attribution_rollup`), independent of the merge. **Do NOT redo or undo the
prod apply.** The source ships in PR #2138 (`codex/sales-attribution-rollup`), held for a separate
merge approval — the DB object is live NOW whether or not that PR is merged.

What is live: `au.monthly_attribution_rollup` (+ `_meta`) precomputes ONLY the occupancy-independent
money columns of `au.f_monthly_attribution` (period, line, area, region, product, units, value).
`au.f_monthly_achievement` is now GATED: it reads the rollup only when the period is covered AND
`au.f_attribution_config_fingerprint()` matches the stored fp; on any drift/uncovered period it
falls back to `au.f_monthly_achievement_live` (the exact old body). Seat occupancy
(`f_seat_occupant_asof`, today's-Cairo-date arm) and `au.monthly_targets` stay LIVE in the reader —
never materialised.

Never-stale: `public.phx_refresh_monthly_attribution(batch)` is wired AFTER the fact refresh inside
`phx_finalize_sos_batch` / `phx_sync_sos_run` / `phx_backfill_sos_fact_rollup` and the 4 TS trio
sites. The fingerprint hashes 5 config tables; `au.line_area_map` is hashed WHOLE-TABLE (every span
via `m.*`) — it is only ever HASHED, never JOINed, so the au-seat-occupant-resolver double-count
guard is satisfied, not weakened. Do NOT simplify that term to an open-span-only read.

Proof on prod: coverage 8/8 periods, 0 stale fp. Gated reader `EXCEPT ALL` the pre-apply snapshot of
the OLD function = 0/0 both directions (piastre-identical). Gated `EXCEPT ALL` `_live` = 0/0
(structural). Latency all-8-periods 2,276 ms → 178–198 ms warm (~12x). `get_advisors(security)` flags
none of the new objects (au schema non-exposed; the 2 public fns are service_role-only). Sibling of
[[closing-channel-rollup-applied-to-prod-2026-08-14]] and
[[closing-channel-breakdown-rollup-applied-to-prod-2026-08-14]].
