-- Add 8 columns to source_of_sales_import_rows that the normalizer writes
-- but were never included in the original foundation migration.
-- Using IF NOT EXISTS so this is safe to apply even if columns were added manually.

ALTER TABLE source_of_sales_import_rows
  ADD COLUMN IF NOT EXISTS area_code     text,
  ADD COLUMN IF NOT EXISTS area_name     text,
  ADD COLUMN IF NOT EXISTS block_code    text,
  ADD COLUMN IF NOT EXISTS brick_id      text,
  ADD COLUMN IF NOT EXISTS client_address text,
  ADD COLUMN IF NOT EXISTS client_code   text,
  ADD COLUMN IF NOT EXISTS client_name   text,
  ADD COLUMN IF NOT EXISTS discount      numeric;
