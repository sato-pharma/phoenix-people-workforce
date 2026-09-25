---
name: brick-centroids-cache-live-on-prod-2026-08-15
description: "CRM loadBrickCentroids() moved from a per-segment module cache to unstable_cache (sos-reference tag) — LIVE prod, do not undo/restore the module cache"
metadata:
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-14T23:07:44.240Z
---

`loadBrickCentroids()` in `src/lib/crm/brick-geo.ts` (the one returning `BrickCentroid[]`, NOT the
`Map`-returning namesake in `src/lib/sales/normalizer/brick-centroids.ts`) was the **single heaviest
production DB consumer** after the 2026-08-14 pg_stat_statements reset: **55.3 s over 3,372 calls in a
3.6 h window**, ~40× more reads than its own 5-minute TTL should allow. Root cause: it cached in a
module-level `let cache`, but in the App Router **each route segment gets its own module instance**,
so the singleton was cold on most of its hot callers (`crm/master.ts` check-ins, `outstation`
captured-location + expense-claim-validation). The TTL was fine; the cache simply was not shared.

**Fix (LIVE prod 2026-08-14 23:04 UTC = 2026-08-15 ~02:04 Cairo, PR #2150, squash `76f22e20`,
healthz-confirmed serving):** wrap the read in Next.js `unstable_cache` (shared across every route
segment via the Data Cache), keyed `["crm-brick-centroids"]`, **`revalidate: 300`** (byte-for-byte
the old `CACHE_TTL_MS = 5*60*1000`), tag **`["sos-reference"]`**. Invalidation was ALREADY wired —
`invalidateSalesDashboardCache` fires `sos-reference` on every validated SoS import, and
`dashboard/invalidation.ts` already documents brick centroids as a `sos-reference` consumer — so
**zero write paths were touched**.

**Two invariants that must not be "cleaned up":**
- **The `try/catch` lives OUTSIDE the cache, deliberately.** `unstable_cache` only caches a RESOLVED
  value, so the cached fn throws on DB error and nothing is cached; the public wrapper turns that into
  `[]` and retries next request — exactly the old behaviour. Moving the catch INSIDE the cached fn
  would cache `[]` for 5 min on a transient blip and blank the Brick/Area/Region overlay. Never do it.
- **DB query + in-memory join are byte-identical**, so no rendered Brick/Area/Region value can move —
  only WHERE the result is stored changed. An index/cache swap can't alter a result set.

**Do NOT undo:** do not restore the `let cache` module variable, do not change `revalidate` off 300,
do not drop the `sos-reference` tag, do not move the catch inside the cache. Regression guard
`tests/crm-brick-centroids-cache.test.ts` (registered in `run-tests.ts`) pins all four; break-the-fix
confirmed (`revalidate:300`→`60` goes red on the staleness assertion).

Same performance campaign as [[search-direct-order-customer-code-trgm-live-on-prod-2026-08-14]] and
[[vacation-report-cross-request-cache-live-on-prod-2026-08-14]]. The next profiling pass should read
prod pg_stat_statements again (the 2026-08-14 ~18:52 UTC reset window is now post-this-fix too).
