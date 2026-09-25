---
name: supabase-client-15s-timeout-commits-anyway-half-applies
description: "A heavy write RPC that exceeds the app's 15s Supabase client timeout still COMMITS server-side, leaving a silent half-applied state."
metadata: 
  node_type: memory
  type: reference
  originSessionId: cf012091-137a-40a3-a348-4de268d6b8be
  modified: 2026-08-09T16:56:17.321Z
---

`getSupabaseAdmin()` aborts every request after **15s** (the default in `src/lib/supabase/server.ts`; override with `getSupabaseAdmin({ requestTimeoutMs })`). A heavy UPDATE/RPC that runs longer makes the JS client throw **"Supabase request timed out"** — but **Postgres keeps running and commits the statement**. Any later steps in a multi-call JS orchestration (rollup refresh, audit write) never run, so you get a **silent half-applied, inconsistent state with no audit row**, not a clean failure.

Hit in prod 2026-08-09: Territory **Sync** re-stamped ~14k `source_of_sales_import_rows` to today's geography (committed), the client timed out, and the 55 affected batches' rollups were never refreshed — `import_rows` on the new geography, the drilldown's rollups on the old. Recovered by refreshing the 55 batches by hand.

**Fix pattern:** do a multi-step heavy mutation in ONE server-side `plpgsql` function (one transaction, one Atlantic round trip) so a client abort rolls the whole thing back, and call it with a raised `requestTimeoutMs`. For Sync this is `phx_sync_sos_run(p_periods)` (re-stamp + refresh-affected-batches atomically, `statement_timeout 300s`), called via `getSupabaseAdmin({ requestTimeoutMs: 170_000 })`. Related: [[every-db-round-trip-crosses-the-atlantic]].
