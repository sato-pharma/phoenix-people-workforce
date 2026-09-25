---
name: vs-target-achievement-cache-token-live-on-prod-2026-08-15
description: "loadAchievementRange served from a self-invalidating token cache — LIVE prod 08-15 (#2161), do NOT undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-15T13:34:56.596Z
---

`loadAchievementRange` (in `src/lib/sales/vs-target.ts`) — the field force's **#1 prod query by
DB time** (`phx_sales_vs_target_range` → `au.f_sales_vs_target_range` → `au.f_monthly_achievement`,
~208ms plpgsql × ~486 calls/window) — is now served from a **cross-request `unstable_cache`** keyed
on a DB freshness token. LIVE prod 08-15, PR #2161, squash `ebf80b20`, healthz confirmed serving it.
Migration `20260815120000_phx_sales_vs_target_cache_token.sql`; the token function was applied to
staging **and** prod BEFORE the merge, so the merge shipped only the TS caller (no ordering risk).

**The token = the invalidation.** `public.phx_sales_vs_target_cache_token()` is an md5 over
`au.f_attribution_config_fingerprint()` + whole-table hashes of `au.occupancy_history` +
`au.monthly_targets` + `au.monthly_attribution_rollup_meta` + today's Cairo date. It is folded into
the cache key, so any seat/target/config/actuals change (or Cairo midnight) lands on a new key and
misses. **Do NOT** replace it with a plain TTL or a tag-busted cache: the output carries the AS-OF
seat occupant (`rep_hr_id`/`dm_hr_id`) and "today's wiring wins" means one current seat move rewrites
the occupant on EVERY historical period — the org/seat write surface has no single chokepoint, so a
tag cache would silently mis-attribute money-adjacent achievement. **Fail-safe:** a null token reads
live (never a hard dependency). The publish gate and all TS folding stay OUTSIDE the cache.

**Why:** correct-by-construction caching without hunting every org/seat/target write path; 27ms warm
token vs 208ms range recompute, paid once per request.

**How to apply / trap:** `phx_sales_vs_target_cache_token` is **deliberately allowlisted** in
`tests/au-seat-occupant-resolver.test.ts` §1 (`WHOLE_TABLE_FINGERPRINT_ALLOWLIST`) because it hashes
`occupancy_history` whole-table on purpose. **NEVER "fix" it by adding an `effective_to` filter** —
that narrows the hash and lets a superseded-span change slip past the cache key, reintroducing the
exact staleness it prevents. The guard's §2 newest-row-wins ban still covers the migration, so the
allowlist opens no resolver hole. The token must keep hashing ALL rows of every input table.

Related: the achievement engine it wraps reads [[attribution-rollup-applied-to-prod-2026-08-14]];
the two period gates it must not unify live in the same file
([[published-and-uploaded-period-gates-must-never-be-unified]]); sibling self-invalidating cache
pattern [[brick-centroids-cache-live-on-prod-2026-08-15]].
