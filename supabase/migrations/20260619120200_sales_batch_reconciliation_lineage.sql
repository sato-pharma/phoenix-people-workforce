-- C3 + C5 — reconciliation breakdown + lineage on Source-of-Sales import batches.
-- Additive nullable columns (coded = importable_rows, blocked = failed_rows, read = total_rows
-- already exist). APPLIED to production 2026-06-19 via MCP; this file mirrors it for pipeline parity.

alter table public.source_of_sales_import_batches add column if not exists rows_ignored integer;
alter table public.source_of_sales_import_batches add column if not exists rows_blank integer;
alter table public.source_of_sales_import_batches add column if not exists recognition_engine_version text;

comment on column public.source_of_sales_import_batches.rows_ignored is 'C3: rows dropped as intentionally-ignored products.';
comment on column public.source_of_sales_import_batches.rows_blank is 'C3: rows skipped for blank customer/territory.';
comment on column public.source_of_sales_import_batches.recognition_engine_version is 'C5: recognizer version that produced this batch (lineage).';
