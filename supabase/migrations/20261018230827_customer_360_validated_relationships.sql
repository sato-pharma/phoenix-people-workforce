-- customer_360_validated_relationships
--
-- WHAT THIS CHANGES (Customer 360 v2 — the validated-customer relationship report, owner 2026-10-18):
--   1. customer_identity_links_source_check gains 'visit_feedback' and 'marketing_customer'.
--   2. New table customer_360_pharmacy_matches — the tie between a pharmacy NAME a rep typed on a
--      validated doctor's visit and the distributor customer codes of the shop it names, decided
--      automatically (one shop of that name in that brick) or by the Super Admin on the module's
--      "Pharmacy matches" tab.
--   3. New read function phx_crm_contact_visit_months(contact ids, from) — each validated customer's
--      visits per month, rep, AM/PM tag, source and visit type, over the visits door
--      (crm_visits_unified), one row per contact with the months as jsonb.
--   4. New read function phx_closing_customers_for_pairs(line, periods, pairs) — the Monthly Closing's
--      OWN customer rows (phx_closing_customers, unchanged) for several months at once, narrowed to the
--      distributor code pairs of the pharmacies linked to a customer.
--
-- WHY:
--   1. A LATENT DEFECT, measured 2026-10-18: app/api/customer-identity/decide/route.ts accepts
--      'visit_feedback' (since 2026-10-01) but the constraint still allowed only four sources, so the
--      Super Admin confirming a typed-pharmacy link was refused with 23514. 'marketing_customer' is the
--      marketing doctor/clinic register joining the identity engine as a candidate source.
--   2. The owner's ruling (2026-10-18): "if you find the same pharmacy name in the same brick where the
--      doctor is validated, then automatic validate. If uncertain, make another tab in the same module
--      for me, the admin, to confirm it." Keyed on name + brick, so tomorrow's visit naming the same
--      shop is tied at once. Auto ties never go into customer_identity_links.
--   3. The report needs, for ~2,250 validated contacts, which lines see each one month by month. Reading
--      the visit rows to the app would be ~150,000 rows; the fold is done here, one row per contact,
--      so a call of 500 contacts stays under PostgREST's 1,000-row cap.
--   4. Monthly Closing is the ONE source of sales truth. This wraps phx_closing_customers — it decides
--      nothing of its own (price, Head Office exclusion, direct value, the closing's placement all stay
--      in that function) — and only filters to the linked pairs, one call per line instead of one per
--      line and month. A pair may carry a brick_id: a distributor whose code is not proof of a shop
--      (EP-PHS) is matched on its brick as well.
--
-- Both functions are SECURITY DEFINER (search_path public), executable by service_role only, exactly
-- like phx_crm_contact_visit_history and phx_closing_customers. The table has RLS on with no policy:
-- service role only, read and written by the app's server code.
--
-- ROLLBACK:
--   drop function if exists public.phx_closing_customers_for_pairs(text, text[], jsonb);
--   drop function if exists public.phx_crm_contact_visit_months(bigint[], date);
--   drop table if exists public.customer_360_pharmacy_matches;  -- SAFE: only this feature writes it
--   alter table public.customer_identity_links drop constraint customer_identity_links_source_check;
--   alter table public.customer_identity_links add constraint customer_identity_links_source_check
--     check (source = any (array['phoenix_crm','marketing','direct_order','ireports360']));
--   (the narrower check fails if a visit_feedback or marketing_customer link has been confirmed since)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one constraint widened, one new empty table, two new functions.

begin;

set local lock_timeout = '5s';

-- 1. The identity link sources ----------------------------------------------------------------------

alter table public.customer_identity_links drop constraint if exists customer_identity_links_source_check;
alter table public.customer_identity_links
  add constraint customer_identity_links_source_check
  check (source = any (array[
    'phoenix_crm'::text,
    'marketing'::text,
    'direct_order'::text,
    'ireports360'::text,
    'visit_feedback'::text,
    'marketing_customer'::text
  ]));

-- 2. The visit-named pharmacy ties ------------------------------------------------------------------

create table if not exists public.customer_360_pharmacy_matches (
  id uuid primary key default gen_random_uuid(),
  -- identityNameKey() of the typed name (src/lib/customer-identity/suggestions.ts).
  name_key text not null check (length(btrim(name_key)) > 0),
  -- The brick of the validated place the name was typed at.
  brick_id text not null check (length(btrim(brick_id)) > 0),
  -- One spelling a rep actually typed, for the screen.
  typed_example text not null,
  status text not null check (status in ('auto', 'confirmed', 'rejected')),
  -- How it was decided: 'one_shop_in_brick' (auto) or 'admin' (his click).
  method text not null check (method in ('one_shop_in_brick', 'admin')),
  -- [{distributor_code, customer_code, customer_name, brick_id}] — empty for 'rejected'.
  pairs jsonb not null default '[]'::jsonb check (jsonb_typeof(pairs) = 'array'),
  decided_by_hr_id text,
  decided_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by_hr_id text,
  created_at timestamptz not null default now(),
  constraint customer_360_pharmacy_matches_admin_has_actor
    check (method <> 'admin' or decided_by_hr_id is not null),
  constraint customer_360_pharmacy_matches_withdrawn_has_actor
    check (withdrawn_at is null or withdrawn_by_hr_id is not null)
);

