-- WHAT: a new vendor from the Sales pharmacy-code sync starts hidden, and a read-only preflight
-- reports what the sync is about to do.
--
-- WHY (owner, 2026-11-03: "Hidden until I allow it"). The sync moves from a command run by hand to a
-- nightly job (app/api/cron/marketing-pharmacy-code-sync). Until now a vendor the Sales map named for
-- the first time was created visible, in the Vendor picker, with its codes loaded, and a person would
-- have seen that happen. 12 of the 22 vendors are hidden on purpose today, so a new one is not assumed
-- wanted. This holds for a by-hand run too: one rule. The candidate view already reads
-- distributor_active, so a hidden vendor's codes are counted in references_held_hidden_vendor and
-- land on the first run after he allows it.
--
-- The only change to the sync function is that one value, `true` to `false`. The whole body is
-- restated because CREATE OR REPLACE needs it, and its SET clause is kept.
--
-- THE PREFLIGHT. Two counts a nightly job needs and a PostgREST filter cannot give:
--   ambiguous_pairs  a (distributor, code) pair on more than one reference row. Needs a GROUP BY. Must
--                    stay 0: 44,244 of these is what the blind insert caused on 2026-08-19.
--   would_retire     what the next run's retirement pass would delete, by the function's own predicate.
--                    A broken Sales import empties the map, the codes look retired, and with no person
--                    at the keyboard they go. The job refuses to run above its limit.
--
-- ROLLBACK: restate 20260819220000's function, and drop public.phx_sales_pharmacy_code_sync_preflight().

create or replace function public.phx_sync_sales_pharmacy_codes_into_marketing()
returns table (
  distributors_created        integer,
  references_synced           integer,
  references_skipped_existing integer,
  references_retired          integer,
  references_retained_linked  integer,
  references_held_hidden_vendor integer
)
language plpgsql
set search_path = public
as $func$
declare
  v_distributors_created       integer := 0;
  v_source_pairs               integer := 0;
  v_references_synced          integer := 0;
  v_references_retired         integer := 0;
  v_references_retained_linked integer := 0;
  v_references_held_hidden_vendor integer := 0;
  v_batch uuid := gen_random_uuid();
begin
  -- Ensure every sales distributor that has customer-map rows has a matching marketing
  -- distributor (matched by normalized name; created only when missing). A new vendor is born
  -- HIDDEN (owner, 2026-11-03), so its codes wait until he allows it.
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
      false
    from sales_distributors sd
    where not exists (
      select 1 from public.marketing_distributors md
      where md.normalized_name = sd.normalized_distributor_name
    )
    returning 1
  )
  select count(*) into v_distributors_created from created;

  -- RETIREMENT. Three conditions now, all required:
  --   1. the row is one of ours (source_file);
  --   2. the live map does not justify it under THIS vendor;
  --   3. the live map does not carry the code under ANY vendor  <-- the merge guard, new here;
  --   4. nothing links to it.
  -- Condition 3 is what keeps a merged code alive. Without it this pass deletes the 2,671 rows
  -- the owner's two vendor merges produced, because the map can only ever justify them under the
  -- hidden child vendor they were merged away from.
  with retired as (
    delete from public.marketing_pharmacy_code_references r
    where r.source_file = 'source_of_sales_customer_map'
      and not exists (
        select 1 from public.phx_v_sales_pharmacy_code_candidates c
        where c.distributor_id = r.distributor_id
          and c.normalized_pharmacy_code = r.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.phx_v_sales_pharmacy_code_candidates c2
        where c2.normalized_pharmacy_code = r.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.marketing_pharmacy_distributor_codes dc
        where dc.reference_id = r.id
      )
    returning 1
  )
  select count(*) into v_references_retired from retired;

  -- Stale under this vendor but kept: either something links it, or the code is still live
  -- somewhere in the map (the merge case). Reported so the number is never a silent surprise.
  select count(*) into v_references_retained_linked
  from public.marketing_pharmacy_code_references r
  where r.source_file = 'source_of_sales_customer_map'
    and not exists (
      select 1 from public.phx_v_sales_pharmacy_code_candidates c
      where c.distributor_id = r.distributor_id
        and c.normalized_pharmacy_code = r.normalized_pharmacy_code
    );

  -- ADDITIVE INSERT. Unchanged from 20260819210000.
  with inserted as (
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
      c.distributor_id,
      c.raw_distributor_name,
      c.normalized_distributor_name,
      c.raw_pharmacy_code,
      c.raw_pharmacy_address,
      c.raw_region,
      c.raw_area,
      'source_of_sales_customer_map',
      c.source_row,
      v_batch
    from public.phx_v_sales_pharmacy_code_candidates c
    where c.distributor_active
      and not exists (
        select 1 from public.marketing_pharmacy_code_references r
        where r.distributor_id = c.distributor_id
          and r.normalized_pharmacy_code = c.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.marketing_pharmacy_code_references r
        where r.distributor_id = c.distributor_id
          and r.compact_pharmacy_code = c.compact_pharmacy_code
      )
    returning 1
  )
  select count(*) into v_references_synced from inserted;

  select
    count(*) filter (where c.distributor_active),
    count(*) filter (where not c.distributor_active)
  into v_source_pairs, v_references_held_hidden_vendor
  from public.phx_v_sales_pharmacy_code_candidates c;

  return query select
    v_distributors_created,
    v_references_synced,
    greatest(v_source_pairs - v_references_synced, 0),
    v_references_retired,
    v_references_retained_linked,
    v_references_held_hidden_vendor;
end;
$func$;

comment on function public.phx_sync_sales_pharmacy_codes_into_marketing() is
  'Idempotent: copies source_of_sales_customer_map into marketing_pharmacy_code_references, '
  'bridged to a marketing distributor by normalized name. Additive — never inserts a '
  '(distributor_id, normalized_pharmacy_code) pair that already exists under ANY source_file, and '
  'never inserts under an inactive vendor. A vendor it creates starts hidden until the owner allows it. '
  'Retires only its own rows whose code has left the live map ENTIRELY and that nothing references, '
  'so a code merged onto another vendor is never deleted. Server-only (service_role).';

create or replace function public.phx_sales_pharmacy_code_sync_preflight()
returns table (ambiguous_pairs integer, would_retire integer)
language sql
stable
set search_path = public
as $func$
  select
    (
      select count(*)::integer
      from (
        select 1
        from public.marketing_pharmacy_code_references r
        group by r.distributor_id, r.normalized_pharmacy_code
        having count(*) > 1
      ) pairs
    ),
    (
      select count(*)::integer
      from public.marketing_pharmacy_code_references r
      where r.source_file = 'source_of_sales_customer_map'
        and not exists (
          select 1 from public.phx_v_sales_pharmacy_code_candidates c
          where c.distributor_id = r.distributor_id
            and c.normalized_pharmacy_code = r.normalized_pharmacy_code
        )
        and not exists (
          select 1 from public.phx_v_sales_pharmacy_code_candidates c2
          where c2.normalized_pharmacy_code = r.normalized_pharmacy_code
        )
        and not exists (
          select 1 from public.marketing_pharmacy_distributor_codes dc
          where dc.reference_id = r.id
        )
    );
$func$;

revoke execute on function public.phx_sales_pharmacy_code_sync_preflight() from public, anon, authenticated;
grant execute on function public.phx_sales_pharmacy_code_sync_preflight() to service_role;

comment on function public.phx_sales_pharmacy_code_sync_preflight() is
  'Read-only counts for the nightly pharmacy-code sync: duplicated (distributor, code) pairs, and what '
  'the next retirement pass would delete. Same predicate as the sync function. Server-only (service_role).';
