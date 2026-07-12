-- Close the sales-import duplicate-batch race (audit finding M1).
--
-- createSalesImport (src/lib/sales/service.ts) detects duplicates with a SELECT-then-INSERT: it
-- SELECTs for an existing non-replaced/rejected batch with the same duplicate_hash, sets an
-- is_duplicate flag, then INSERTs the batch regardless. Under two concurrent uploads of the same
-- sheet the SELECTs can both miss -- the first batch's records are inserted in a separate, later
-- statement, so the second upload's record-count check sees 0 records and treats the first batch as
-- "not a real duplicate". Both batches end up flagged is_duplicate = false, so both pass the
-- approval-time re-check and can be approved -> double-counting.
--
-- This partial unique index makes the batch INSERT the atomic arbiter: at most one active batch per
-- duplicate_hash can exist, so the losing concurrent INSERT fails with SQLSTATE 23505, which the
-- application now surfaces as a clean "already uploaded" 409 (see the isPostgresUniqueViolation
-- handling in createSalesImport). It mirrors source_of_sales_one_validated_batch_per_period, the
-- unique index that already protects the parallel Source-of-Sales pipeline.
--
-- Empty duplicate_hash values (the column default) and replaced/rejected batches are excluded so the
-- guarantee applies only to active, hash-bearing batches.
--
-- SAFE: additive index only. No rows are read, modified, or deleted by this migration.
--
-- PRE-APPLY REQUIREMENT (staging first, per AGENTS.md): because the current application code inserts
-- duplicates (flagged and un-approvable, but still present), production may already contain more than
-- one active batch sharing a duplicate_hash. CREATE UNIQUE INDEX will FAIL to build if such
-- collisions exist. Before applying, audit and resolve collisions with:
--
--   select duplicate_hash, count(*)
--   from public.sales_import_batches
--   where status not in ('replaced', 'rejected') and btrim(duplicate_hash) <> ''
--   group by duplicate_hash
--   having count(*) > 1;
--
-- Resolve any results by marking the older batch(es) status = 'replaced' before applying.

create unique index if not exists sales_import_batches_active_duplicate_hash_uidx
  on public.sales_import_batches (duplicate_hash)
  where status not in ('replaced', 'rejected') and btrim(duplicate_hash) <> '';