comment on table public.customer_360_pharmacy_matches is
  'Customer 360: the tie between a pharmacy name typed on a validated customer''s visit (name_key + brick) '
  'and the distributor customer codes of that shop. auto = exactly one shop of that name in the brick; '
  'confirmed / rejected = the Super Admin on the Pharmacy matches tab. One live row per name_key + brick; '
  'undo withdraws. Never copied into customer_identity_links. See '
  'supabase/migrations/20261018230827_customer_360_validated_relationships.sql.';

create unique index if not exists customer_360_pharmacy_matches_one_live
  on public.customer_360_pharmacy_matches (name_key, brick_id)
  where withdrawn_at is null;

create index if not exists customer_360_pharmacy_matches_status
  on public.customer_360_pharmacy_matches (status)
  where withdrawn_at is null;

alter table public.customer_360_pharmacy_matches enable row level security;
revoke all on table public.customer_360_pharmacy_matches from public, anon, authenticated;
grant select, insert, update on table public.customer_360_pharmacy_matches to service_role;

-- 3. Visits per validated customer per month --------------------------------------------------------

create or replace function public.phx_crm_contact_visit_months(
  p_contact_crm_ids bigint[],
  p_from date
)
returns table (
  contact_crm_id bigint,
  months jsonb
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $$
  with grouped as (
    select
      v.contact_crm_id,
      to_char(v.visit_date, 'YYYY-MM') as month,
      v.agent_hr_id,
      max(v.agent_name) as agent_name,
      v.ampm,
      v.source,
      v.speciality,
      v.visit_type,
      count(*)::integer as visits,
      max(v.visit_date) as last_visited_on
    from public.crm_visits_unified v
    where v.contact_crm_id = any (p_contact_crm_ids)
      and v.contact_crm_id <> 100000
      and v.visit_date >= p_from
    group by v.contact_crm_id, to_char(v.visit_date, 'YYYY-MM'), v.agent_hr_id, v.ampm, v.source, v.speciality, v.visit_type
  )
  select
    g.contact_crm_id,
    jsonb_agg(
      jsonb_build_object(
        'month', g.month,
        'agent_hr_id', g.agent_hr_id,
        'agent_name', g.agent_name,
        'ampm', g.ampm,
        'source', g.source,
        'speciality', g.speciality,
        'visit_type', g.visit_type,
        'visits', g.visits,
        'last_visited_on', g.last_visited_on
      )
      order by g.month, g.agent_hr_id
    )
  from grouped g
  group by g.contact_crm_id
  order by g.contact_crm_id;
$$;

comment on function public.phx_crm_contact_visit_months(bigint[], date) is
  'Customer 360: per contact, its visits since p_from from the visits door (crm_visits_unified, both sources, '
  'resigned reps included, the 100000 placeholder excluded), grouped by month, rep, AM/PM tag, source, '
  'speciality and visit type, as one jsonb array per contact. Read by readContactVisitMonths '
  '(src/lib/crm/reads.ts). See supabase/migrations/20261018230827_customer_360_validated_relationships.sql.';

revoke execute on function public.phx_crm_contact_visit_months(bigint[], date) from public, anon, authenticated;
grant execute on function public.phx_crm_contact_visit_months(bigint[], date) to service_role;

-- 4. The closing's own customer rows, narrowed to linked pairs --------------------------------------

create or replace function public.phx_closing_customers_for_pairs(
  p_line text,
  p_periods text[],
  p_pairs jsonb
)
returns table (
  period text,
  client_code text,
  client_name text,
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
  with wanted as (
    select distinct
      upper(btrim(x.distributor_code)) as distributor_code,
      btrim(x.client_code) as client_code,
      nullif(btrim(coalesce(x.brick_id, '')), '') as brick_id
    from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as x(distributor_code text, client_code text, brick_id text)
    where coalesce(btrim(x.distributor_code), '') <> ''
      and coalesce(btrim(x.client_code), '') <> ''
  ),
  months as (
    select distinct btrim(m) as period
    from unnest(coalesce(p_periods, array[]::text[])) as m
    where btrim(m) ~ '^[0-9]{4}-[0-9]{2}$'
  )
  select
    m.period,
    c.client_code,
    c.client_name,
    c.distributor_code,
    c.region_code,
    c.area_code,
    c.brick_id,
    c.units,
    c.value
  from months m
  cross join lateral public.phx_closing_customers(p_line, m.period) c
  where exists (
    select 1
    from wanted w
    where w.distributor_code = upper(btrim(c.distributor_code))
      and w.client_code = btrim(c.client_code)
      and (w.brick_id is null or w.brick_id = c.brick_id)
  );
$$;

comment on function public.phx_closing_customers_for_pairs(text, text[], jsonb) is
  'Customer 360: the Monthly Closing''s own customer rows (phx_closing_customers, unchanged) for each month in '
  'p_periods, narrowed to the distributor code pairs in p_pairs ([{distributor_code, client_code, brick_id?}]; '
  'brick_id, when given, must match too — for a distributor whose code is not proof of a shop). Pass the line '
  'as the closing names it (''anti infective'', never ''anti_infective''). See '
  'supabase/migrations/20261018230827_customer_360_validated_relationships.sql.';

revoke execute on function public.phx_closing_customers_for_pairs(text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.phx_closing_customers_for_pairs(text, text[], jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
