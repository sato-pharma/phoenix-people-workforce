-- Channels by Rep — Hospital / Store / Pharmacy sales, per medical rep.
--
-- WHY AN RPC AT ALL: the `au` seat model is not PostgREST-exposed, so the app cannot join sales to
-- a rep from the client. Every consumer goes through a service-role-only public wrapper; this is
-- one more of those.
--
-- WHY THE KEYWORDS ARE PARAMETERS AND NOT LITERALS IN HERE:
-- src/lib/sales/customer-channel.ts declares itself THE single edit point for the channel rule —
-- "adding an entry re-classifies all history". A second copy of those words in SQL would quietly
-- break that promise the first time someone edits one list and not the other. So the caller passes
-- the stems in, already folded by normalizeCustomerName(). This function owns the JOIN, never the
-- vocabulary. (This is not hypothetical: a hand-transcribed copy of these six words mis-stated the
-- store channel by 8.7M EGP and 94 customers before it was caught.)
--
-- WHY IT CANNOT USE THE EXISTING ATTRIBUTION ROLLUP: au.f_monthly_attribution aggregates the
-- customer away, and the channel is derived from the customer's NAME. So this reads the import
-- rows, applying the same two guards the rest of the system applies — validated batches only, and
-- confidential products stripped.
--
-- EVERY ROW OF SALES LANDS SOMEWHERE. The joins to the crosswalk, the line map and the seat are
-- LEFT joins on purpose: a sale whose area is not on the seat model, or whose seat has no current
-- occupant, must still appear rather than vanishing. A per-rep table that does not add up to the
-- company total is a table that gets questioned, and the gap is exactly the interesting part.
-- The caller distinguishes the three cases by which key comes back:
--   rep_hr_id present            -> a real rep
--   seat_id present, no rep      -> a seat nobody occupies today
--   neither                      -> area/line not on the seat model at all

-- Fold a customer name to the form the stems are compared against. Mirrors normalizeCustomerName()
-- in src/lib/sales/customer-channel.ts: harakat/tatweel/superscript-alef stripped, interchangeable
-- letters unified, latin lowercased, whitespace collapsed. Kept as its own IMMUTABLE function so
-- the coupling is one readable place rather than smeared through a query, and so a test can assert
-- it agrees with the TypeScript.
create or replace function public.phx_fold_customer_name(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(regexp_replace(
           lower(translate(
             regexp_replace(coalesce(p_name, ''), '[ً-ْـٰ]', '', 'g'),
             'أإآٱةىیک', 'ااااهييك')),
           '\s+', ' ', 'g'));
$$;

comment on function public.phx_fold_customer_name(text) is
  'Folds an Arabic customer name for channel matching. Mirrors normalizeCustomerName() in '
  'src/lib/sales/customer-channel.ts — keep the two in step; tests/sales-channels-by-rep.test.ts pins it.';

create or replace function public.phx_sales_channels_by_rep(
  p_store_stems text[],
  p_hospital_stems text[],
  p_excluded_product_codes text[],
  p_period text default null
)
returns table (
  seat_id text,
  rep_hr_id text,
  rep_name text,
  line_code text,
  area_code text,
  area_name text,
  hospital_value numeric,
  store_value numeric,
  pharmacy_value numeric,
  total_value numeric,
  hospital_customers bigint,
  store_customers bigint,
  pharmacy_customers bigint
)
language sql
stable
security definer
set search_path to 'public', 'au'
set statement_timeout to '60s'
as $$
  with rows_in_scope as (
    select r.client_code,
           r.area_code,
           r.official_line,
           coalesce(r.value, 0) as value,
           public.phx_fold_customer_name(r.client_name) as folded_name
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where (p_period is null or r.invoice_period = p_period)
      -- The confidential-product list is a PARAMETER for the same reason the stems are:
      -- src/lib/sales/access-scope.ts is its single source of truth, and the rule is not a flat
      -- exclusion — the codes are stripped by default for everyone, and ONLY a CEO or Super Admin
      -- who explicitly opts in may reveal them. Hardcoding the three codes here would both
      -- duplicate that list and make the opt-in impossible to honour, which matters more than it
      -- sounds: those three products are 81.5% of all sales value (276.7M of 339.5M EGP), so a
      -- permanently-excluded tab would show the owner under a fifth of his own business.
      -- The caller resolves the list from the access scope; passing '{}' reveals everything.
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(code)) from unnest(coalesce(p_excluded_product_codes, '{}')) code)
  ),
  tagged as (
    select client_code,
           area_code,
           official_line,
           value,
           case
             -- Hospital wins the overlap, matching classifyCustomerChannel(): a name carrying both
             -- a hospital word and a store word is the hospital that identifies the customer.
             when exists (select 1 from unnest(p_hospital_stems) s
                          where s <> '' and folded_name like '%' || s || '%') then 'hospital'
             when exists (select 1 from unnest(p_store_stems) s
                          where s <> '' and folded_name like '%' || s || '%') then 'store'
             else 'pharmacy'
           end as channel
    from rows_in_scope
  ),
  seated as (
    select t.channel,
           t.value,
           t.client_code,
           s.seat_id,
           s.line_code,
           s.area_code as seat_area_code
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(t.official_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
  ),
  repped as (
    select sd.*, oh.occupant_hr_id
    from seated sd
    left join au.occupancy_history oh
      on oh.seat_id = sd.seat_id and oh.effective_to is null
  )
  select
    rp.seat_id::text                                                             as seat_id,
    rp.occupant_hr_id::text                                                      as rep_hr_id,
    e.full_name::text                                                            as rep_name,
    rp.line_code::text                                                           as line_code,
    rp.seat_area_code::text                                                      as area_code,
    ca.area_name::text                                                           as area_name,
    coalesce(sum(rp.value) filter (where rp.channel = 'hospital'), 0)             as hospital_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'store'), 0)                as store_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'pharmacy'), 0)             as pharmacy_value,
    coalesce(sum(rp.value), 0)                                                    as total_value,
    count(distinct rp.client_code) filter (where rp.channel = 'hospital')         as hospital_customers,
    count(distinct rp.client_code) filter (where rp.channel = 'store')            as store_customers,
    count(distinct rp.client_code) filter (where rp.channel = 'pharmacy')         as pharmacy_customers
  from repped rp
  left join public.employees e on e.hr_id = rp.occupant_hr_id
  left join au.canonical_areas ca on ca.area_code = rp.seat_area_code
  group by 1, 2, 3, 4, 5, 6
  order by 10 desc;
$$;

comment on function public.phx_sales_channels_by_rep(text[], text[], text[], text) is
  'Hospital/Store/Pharmacy sales per rep seat. Stems come from src/lib/sales/customer-channel.ts — '
  'never hardcode them here. Unseated and unoccupied sales are returned as their own rows so the '
  'result reconciles to the company total.';

-- PUBLIC is the operative grantee: anon and authenticated inherit EXECUTE through it, so revoking
-- only those two is a no-op and the anonymous key could still call a SECURITY DEFINER function.
-- Revoke from PUBLIC first, then grant back to service_role alone.
revoke execute on function public.phx_fold_customer_name(text) from public, anon, authenticated;
revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text) from public, anon, authenticated;
grant execute on function public.phx_fold_customer_name(text) to service_role;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text) to service_role;
