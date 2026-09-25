---
name: sos-sales-purged-for-fresh-upload-2026-07-28
description: "All Source-of-Sales transaction data was purged from PRODUCTION on 2026-07-28 for a clean re-upload; RESOLVED — re-upload landed same day. Backup schema sos_backup_20260728 kept as a reference, not currently needed for recovery."
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-29T07:50:52.832Z
---

**Status: RESOLVED — re-upload completed 2026-07-28.** Verified 2026-07-29 via a fresh read-only
query against production: `source_of_sales_fact_rollup` has 31,631 rows again, and the latest of
18 `source_of_sales_import_batches` rows is dated 2026-07-28 22:05:21 with `status='validated'`.
The purge/recovery details below are kept for reference (the backup schema may still exist —
re-verify before assuming it does or relying on it).

On **2026-07-28** the owner ordered all Source-of-Sales **transaction** data dropped from
PRODUCTION (`ozucdzovmcqvepbozvqf`) so the distributor sheets could be re-uploaded from
scratch against the freshly-corrected geography. Emptied: `source_of_sales_import_rows`
(218,825), `fact_rollup` (158,217 = 1,441,262 units), `customer_directory_rollup` (149,488),
`customer_presence_rollup` (115,158), `import_summaries` (11,142), `import_batches` (89).

**Reference/mapping data was deliberately KEPT** — `customer_map` (49,712), `bricks` (915),
`blocks`, `areas`, `regions`, `territory_aliases` (1,213), `area_aliases` (256),
`product_aliases`, `products`, `distributors`. That is the whole point: the re-upload must
land on the corrected mapping, not rebuild the broken one.

**Why:** a day of in-place repairs (duplicate-brick merges, area re-stamps, stranded-sales
rescues) had left the numbers correct but patched. Re-uploading against the fixed master
makes every row correct at source instead of corrected after the fact.

**How to apply / RECOVERY:** the complete pre-purge state is copied in schema
**`sos_backup_20260728`** (import_rows, import_batches, import_summaries, fact_rollup,
customer_directory_rollup, customer_presence_rollup, plus customer_map/bricks/blocks/
areas/regions). Restore everything with one call:

```sql
select sos_backup_20260728.restore_all();
```

It deletes children-before-parents then re-inserts in FK order and returns the row counts it
restored. Verified: all 8 tables matched live counts exactly before the purge, and column
parity was checked (0 mismatches). `EXECUTE` was revoked from public/anon/authenticated —
service-role only. **Do not drop this schema until the re-upload is complete and reconciled.**
The rollups are also derivable from import_rows via `phx_backfill_sos_fact_rollup()` and
`phx_backfill_sos_customer_directory_rollup()` (both no-arg, rebuild everything), so there
are two independent recovery routes. See [[sos-duplicate-brick-ids-same-place]] and
[[sos-owner-standing-rules-from-session-369dd08d]].
