-- WHAT: `source_of_sales_import_batches.file_sha256` — the SHA-256 of the bytes an upload was read
--       from (enterprise audit REC-069, F-SAL-002; 14 Nov 2026), and a partial index on it.
-- WHY:  the duplicate guard (src/lib/sales/import-duplicate-guard.ts) could only match the same file
--       NAME with the same figures, so a renamed copy of a month's workbook loaded under another month
--       walked through. The owner chose (14 Nov 2026) to refuse identical bytes under a different month
--       or a different distributor, naming the upload it repeats; the same distributor and month stays
--       the replace flow. Nullable: every batch stored before today has no fingerprint, and none is
--       invented for it.
-- ROLLBACK: drop index if exists public.source_of_sales_import_batches_file_sha256_idx;
--           alter table public.source_of_sales_import_batches drop column if exists file_sha256;
--           (the column holds only fingerprints; dropping it loses nothing else)

alter table public.source_of_sales_import_batches
  add column if not exists file_sha256 text;

comment on column public.source_of_sales_import_batches.file_sha256 is
  'SHA-256 (hex) of the bytes this batch was read from; several sheets in one batch hash their sorted digests. Null before 14 Nov 2026. Read by the duplicate-upload guard.';

create index if not exists source_of_sales_import_batches_file_sha256_idx
  on public.source_of_sales_import_batches (file_sha256)
  where file_sha256 is not null;
