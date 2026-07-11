-- Phase 2 perf for the ROI report. The attribution join over source_of_sales_import_rows was
-- doing, per target (distributor x product), a BitmapAnd of the distributor index (~35k rows)
-- + product index, then fetching ~692k heap blocks to recheck validation_state='valid' AND the
-- normalized client_code match (the two UNINDEXED filters) -> ~18s, ~836k buffers.
--
-- This composite PARTIAL EXPRESSION index matches the join's equality columns byte-for-byte
-- (same expressions as phx_marketing_request_roi_actuals_v2 / phx_marketing_request_view_sales),
-- so each lookup becomes a tight index seek. Measured on prod: inner join 18.4s -> 0.54s (~34x),
-- full v2 RPC 16.7s -> 0.16s (~105x), buffers 836k -> ~9k; results unchanged (220 / 300,372.56).
-- Additive + reversible (drop index). Non-concurrent create-index, matching the table's other
-- 11 indexes (small table: 120k rows / 236 MB, builds in seconds).
create index if not exists sos_rows_roi_attribution_idx
  on public.source_of_sales_import_rows (
    distributor_code,
    lower(btrim(regexp_replace(coalesce(client_code, ''), '\s+', ' ', 'g'))),
    upper(btrim(product_code)),
    invoice_period
  )
  where validation_state = 'valid';

analyze public.source_of_sales_import_rows;
