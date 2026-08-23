-- Nurseries are venues Phoenix visits that have no distributor account at all.
--
-- Until now every venue had to be registered as a pharmacy, and both link tables demanded a
-- distributor code (`distributor_code_id NOT NULL`). A nursery has no code to give, so the only way
-- through the form was to invent one. Production proof, 2026-08-23:
--
--   حضانه النيل        EGD  0000        -- pure placeholder, resolves nowhere
--   حضانه نور المصطفي  POS  0001000000  -- fake, later written INTO source_of_sales_customer_map
--   حضانة زمزم         POS  0001511111  -- fake, same
--
-- The last two are the real damage: once a fake code is in the sales master it resolves `exact`
-- forever and looks trustworthy to every later reader. Hospitals are NOT affected and are not part
-- of this change — all 11 active hospital venues carry real, resolving codes because hospitals
-- genuinely buy medicines.
--
-- So: name the venue type, and let a non-pharmacy venue carry no code instead of a fabricated one.

alter table public.marketing_pharmacies
  add column if not exists venue_type text not null default 'pharmacy';

alter table public.direct_order_pharmacies
  add column if not exists venue_type text not null default 'pharmacy';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'marketing_pharmacies_venue_type_check'
  ) then
    alter table public.marketing_pharmacies
      add constraint marketing_pharmacies_venue_type_check
      check (venue_type in ('pharmacy', 'nursery'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'direct_order_pharmacies_venue_type_check'
  ) then
    alter table public.direct_order_pharmacies
      add constraint direct_order_pharmacies_venue_type_check
      check (venue_type in ('pharmacy', 'nursery'));
  end if;
end $$;

comment on column public.marketing_pharmacies.venue_type is
  'pharmacy (default) or nursery. A nursery has no distributor account, so it may carry zero distributor codes and its customer/request links may hold a NULL distributor_code_id. Sales can never attribute to a nursery — ROI must report it as having no sales channel rather than a zero return.';

comment on column public.direct_order_pharmacies.venue_type is
  'pharmacy (default) or nursery. Mirrors marketing_pharmacies.venue_type so a nursery transferred from Marketing keeps its identity in Direct Orders.';

-- The reason the fake codes existed. A nursery link has nothing to point at.
--
-- Safe in both directions: dropping NOT NULL never rejects an existing row, and every row today
-- holds a value, so nothing is rewritten and no table is scanned for validation. Reversible with
-- `SET NOT NULL` for as long as no nursery link has been written.
alter table public.marketing_customer_pharmacies
  alter column distributor_code_id drop not null;

alter table public.marketing_request_pharmacies
  alter column distributor_code_id drop not null;

comment on column public.marketing_customer_pharmacies.distributor_code_id is
  'NULL only for a venue whose marketing_pharmacies.venue_type is not ''pharmacy'' (a nursery has no distributor account). A pharmacy link must always carry a code — enforced in src/lib/marketing-requests/service.ts, not by a check constraint, because the rule spans two tables.';

comment on column public.marketing_request_pharmacies.distributor_code_id is
  'NULL only for a nursery target — see marketing_customer_pharmacies.distributor_code_id. Spend on a nursery is allowed but can never be attributed to sales.';

-- Postgres does not treat two NULLs as equal, so the existing unique index on
-- (customer_id, distributor_code_id) stops nothing once the code can be NULL: the same nursery
-- could be linked to the same customer any number of times, and each duplicate would look like a
-- separate venue to every count and every ROI read. Scoped to codeless links only, so it cannot
-- collide with a pharmacy that legitimately carries several codes for one customer.
create unique index if not exists marketing_customer_pharmacies_codeless_unique
  on public.marketing_customer_pharmacies (customer_id, pharmacy_id)
  where distributor_code_id is null;

create unique index if not exists marketing_request_pharmacies_codeless_unique
  on public.marketing_request_pharmacies (request_id, pharmacy_id)
  where distributor_code_id is null;

-- The rep's hand-registration path writes through this RPC, which lists its columns explicitly, so
-- adding the column above is not enough — without this the venue type would silently default to
-- 'pharmacy' on exactly the path a rep uses when the venue is not in Phoenix yet, which is the one
-- path that matters. Body otherwise unchanged from the live definition.
create or replace function public.phx_create_direct_order_pharmacy(p_pharmacy jsonb, p_codes jsonb default '[]'::jsonb)
returns public.direct_order_pharmacies
language plpgsql
set search_path to ''
as $fn$
declare
  v_row public.direct_order_pharmacies;
begin
  insert into public.direct_order_pharmacies (
    pharmacy_name,
    brick_id,
    area_code,
    region_code,
    doctor_name,
    pharmacy_address,
    created_by_hr_id,
    verification_status,
    entry_source,
    contested_code_claims,
    venue_type
  )
  values (
    nullif(btrim(coalesce(p_pharmacy->>'pharmacy_name', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'brick_id', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'area_code', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'region_code', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'doctor_name', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'pharmacy_address', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'created_by_hr_id', '')), ''),
    -- Every hand-registered pharmacy starts unrecognised (owner rule, 2026-08-04). The caller may
    -- not choose otherwise, so the value is pinned here rather than read from the payload.
    'pending_review',
    'manual',
    case
      when jsonb_typeof(p_pharmacy->'contested_code_claims') = 'array'
        then p_pharmacy->'contested_code_claims'
      else '[]'::jsonb
    end,
    -- Whitelisted rather than passed through: an unrecognised value would fail the check constraint
    -- and take the whole registration down with it, at the moment a rep is standing in the venue.
    case
      when lower(btrim(coalesce(p_pharmacy->>'venue_type', ''))) = 'nursery' then 'nursery'
      else 'pharmacy'
    end
  )
  returning * into v_row;

  if jsonb_array_length(coalesce(p_codes, '[]'::jsonb)) > 0 then
    insert into public.direct_order_pharmacy_distributor_codes (
      pharmacy_id,
      distributor_code,
      customer_code,
      mapped_brick_id,
      mapped_area_code,
      mapped_region_code
    )
    select
      v_row.id,
      c.value->>'distributor_code',
      c.value->>'customer_code',
      nullif(btrim(coalesce(c.value->>'mapped_brick_id', '')), ''),
      nullif(btrim(coalesce(c.value->>'mapped_area_code', '')), ''),
      nullif(btrim(coalesce(c.value->>'mapped_region_code', '')), '')
    from jsonb_array_elements(coalesce(p_codes, '[]'::jsonb)) as c(value);
  end if;

  return v_row;
end;
$fn$;
