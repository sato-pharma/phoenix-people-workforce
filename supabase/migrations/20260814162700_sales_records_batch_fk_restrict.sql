-- ─────────────────────────────────────────────────────────────────────────────
-- Close the back door around the Rule #1 freeze on public.sales_records.
--
-- The freeze revoked service_role's INSERT/UPDATE/DELETE on sales_records so the
-- 11,267 H1 rows — the only record of what H1 2026 was actually paid on — could
-- not be changed. That revoke does NOT hold, because
-- sales_records_batch_id_fkey is ON DELETE CASCADE onto sales_import_batches and
-- a referential action executes with the TABLE OWNER's rights, not the caller's.
-- Deleting a batch therefore deletes its sales_records children regardless of
-- the grant.
--
-- MEASURED, not assumed — run on staging (cifwmndunmlxjhyjugxa), whose schema and
-- grants are identical to production (same FK, same revoke, same 3 batches /
-- 11,267 rows), against a synthetic 2099 probe batch that never touched real
-- data. As service_role, inside a DO block after `set local role service_role`:
--
--   delete from public.sales_records where batch_id = <probe>
--     -> ERROR 42501: permission denied for table sales_records
--        HINT: Grant the required privileges ... GRANT DELETE ON public.sales_records
--
--   delete from public.sales_import_batches where id = <probe>
--     -> succeeded; the probe's sales_records child row went from 1 to 0
--
-- Exposure before this change: POST /api/sales/imports/{id}/delete is live behind
-- assertPermission(access, "sales", "delete"), which only Super Admin holds. Three
-- batches hold all 11,267 rows, and production runs WITHOUT PITR (daily snapshots
-- only), so one delete is not recoverable in place.
--
-- RESTRICT rather than NO ACTION: both refuse, but RESTRICT refuses immediately
-- and cannot be deferred to commit time, so the failure surfaces at the statement
-- that caused it.
--
-- Nothing legitimate is broken by this. Approving, rejecting and replacing a batch
-- never delete rows. The one path that deletes both — the createSalesImport
-- rollback in src/lib/sales/service.ts — already deletes the sales_records children
-- BEFORE the parent batch, which is the order RESTRICT requires (and that path is
-- unreachable today anyway: the legacy import is frozen and throws 410 first).
--
-- The application also refuses this in src/lib/sales/service.ts
-- (assertSalesBatchHoldsNoFrozenRecords) so the user gets a clear message instead
-- of a raw constraint violation. This migration is the half that still holds when
-- the request does not come through that code path.
--
-- Repeatable: drop-if-exists then add, so re-running lands on the same shape.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.sales_records
  drop constraint if exists sales_records_batch_id_fkey;

alter table public.sales_records
  add constraint sales_records_batch_id_fkey
  foreign key (batch_id)
  references public.sales_import_batches (id)
  on delete restrict;

-- Fail loudly if the constraint did not land as RESTRICT ('r'), so a silent
-- partial apply cannot be mistaken for success.
do $$
declare
  v_on_delete "char";
begin
  select con.confdeltype
  into v_on_delete
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid
  join pg_namespace n on n.oid = src.relnamespace
  where n.nspname = 'public'
    and src.relname = 'sales_records'
    and con.conname = 'sales_records_batch_id_fkey';

  if v_on_delete is distinct from 'r' then
    raise exception
      'sales_records_batch_id_fkey is %, expected r (RESTRICT) — the freeze back door is still open',
      coalesce(v_on_delete::text, 'MISSING');
  end if;
end $$;
