---
name: closing-channel-rollup-applied-to-prod-2026-08-14
description: "phx_closing_channel_totals now reads a precomputed per-customer rollup — DB migration LIVE on prod 08-14, piastre-identical, do NOT redo/undo; PR #2115 (TS wiring) MERGED 08-14 — FULLY SHIPPED, nothing left to build"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-16T03:17:56.323Z
---

The Monthly-Closing **Channel Comparison** read (`phx_closing_channel_totals`) was moved off the
~2.3s live retail scan onto a precomputed table `source_of_sales_channel_customer_rollup`. Migration
`closing_channel_customer_rollup` applied to BOTH staging and **production** (`ozucdzovmcqvepbozvqf`)
on **2026-08-14** — apply returned success, objects verified via `pg_class`/`pg_proc`.

**Classification stays LIVE** — the stems/override lists from [[sos-monthly-closing-is-the-only-sales-truth]]'s
`customer-channel.ts` are still applied per-call inside the read function, so editing that file still
reclassifies all history. Only the vocab-independent money+name rollup is baked; the channel VERDICT
is **NOT** baked. The read fn signature is unchanged, so the swap is backward-compatible with the
currently-deployed app code.

**Proven on prod, do NOT redo/undo:** EXCEPT-diff v2 vs a live-v1 snapshot = **0 rows both
directions**, 252=252 slice×variant×period rows, value sum **833,575,898.03 identical**; latency
**3,715ms → 1,194ms (−67%)**, all buffers cache-hit. Table = **158,232 rows across 120 batches**.

Design invariants (a future edit must preserve): two-bucket split — non-restricted = `*_all −
*_restricted`, include-restricted = `*_all`; **presence decided on `rows_kept > 0`, NOT money**
(value coalesces `factory_price` to 0, so a present customer can sum to 0). Restricted set =
exactly `{LA003,LA004,SS001}`. Exclude-guard **raises 22023** if `p_exclude_codes` is neither `[]`
nor that set. Names resolved WITHIN-period (period is in the `distinct on` key) — never
newest-across-periods. `batch_id` FK `ON DELETE CASCADE` auto-cleans superseded batches.

**Refresh wiring — COMPLETE. PR #2115 MERGED 2026-08-14T02:05:44Z (branch `codex/closing-channel-rollup`).**
The migration `CREATE OR REPLACE`d the three DB functions `phx_finalize_sos_batch`,
`phx_sync_sos_run`, `phx_backfill_sos_fact_rollup` to call `phx_refresh_sos_channel_rollup(batch)`
after the roi refresh, AND the 4 direct-TS-trio call-sites (`normalizer/customer-map.ts`,
`normalizer/mapping.ts`, `normalizer/service.ts`, `monthly-distributor-import.ts`) now issue
`supabase.rpc("phx_refresh_sos_channel_rollup", { p_batch_id })` after their trio — re-verified on
`origin/main` 2026-08-16, sitting right beside the DP refresh from #2171. The old staleness window is
CLOSED; **there is nothing left to build or merge for channel-totals.** (`phx_backfill_sos_fact_rollup()`
stays channel-aware as the belt-and-suspenders resync.) See [[railway-merge-is-the-production-deploy]].

Sibling `phx_closing_channel_breakdown` (adds area/rep/brick/product geography + store-city-split +
July-direct overlay) is the natural fast-follow reusing this same rollup — not done.
