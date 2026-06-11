-- Day-level invoice date for Source of Sales rows — powers the Sales Intelligence daily
-- analytics (sales/customers per day, month-to-date pace, run-rate projection). Nullable and
-- additive: nothing reads it until the v2 RPCs ship, so rollback is "do nothing". New imports
-- persist it at parse time (resolveInvoiceDate); historical rows are backfilled from raw_row in
-- the companion backfill migration. A NULL here means "undated" — surfaced honestly in the UI,
-- never silently dropped.

alter table public.source_of_sales_import_rows
  add column if not exists invoice_date date null;

-- Daily aggregates group by invoice_date within one validated month.
create index if not exists sos_import_rows_invoice_date_idx
  on public.source_of_sales_import_rows (invoice_period, invoice_date)
  where invoice_date is not null;
