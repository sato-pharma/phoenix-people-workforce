---
name: sos-unordered-pagination-lost-mappings
description: "Unordered .range() paging silently lost 2.5% of customer→brick mappings on every import. Fixed with keyset paging (PR #1446). Always ORDER BY when paging PostgREST."
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-29T06:12:59.846Z
---

2026-07-29. The June 2026 sales import left **15,443 units unmapped**. It looked like missing data.
It was a reader bug.

## The bug

`selectAllActive` in `src/lib/sales/normalizer/crosswalks.ts` paged with
`.range(from, from + 999)` and **no `.order()`**. Postgres guarantees no row order without
`ORDER BY`, so consecutive pages returned some rows twice and skipped others — **arbitrarily, and
differently on every run**. 1,262 of 49,713 `source_of_sales_customer_map` rows (**2.54%**) never
reached the in-memory index.

**How it was diagnosed** — the missing rows were scattered **evenly across the id range** (median id
408k vs 412k for survivors). A truncation clusters at the end; unstable paging does exactly this.
Every "unmapped" customer was already in the map, active, with a valid brick, and the lookup keys
were byte-identical (`PS`/`0001506606`, hex `30303031353036363036`).

**Ordering alone is not enough**: the import WRITES to `customer_map` while reading it, so an insert
below the cursor shifts later rows across a page boundary. The fix is **keyset** — order by the
bigint PK, `.gt("id", cursor)`, never `.range()`.

Second instance, same class: `selectAllRows` in `master-data/list.ts` had an **optional**
`orderColumn` and `preloadKeyed` omitted it. Harmless only while a master fits one page — but
`source_of_sales_bricks` was 1,142 rows on 07-28. `orderColumn` is now required.

**PR #1446, merged `c1d28dd0`.** Guarded by `tests/sos-crosswalk-pagination.test.ts` (source-shape:
the failure only reproduces against a >1000-row table under live PostgREST).

## June repair (applied to PROD 2026-07-29)

`UPDATE import_rows.brick_id FROM customer_map` on distributor+client_code, then
`phx_refresh_sos_fact_rollup(batch)` + `phx_refresh_sos_customer_directory_rollup(batch)` **one
batch at a time** (only 3 batches: PS/EG/RM — never loop these, a prior session took prod down for
2 min looping 89).

| | before | after |
| --- | --- | --- |
| units total | 314,159 | **314,159** (unchanged — nothing created/lost) |
| unmapped | 31,480 (10.0%) | 16,037 (5.1%) |
| unmapped **excl. DIRECT** | 15,443 | **0** |
| rows whose AREA changed | — | **0** |

Undo: `sos_mapping_backup_20260728.june_rows_before_repair` holds the exact prior state of the 3,184
rows. DIRECT stays unmapped **by design** (brick-level, no customer code) — not a gap.

**99.4% of the gap was one file**: `customer sales.xlsx` (PS/overseas), because it is 72% of the
import — a random 2.5% miss hits the biggest file hardest. `office 6.xlsx` (Marcyrl), Ibn Sina,
Sofico, EPDA and every tender channel were 100% clean. **Suspect the reader, not the sheet.**

See [[sos-master-complete-704-applied-2026-07-28]] and [[keyset-pagination-orderby-id-trap]].
