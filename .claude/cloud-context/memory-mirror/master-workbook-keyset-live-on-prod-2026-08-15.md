---
name: master-workbook-keyset-live-on-prod-2026-08-15
description: "Master Workbook export reads source_of_sales_import_rows in ONE keyset pass (raw_row folded in), replacing two deep-OFFSET full-table scans — LIVE prod, do not restore .range()/OFFSET or the second scan or the _aliasCache"
metadata:
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-15T00:48:47.721Z
---

`buildMasterWorkbookBuffer()` in `src/lib/sales/master-workbook.ts` (the Super-Admin-only *Download
Master Workbook* on `/sales/database-mapping` — 17 sheets rebuilt from LIVE tables every download,
`maxDuration=60s`) used to read the ~450 MB `source_of_sales_import_rows` table (309,321 rows) **twice**,
both with `.range()`/**OFFSET** pagination:
1. the 22 detail columns → `Raw_Sales` / `Normalized_Sales` / `Exceptions` + the 4 summaries, and
2. `(distributor_code, raw_row)` **again** in `buildAliasDistributorMaps` → to infer which distributor
   each learned alias came from.

Deep-OFFSET re-walks every preceding row on each of ~300 pages — **O(n²)**. Measured on prod: a single
page at offset 300k took **649 ms** (walking 301,000 index rows to return 1,000) vs **4 ms** for the
equivalent keyset page. Two passes ≈ **620 pages / ~96M row-walks per export** — what pushed this rare
manual export toward its 60 s timeout (cf. the 2026-07-27 export-500 incident). It does **not** appear in
`pg_stat_statements` — this was a per-call latency/timeout fix, **not** an aggregate-DB-time hog.

**Fix (LIVE prod 2026-08-15 03:47 Cairo, PR #2152, squash `3593ec5b`, healthz-confirmed serving):**
- New exported `keysetSelectImportRows(supabase, columns, validatedBatchIds, pageSize=1000)` walks the
  integer PK by cursor (`WHERE id > cursor ORDER BY id LIMIT 1000`) — every page a bounded index range,
  the whole read **O(n)**. `columns` MUST include `id` (the cursor advances on the last row's id).
- `raw_row` now **rides that single detail pass** and the alias→distributor maps are built in-process by
  the new pure `buildAliasDistributorMapsFromRows(rows)` — the second full-table scan is **gone**.
- The module-level `_aliasCache` / `_ALIAS_CACHE_TTL` are **deleted**: in the App Router a module `let`
  is per-route-segment, so that 5-min cache was cold on most downloads anyway (same trap as
  [[brick-centroids-cache-live-on-prod-2026-08-15]]).
- **Pure TypeScript — no migration, no index, no schema, read-only.**

**Invariants that must not be "cleaned up":**
- **Row order is byte-identical to the old pager** — batch ids chunked at 100 (undici ~16KB header cap),
  each chunk ascending by `id`, chunks concatenated in chunk order. This is NOT a global id sort: a
  high-id row in chunk 1 must precede a low-id row in chunk 2. `Raw_Sales`/`Normalized_Sales`/`Exceptions`
  render in that order, so a change is visible. Do not "simplify" to a single global `ORDER BY id`.
- **The alias fold is fed the UNFILTERED validated rows** — restricted-product (`LA003/LA004`) filtering
  happens downstream and must never narrow which distributors an alias is attributed to. Set membership
  is order-independent; a shared alias attributes to EVERY carrier distributor.
- **A failed page throws** (fails the export loudly) — never silently short the read, as the old pager's
  fail-soft did.
- **Zero-validated-batches edge case:** new reader returns `[]`; the old code was already self-inconsistent
  there (detail read dumped ALL rows incl. drafts, alias scan returned empty). Prod has 120/120 validated,
  so this path never runs — the new behavior is the safer, consistent one. Do not "restore" the all-rows dump.

**Proven output-identical on production:** keyset walk vs OFFSET walk over the full table = same 309,321
rows, all distinct ids, zero drops / zero dups (`keyset_lossless=true`). Regression guard
`tests/master-workbook-keyset.test.ts` (registered in `run-tests.ts`) pins the lossless multi-page walk,
exact-multiple terminator, chunk-then-id order, alias fold, and source guards; break-the-fix confirmed (a
global id-sort makes the order assertion fire: `[1,5,999999]` vs expected `[999999,1,5]`).

**Do NOT undo:** do not revert `keysetSelectImportRows` to `.range()`/OFFSET; do not re-add the second
`(distributor_code, raw_row)` scan or `buildAliasDistributorMaps`; do not restore `_aliasCache` /
`_ALIAS_CACHE_TTL`; do not drop `,raw_row` from the single detail read (the alias columns would silently
blank).

Same performance campaign as [[closing-matrix-fold-live-on-prod-2026-08-15]],
[[brick-centroids-cache-live-on-prod-2026-08-15]],
[[search-direct-order-customer-code-trgm-live-on-prod-2026-08-14]] and
[[vacation-report-cross-request-cache-live-on-prod-2026-08-14]]. This is the same deep-OFFSET class
already fixed in the CRM day-map pushdown and the weekly dashboard keyset — check any `.range()` over a
large table for it. Next profiling pass: read prod `pg_stat_statements` again for the next target.
