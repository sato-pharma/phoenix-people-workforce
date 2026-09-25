---
name: keyset-pagination-orderby-id-trap
description: "Keyset-paginating a Supabase/Postgres query by ORDER BY id is only fast if id is part of the query's actual filter index — otherwise it silently abandons the real index"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fd28c01-1b85-4e3d-aac4-0dafb7be681f
---

When keyset-paginating a query (`.order("id").gt("id", cursor)`) to avoid a flat `.limit()`'s truncation risk, `id` must be part of (or correlated with) the index that actually serves the query's WHERE clause — otherwise Postgres abandons that index entirely and does an index-scan-in-id-order-with-row-by-row-filter instead, which can be 10-20x slower than an unordered flat-limit query at real data scale.

**Why:** Found via direct `EXPLAIN ANALYZE` against production while building the [[crm-integrity-module]] report. `fetchCheckinsForAgents` filtered `ireports360_checkins` by `(agent_crm_id IN (...), check_date BETWEEN ...)` — a range this table has a real composite index for — but ordered by `id` (a random UUID, unrelated to that index) for keyset pagination. Result: Postgres used the primary-key (`id`) index instead of the composite one, discarding 6,906 non-matching rows just to fill one 2000-row page — 12.8s. Removing the `ORDER BY id` (or ordering by a column that IS part of the real index, e.g. `check_date`) let Postgres use the composite index properly — 592ms, a ~20x speedup. The exact same anti-pattern was independently confirmed to already exist, unmodified, in the already-shipped `src/lib/visits-report/service.ts`'s own `getDistinctAgentNames`/`getUnmappedCrmIdentities` (6.9s on an identical real query) — it doesn't currently time out in production, but is a real, pre-existing, unfixed performance gap there too.

**How to apply:** Before keyset-paginating any new query in this codebase, check what index actually serves the WHERE clause, and either (a) order by a column that's part of that index (accepting non-uniqueness tradeoffs — e.g. `check_date` isn't guaranteed unique but real GPS timestamps essentially never collide in practice), or (b) if a small distinct/summary result is all that's needed (not every individual row), skip pagination entirely and use a single flat, generously-capped, *unordered* query instead (this is what `attachNearestCheckins` already does successfully, and what both fixes in this codebase now do). Never assume `ORDER BY id` is a safe, free "more robust than a flat limit" upgrade — verify with `EXPLAIN ANALYZE` against real data volume, especially in this codebase's larger CRM-mirror tables (`ireports360_visits`/`ireports360_checkins`, 90K+/78K+ rows).
