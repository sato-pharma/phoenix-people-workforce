---
name: command-center-perf-on2-sales
description: "Admin Command Center slowness was an O(n²) sales-ownership re-indexing bug; fixed via WeakMap memo. Where to look if perf regresses."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7a4fd344-9e8e-4a7f-8f44-4e6f52c8d8df
---

The Admin Command Center (and Data Health audit) once took ~36s to load. Root cause was NOT data volume (sales_records is only ~3.2k rows) — it was an O(n²) bug: `classifySalesOwnership` (src/lib/workforce-classification.ts) calls `buildSalesOwnershipContext(context)` **on every record**, rebuilding the entire employee-directory index (~157 employees × 4 lookup maps) once per sales row. That ~39s of churn also saturated the single localhost→Supabase connection, dragging every *other* concurrent KPI (leave/payroll/lifecycle) up to ~18s each — they looked slow but were victims, not causes.

Fix (commit 099b6b12): memoize the indexed context by input identity with a `WeakMap` inside `buildSalesOwnershipContext`. It is a pure function of a read-only context that callers build once. Result: getSalesPlatformMetrics 46s→5.8s, getDataHealthStats 36s→0.9s, Command Center cold 36s→2.3s. Numbers byte-identical before/after.

**Why:** the heavy KPI builders (`getPlatformMetrics` in src/lib/platform/metrics.ts) fan out 9 metrics with `Promise.all`, so the page is only as fast as its slowest query — and one O(n²) function poisoned the whole pool via connection contention.

**How to apply:** If the Command Center/dashboards get slow again, profile the *individual* metric builders in isolation first (not concurrently — concurrency masks the real culprit). Beware any code that calls `classifySalesOwnership` or `buildSalesOwnershipContext` inside a loop without a stable, memoized context object. Mutating a context after first index would return a stale memo — callers must treat it as read-only. Related: [[supabase-dual-project-schema]] (local .env.local may point at a sparse project, so validate perf fixes against representative data).
