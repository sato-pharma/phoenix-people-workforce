-- Link the Marketing reference database to the Sales module's pharmacy-code map.
--
-- 1) Add a normalized pharmacy code so the "is this code already in our Phoenix
--    database?" lookup on the Customer Validation page is an exact, indexed match. The
--    previous lookup fetched only the first 20 references per distributor and filtered in
--    memory, so it returned "not found" for almost every code once a distributor had more
--    than 20 references.
-- 2) Provide a re-runnable sync that copies the Sales customer map
--    (source_of_sales_customer_map) into marketing_pharmacy_code_references, bridged to a
--    marketing distributor by normalized name. As Sales imports more distributors, re-run
--    the sync (or scripts/sync-sales-pharmacy-codes-into-marketing.ts) to grow coverage.

alter table public.marketing_pharmacy_code_references
  add column if not exists normalized_pharmacy_code text
  generated always as (lower(btrim(regexp_replace(coalesce(raw_pharmacy_code, ''), '\s+', ' ', 'g')))) stored;

create index if not exists marketing_pharmacy_code_refs_norm_lookup_idx
  on public.marketing_pharmacy_code_references (distributor_id, normalized_pharmacy_code);

create or replace function public.phx_sync_sales_pharmacy_codes_into_marketing()
returns table (distributors_created integer, references_synced integer)
language plpgsql
set search_path = public
as $func$
declare
  v_distributors_created integer := 0;
  v_references_synced integer := 0;
  v_batch uuid := gen_random_uuid();
begin
  -- Ensure every sales distributor that has customer-map rows has a matching marketing
  -- distributor (matched by normalized name; created only when missing) so the synced
  -- pharmacy codes can attach to a selectable vendor.
  with sales_distributors as (
    select d.distributor_code, d.distributor_name, d.normalized_distributor_name
    from public.source_of_sales_distributors d
    where d.normalized_distributor_name is not null
      and btrim(d.distributor_name) <> ''
      and exists (
        select 1
        from public.source_of_sales_customer_map m
        where m.distributor_code = d.distributor_code and m.active
      )
  ), created as (
    insert into public.marketing_distributors (distributor_code, display_name, normalized_name, source_name, active)
    select
      'SOS_' || sd.distributor_code,
      sd.distributor_name,
      sd.normalized_distributor_name,
      sd.distributor_name,
      true
    from sales_distributors sd
    where not exists (
      select 1 from public.marketing_distributors md
      where md.normalized_name = sd.normalized_distributor_name
    )
    returning 1
  )
  select count(*) into v_distributors_created from created;

  -- Refresh sales-sourced references (idempotent: clear the previous sync, then re-insert).
  delete from public.marketing_pharmacy_code_references
  where source_file = 'source_of_sales_customer_map';

  with synced as (
    insert into public.marketing_pharmacy_code_references (
      distributor_id,
      raw_distributor_name,
      normalized_distributor_name,
      raw_pharmacy_code,
      raw_pharmacy_address,
      raw_region,
      raw_area,
      source_file,
      source_row,
      import_batch_id
    )
    select
      md.id,
      sd.distributor_name,
      sd.normalized_distributor_name,
      btrim(m.customer_code),
      m.address,
      m.region_code,
      m.area_code,
      'source_of_sales_customer_map',
      m.id::integer,
      v_batch
    from public.source_of_sales_customer_map m
    join public.source_of_sales_distributors sd
      on sd.distributor_code = m.distributor_code
    join public.marketing_distributors md
      on md.normalized_name = sd.normalized_distributor_name
    where m.active
      and coalesce(btrim(m.customer_code), '') <> ''
      and btrim(sd.distributor_name) <> ''
      and sd.normalized_distributor_name is not null
    returning 1
  )
  select count(*) into v_references_synced from synced;

  return query select v_distributors_created, v_references_synced;
end;
$func$;

revoke all on function public.phx_sync_sales_pharmacy_codes_into_marketing() from public;
grant execute on function public.phx_sync_sales_pharmacy_codes_into_marketing() to service_role;

comment on function public.phx_sync_sales_pharmacy_codes_into_marketing() is
  'Re-runnable: copies source_of_sales_customer_map into marketing_pharmacy_code_references, bridged to a marketing distributor by normalized name. Server-only (service_role).';
