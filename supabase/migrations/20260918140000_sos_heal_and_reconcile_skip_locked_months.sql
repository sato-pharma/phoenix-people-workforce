-- The history heal and the history correction now step around a locked month instead of failing on it.
--
-- WHAT WENT WRONG. phx_reject_write_to_locked_closing guards source_of_sales_import_rows FOR EACH
-- STATEMENT: if any one row the statement touches sits in a locked (period, line), the whole statement
-- is rejected. Both functions below update every row of one customer in ONE statement, so a single
-- row in a published month cancelled the customer's entire heal - the unlocked months included.
--
--   * sos_backfill_import_rows_from_customer_map (the heal, run after every mapping save): its caller,
--     backfillCustomerRows in src/lib/sales/normalizer/mapping.ts, swallows the error by design, so
--     the heal silently did nothing. Measured on production 2026-09-18: Pharma Overseas August holds
--     83 brick-less rows across 61 customers (EGP 599,092) in a locked month, and every one of those
--     customers would have had its later, unlocked months left unhealed too.
--   * sos_reconcile_import_rows_from_customer_map (the Super-Admin history correction): it failed
--     loudly instead, so a customer with any published month could not be corrected at all.
--
-- THE FIX. Each UPDATE now skips a row whose (invoice_period, official_line) carries an open lock,
-- using exactly the predicate the lock trigger itself applies, so the statement never reaches a
-- locked row and the rest of the customer heals. A published and announced month is never corrected
-- (the owner's standing rule): its rows stay exactly as published, and the lock trigger stays as the
-- backstop. sos_count_reconcilable_import_rows, the dry-run preview of the history correction, gets
-- the same filter so the count it shows is the count the correction will change.
--
-- Nothing else changes: the heal still fills only a missing brick (NULL or the normalizer's ''
-- sentinel) and never re-points one; the reconcile still re-stamps on brick OR area OR region; both
-- keep their return shapes and their service_role-only grants.

begin;

create or replace function public.sos_backfill_import_rows_from_customer_map(p_distributor text, p_customer text)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_batches uuid[] := '{}';
begin
  with updated as (
    update public.source_of_sales_import_rows r
    set brick_id    = m.brick_id,
        area_code   = b.area_code,
        area_name   = coalesce(a.area_name, r.area_name),
        region_code = b.region_code,
        region_name = coalesce(g.region_name, r.region_name)
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where upper(btrim(m.distributor_code)) = upper(btrim(p_distributor))
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
      and upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      -- Fills a MISSING brick only ('' is the normalizer's "unresolved" sentinel); re-pointing an
      -- existing one is sos_reconcile_import_rows_from_customer_map's job.
      and (r.brick_id is null or r.brick_id = '')
      -- A locked month is never corrected. Skip its rows so they cannot cancel the whole heal.
      and not exists (
        select 1
        from public.monthly_closing_locks l
        where l.period = r.invoice_period
          and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
          and l.unlocked_at is null
      )
    returning r.batch_id
  )
  select count(*)::integer, coalesce(array_agg(distinct batch_id), '{}')
  into v_count, v_batches
  from updated;

  updated_rows := v_count;
  affected_batch_ids := v_batches;
  return next;
end;
$function$;

create or replace function public.sos_reconcile_import_rows_from_customer_map(p_distributor text, p_customer text)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
begin
  with target as (
    select m.brick_id, b.area_code, b.region_code, a.area_name, g.region_name
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.distributor_code = p_distributor
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
    limit 1
  ),
  updated as (
    update public.source_of_sales_import_rows r
    set brick_id = t.brick_id,
        area_code = t.area_code,
        area_name = coalesce(t.area_name, r.area_name),
        region_code = t.region_code,
        region_name = coalesce(t.region_name, r.region_name)
    from target t
    where r.distributor_code = p_distributor
      and r.client_code = p_customer
      and (   r.brick_id    is distinct from t.brick_id
           or r.area_code   is distinct from t.area_code
           or r.region_code is distinct from t.region_code )
      -- A locked month is never corrected. Skip its rows so they cannot cancel the whole correction.
      and not exists (
        select 1
        from public.monthly_closing_locks l
        where l.period = r.invoice_period
          and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
          and l.unlocked_at is null
      )
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  return query select v_rows, v_batches;
end;
$function$;

create or replace function public.sos_count_reconcilable_import_rows(p_distributor text, p_customer text)
returns table(affected_rows integer, affected_batch_ids uuid[], current_bricks jsonb, target_brick_id text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target_brick text;
  v_rows integer;
  v_batches uuid[];
  v_current jsonb;
begin
  select m.brick_id into v_target_brick
  from public.source_of_sales_customer_map m
  where upper(btrim(m.distributor_code)) = upper(btrim(p_distributor))
    and m.customer_code = p_customer
    and m.active
    and m.brick_id is not null
  limit 1;

  if v_target_brick is null then
    return query select 0, '{}'::uuid[], '{}'::jsonb, null::text;
    return;
  end if;

  -- Locked months are left out of the preview because the correction leaves them out.
  select count(*), coalesce(array_agg(distinct r.batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from public.source_of_sales_import_rows r
  where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
    and r.client_code = p_customer
    and r.brick_id is distinct from v_target_brick
    and not exists (
      select 1
      from public.monthly_closing_locks l
      where l.period = r.invoice_period
        and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
        and l.unlocked_at is null
    );

  select coalesce(jsonb_object_agg(brick_id, cnt), '{}'::jsonb) into v_current
  from (
    select coalesce(nullif(r.brick_id, ''), '(none)') as brick_id, count(*) as cnt
    from public.source_of_sales_import_rows r
    where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      and r.brick_id is distinct from v_target_brick
      and not exists (
        select 1
        from public.monthly_closing_locks l
        where l.period = r.invoice_period
          and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
          and l.unlocked_at is null
      )
    group by 1
  ) g;

  return query select v_rows, v_batches, v_current, v_target_brick;
end;
$function$;

revoke execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  to service_role;

revoke execute on function public.sos_reconcile_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_reconcile_import_rows_from_customer_map(text, text)
  to service_role;

revoke execute on function public.sos_count_reconcilable_import_rows(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_count_reconcilable_import_rows(text, text)
  to service_role;

commit;
