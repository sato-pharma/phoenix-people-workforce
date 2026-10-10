---
name: set-config-call-count-is-the-round-trip-count
description: "`set_config(search_path…)` in pg_stat_statements IS the count of PostgREST HTTP round trips — PostgREST runs exactly one per request inside the query's transaction; it read 176,110 in two hours against 21,333 authenticated requests, so Phoenix makes ~8.3 round trips per page."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
  modified: 2026-10-10T10:44:52.569Z
---

Production, 2026-10-10, a 118-minute window: `set_config(search_path…)` showed **176,110 calls**, 48.1% of all statements, at 0.03 ms each. It is not application SQL — PostgREST emits one per HTTP request, inside that request's own transaction. **So its call count is the round-trip counter, and nothing else in the database gives you one.**

Against it, the auth trio read `employees` 21,366 / `app_auth_users` 21,333 / `app_sessions` 21,333 — three identical counts, because `resolveSessionState()` fired all three on every authenticated request. That is **64,032 of 176,110 round trips, 36% of all PostgREST traffic, for 0.2 ms of SQL**, and 176,110 ÷ 21,333 = **8.3 round trips per authenticated request**.

**Why:** it reframes what "slow" means here. The database was never busy — 354,655 calls in the same window took 1,779,161 ms of execution, a **5.0 ms mean**, about **49 ms of DB execution per request** against a 647 ms median page (~7%), with the container at 1% of 24 vCPU and 3 active connections of 200. The cost is the *number* of cross-border HTTPS calls (Railway europe-west4 → Supabase eu-central-1), not the SQL in them.

**How to apply:** rank a latency fix by how many round trips it removes, not by how much SQL time it saves — and read the `set_config` count first to know the denominator. 🔴 **`Promise.all` fixes LATENCY, never COUNT:** the trio had been wrapped in it for months, which is exactly why it had been written off as "already fixed, not a lever" — three concurrent calls still cost three round trips. Related: [[two-thirds-of-db-time-was-an-unindexed-upper-btrim-lookup]], [[an-offset-page-over-a-union-view-redoes-the-whole-window]], [[a-supabase-stall-costs-a-minute-not-15-seconds]].
