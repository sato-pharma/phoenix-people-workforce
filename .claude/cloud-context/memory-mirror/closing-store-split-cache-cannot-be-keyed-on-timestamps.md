---
name: closing-store-split-cache-cannot-be-keyed-on-timestamps
description: "The closing store-split cache can serve stale numbers, and NO timestamp on its source tables can detect it — source_of_sales_import_rows has no updated_at and no trigger, and geography re-stamps are direct SQL"
metadata: 
  node_type: memory
  type: project
  originSessionId: ff721f65-99c8-4ef2-92f2-305a08d0d465
  modified: 2026-08-11T16:24:11.539Z
---

`loadClosingStoreSplit` (`src/lib/sales/closing-store-split-net.ts`) caches the wholesaler city
split per (line, period), `revalidate: 3600`, tag `closing-store-split`. Since 2026-08-11 the SCREEN
and the EXPORT both read that one result, so they can no longer disagree with each other — but they
can both be stale together, and that half is **still open**.

**Only three paths invalidate it**: a validated monthly import, publish, and unpublish
(`invalidateClosingStoreSplitCache`). Meanwhile **fifteen modules write
`source_of_sales_customer_map`**, and a brick/geography move is a **direct SQL UPDATE across four
tables** including `source_of_sales_import_rows` (see
[[moving-a-sos-brick-between-areas-needs-four-restamps]]) — bypassing the app entirely.

**Why the obvious fix does not work.** Verified against production 2026-08-11:

- `source_of_sales_import_rows` has **`created_at` only — no `updated_at` column**.
- The **only triggers** on `import_rows` / `import_batches` / `customer_map` are the three closing
  lock guards (`phx_reject_write_to_locked_closing`). **No `updated_at` trigger anywhere.**
- So `max(updated_at)` is app-maintained at best, and a direct-SQL re-stamp moves none of it.

A timestamp fingerprint would therefore look rigorous and silently miss the exact operation that
most needs to bust the cache. (For reference, the fingerprint query itself is cheap — 41.7ms
server-side including two seq scans of `customer_map`'s 52,614 rows — so cost was never the
objection; correctness was.)

**How to apply.** Do NOT close this by adding `invalidateClosingStoreSplitCache` calls to write
paths — that rebuilds the hand-maintained list of exceptions that caused
[[exceljs-workbooks-are-recalculated-on-open]]'s 1.1M EGP miss. The two defensible options are a
**statement-level trigger stamping a version row** that the cache key reads (a migration, so owner
approval), or moving the split into an **RPC** computed live — `phx_closing_channel_breakdown`
already proves the store/pharmacy classification is expressible in SQL via its `p_store_stems` /
`p_pharmacy_override_codes` arguments. The RPC route is faster but risks the SQL diverging from the
TS rule, which is the owner's source of truth. Note also that with the split ON, a **same-city**
customer move changes the closing by zero ([[city-split-hides-same-city-customer-moves]]), so only
**cross-city** re-points actually expose the staleness.
