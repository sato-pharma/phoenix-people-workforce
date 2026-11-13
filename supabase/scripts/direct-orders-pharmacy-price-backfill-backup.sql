-- Pre-restatement snapshot for the direct-order pharmacy-price recompute.
--
-- Run this IMMEDIATELY BEFORE `direct-orders:pharmacy-price-backfill apply`, via
-- `node scripts/apply-sql-file.mjs supabase/direct-orders-pharmacy-price-backfill-backup.sql`.
-- The script's own JSON pre-image covers the request rows; this covers the Source-of-Sales side,
-- which the rebuild REPLACES rather than edits — once a DirectReq batch is superseded there is no
-- other copy of what it contained.
--
-- The snapshot lives in a DATED SCHEMA, never in `public`. `scripts/check-sql-backup-placement.ts`
-- (wired into CI as its own step) fails the build on `public.*_backup_*`, because a backup table
-- in `public` is reachable by the anon key — that is a real, previously-live exposure, not a
-- style preference. The revokes below are part of the same rule.
--
-- Change the date suffix on every run; never overwrite a previous snapshot.

begin;

create schema if not exists direct_orders_backup_20260803;

-- anon/authenticated inherit through PUBLIC, so revoking only those two is a no-op.
revoke all on schema direct_orders_backup_20260803 from public;
revoke all on schema direct_orders_backup_20260803 from anon, authenticated;

-- Every direct order, not just the ones being changed: the cheapest way to be able to answer
-- "what did this look like before" for any row someone asks about afterwards.
create table if not exists direct_orders_backup_20260803.direct_order_requests as
  select * from public.direct_order_requests;

-- The injected sales themselves. `phx_rebuild_direct_order_sos_batch` supersedes the prior batch
-- and re-stamps sos_batch_id, so these two tables are the only record of the pre-restatement
-- Source-of-Sales position for the direct channel.
create table if not exists direct_orders_backup_20260803.sos_batches_directreq as
  select * from public.source_of_sales_import_batches
   where distributor_code = 'DirectReq';

create table if not exists direct_orders_backup_20260803.sos_rows_directreq as
  select r.*
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
   where b.distributor_code = 'DirectReq';

revoke all on all tables in schema direct_orders_backup_20260803 from public;
revoke all on all tables in schema direct_orders_backup_20260803 from anon, authenticated;

commit;

-- Proof to paste back before applying anything:
--   select 'requests' as t, count(*) from direct_orders_backup_20260803.direct_order_requests
--   union all select 'batches', count(*) from direct_orders_backup_20260803.sos_batches_directreq
--   union all select 'rows',    count(*) from direct_orders_backup_20260803.sos_rows_directreq;
