-- Direct orders reach the closing on their REAL area and brick.
--
-- WHY. The Direct Orders module began stamping the customer's area and brick on every row it books:
-- 2026-08 is the first month where all 22 direct rows carry BOTH. `au.f_monthly_attribution` already reads that area and
-- credits the area's rep for the money (verified on production for 2026-08: Giza - Giza Centers is
-- credited 40 Guamusin / 200 Ivyronc / 216 Lacto Advanced 1, Minia 2 is credited 50 / 24 / 24).
-- The closing surfaces were the only place still discarding it, so the Closing Matrix printed
-- "Direct orders (company)" with Giza - Giza Centers reading 0 immediately above it — the closing
-- contradicting the company's own rep attribution.
--
-- WHAT CHANGES. Two read-only reporting functions start returning geography they already had:
--   1. phx_monthly_closing_direct  — adds area_code to the projection and the GROUP BY.
--   2. phx_closing_channel_breakdown — stops overwriting a direct row's real area / brick / rep with
--      the '__DIRECT__' bucket. A direct row with no geography still lands in '__DIRECT__'.
--
-- BOTH ARE FLOORED AT 2026-08, and the floor is the load-bearing part of this migration. A direct
-- row simply HAVING an area_code is not evidence the Direct Orders module wrote it — measured live:
--
--     period      direct rows   with area   with brick
--     2026-01          71           19           0      <- manual, provenance not the module
--     2026-02..06     554            0           0
--     2026-07          51           35           0      <- the OWNER'S OWN finalized mapping
--     2026-08          22           22          22      <- the module, area AND brick
--
-- Reading 2026-07's areas here would break a published, LOCKED closing two ways: July CNS is not in
-- the owner's mapping table (it covers Anti Infective and Pedia only) so it would silently fold onto
-- areas, and shrinking the '__DIRECT__' bucket fails the penny reconciliation in
-- applyJulyDirectAreasToBreakdown, which then refuses the mapping and prints a "they are not the
-- same money" warning across the July sheet. So the rule is a PERIOD FLOOR, never a has-an-area test.
--
-- WHAT DOES NOT CHANGE.
--   * Pricing. Direct money keeps its own value (direct_value / the row's stored value); it is never
--     recomputed at factory price. That is the locked direct-order pricing rule, and it is exactly
--     why direct has its own feed rather than joining the area grid.
--   * Any month before 2026-08. The floor above makes both functions return exactly what they
--     returned before, so every published month — including the locked ones — renders identically.
--   * Totals. Nothing is added or removed anywhere — the same money is reported at a finer grain.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. phx_monthly_closing_direct: carry the area
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP first: the output column set changes, and CREATE OR REPLACE cannot alter a function's return
-- type. Re-granting below is mandatory — a freshly created function gets a default ACL that grants
-- EXECUTE to PUBLIC, which would expose sales rows to anon/authenticated.
drop function if exists public.phx_monthly_closing_direct(text, text);

create function public.phx_monthly_closing_direct(p_line text, p_period text)
returns table(region_code text, area_code text, product_code text, sales_units numeric, sales_value numeric)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  select
    f.region_code,
    -- Same period floor as phx_closing_channel_breakdown, and for the same reason: 2026-01 and
    -- 2026-07 carry manually-placed areas, and July's belong to the owner's own mapping in
    -- july-2026-direct-orders.ts, which covers Anti Infective and Pedia only — July CNS would
    -- otherwise fold onto areas behind a LOCKED closing. Blank means "this month has no area",
    -- which is what every month up to 2026-07 returned before this migration.
    case when p_period >= '2026-08'
         then coalesce(nullif(btrim(f.area_code), ''), '') else '' end as area_code,
    f.product_code,
    sum(f.total_qty)    as sales_units,
    sum(f.direct_value) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.region_code,
           case when p_period >= '2026-08'
                then coalesce(nullif(btrim(f.area_code), ''), '') else '' end,
           f.product_code;
$function$;

revoke all on function public.phx_monthly_closing_direct(text, text) from public;
revoke all on function public.phx_monthly_closing_direct(text, text) from anon, authenticated;
grant execute on function public.phx_monthly_closing_direct(text, text) to service_role;
grant execute on function public.phx_monthly_closing_direct(text, text) to analytics_readonly;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. phx_closing_channel_breakdown: keep a direct row's own area, brick and rep
-- ─────────────────────────────────────────────────────────────────────────────
-- Body is byte-identical to the deployed function except in exactly two places: the period floor on
-- area_code / brick_id in the `direct` CTE, and the three `case` expressions in the `keyed` CTE
-- (area, brick, rep) plus the rep LABEL, which no longer blanks itself for direct rows — a rep whose
-- only sales this month are direct would otherwise appear with no name. The `direct` CTE was already
-- selecting area_code and brick_id; they were simply discarded downstream.
-- Signature is unchanged, so CREATE OR REPLACE keeps the existing ACL.
create or replace function public.phx_closing_channel_breakdown(
  p_line text,
  p_period text,
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_pharmacy_override_codes text[] default '{}'::text[],
  p_store_override_codes text[] default '{}'::text[]
)
returns jsonb
language sql
stable parallel safe security definer
set search_path to 'public', 'au'
set statement_timeout to '60s'
as $function$
  with
  names as (
    select r.distributor_code, r.client_code, r.client_name, r.folded_name
    from public.source_of_sales_channel_customer_rollup r
    where r.line_key = lower(btrim(p_line))
      and r.period = p_period
      and not r.is_direct
      and r.client_code is not null
  ),
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      f.client_code                                   as client_key,
      f.distributor_code                              as distributor_code,
      coalesce(n.client_name, '')                     as client_name,
      coalesce(n.folded_name, '')                     as folded_name,
      (f.client_code is null)                         as no_client_code,
      false                                           as is_direct,
      f.effective_units * coalesce(p.factory_price, 0) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      -- THE PERIOD FLOOR. Having an area_code is not enough to trust one: 2026-01 (19 of 71 rows)
      -- and 2026-07 (35 of 51) carry areas of MANUAL provenance and no bricks. July's placement is
      -- the owner's own finalized mapping, applied in the app by applyJulyDirectAreasToBreakdown,
      -- which refuses to run unless the '__DIRECT__' bucket reconciles to the penny — emitting real
      -- areas for July would shrink that bucket, fail the check, and paper the published July sheet
      -- with a "they are not the same money" warning. Nulling here rather than in `keyed` also keeps
      -- the au.sos_area_crosswalk join in `seated` from firing, so older months are untouched
      -- end to end. Mirrors DIRECT_AREA_STAMPED_FROM_PERIOD in src/lib/sales/closing-direct-area.ts.
      case when p_period >= '2026-08'
           then nullif(btrim(coalesce(r.area_code, '')), '') end as area_code,
      case when p_period >= '2026-08'
           then nullif(btrim(coalesce(r.brick_id, '')), '') end  as brick_id,
      null::text                                      as client_key,
      null::text                                      as distributor_code,
      btrim(coalesce(r.client_name, ''))              as client_name,
      public.phx_fold_customer_name(btrim(coalesce(r.client_name, ''))) as folded_name,
      false                                           as no_client_code,
      true                                            as is_direct,
      r.value                                         as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = p_period
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  tagged as (
    select
      u.*,
      case
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'hospital'
        when exists (
          select 1 from unnest(coalesce(p_pharmacy_override_codes, '{}'::text[])) c
          where c <> ''
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(c), '0')
        ) then 'pharmacy'
        when exists (
          select 1 from unnest(coalesce(p_store_override_codes, '{}'::text[])) c
          where c <> ''
            and upper(btrim(u.distributor_code)) = upper(btrim(split_part(c, '|', 1)))
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(split_part(c, '|', 2)), '0')
        ) then 'store'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from (select * from retail union all select * from direct) u
  ),
  seated as (
    select
      t.*,
      s.seat_id,
      ca.area_name as seat_area_name,
      oh.occupant_hr_id
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(p_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
    left join au.occupancy_history oh
      on oh.seat_id = s.seat_id and oh.effective_to is null
    left join au.canonical_areas ca
      on ca.area_code = s.area_code
  ),
  keyed as (
    select 'product' as dimension,
           coalesce(nullif(sd.product_code, ''), '__NO_PRODUCT__') as key,
           coalesce(sd.product_name, '')                           as label,
           sd.channel, sd.value
    from seated sd
    union all
    select 'area',
           case when sd.area_code is not null then sd.area_code
                when sd.is_direct then '__DIRECT__'
                else '__NO_AREA__' end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'brick',
           case when sd.brick_id is not null then sd.brick_id
                when sd.is_direct then '__DIRECT__'
                else '__NO_BRICK__' end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'rep',
           case when sd.occupant_hr_id is not null then sd.occupant_hr_id::text
                when sd.seat_id is not null then '__VACANT__:' || sd.seat_id::text
                when sd.is_direct then '__DIRECT__'
                else '__NO_SEAT__' end,
           case when sd.occupant_hr_id is not null then coalesce(e.full_name, '')
                when sd.seat_id is not null then coalesce(sd.seat_area_name, '')
                else '' end,
           sd.channel, sd.value
    from seated sd
    left join public.employees e on e.hr_id = sd.occupant_hr_id
  ),
  grids as (
    select
      k.dimension,
      k.key,
      coalesce(max(nullif(k.label, '')), '')                                       as label,
      coalesce(sum(k.value) filter (where k.channel = 'hospital'), 0)              as hospital,
      coalesce(sum(k.value) filter (where k.channel = 'store'), 0)                 as store,
      coalesce(sum(k.value) filter (where k.channel = 'pharmacy'), 0)              as pharmacy,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_code'), 0)  as unidentified_no_code,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_name'), 0)  as unidentified_no_name,
      coalesce(sum(k.value) filter (where k.channel = 'direct_unnamed'), 0)        as direct_unnamed,
      coalesce(sum(k.value), 0)                                                    as total
    from keyed k
    group by k.dimension, k.key
  ),
  area_reps as (
    select distinct
      x.sos_area_code as area_code,
      case when oh.occupant_hr_id is not null then oh.occupant_hr_id::text
           when s.seat_id is not null then '__VACANT__:' || s.seat_id::text
           else '__NO_SEAT__' end as rep_key,
      case when oh.occupant_hr_id is not null then coalesce(e.full_name, '')
           when s.seat_id is not null then coalesce(ca.area_name, '')
           else '' end as rep_label
    from au.sos_area_crosswalk x
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(p_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
    left join au.occupancy_history oh
      on oh.seat_id = s.seat_id and oh.effective_to is null
    left join au.canonical_areas ca
      on ca.area_code = s.area_code
    left join public.employees e on e.hr_id = oh.occupant_hr_id
    where x.effective_to is null
      and x.sos_area_code is not null
  ),
  brick_area as (
    select
      case when sd.brick_id is null then '__NO_BRICK__' else sd.brick_id end as brick_key,
      coalesce(sd.area_code, '__NO_AREA__')                                  as area_key,
      sum(sd.value) filter (where sd.channel = 'store')                      as store
    from seated sd
    where not sd.is_direct
    group by 1, 2
    having coalesce(sum(sd.value) filter (where sd.channel = 'store'), 0) <> 0
  ),
  population as (
    select
      (
        select coalesce(sum(f.effective_units * coalesce(p.factory_price, 0)), 0)
        from public.source_of_sales_fact_rollup f
        join public.source_of_sales_import_batches b
          on b.id = f.batch_id and b.status = 'validated'
        left join public.source_of_sales_products p
          on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
        where f.period = p_period
          and lower(btrim(f.official_line)) = lower(btrim(p_line))
          and not coalesce(f.is_direct, false)
          and upper(btrim(coalesce(f.product_code, ''))) <> all (
                select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
      )
      +
      (
        select coalesce(sum(r.value), 0)
        from public.source_of_sales_import_rows r
        join public.source_of_sales_import_batches b
          on b.id = r.batch_id and b.status = 'validated'
        where r.invoice_period = p_period
          and lower(btrim(r.official_line)) = lower(btrim(p_line))
          and coalesce(r.is_direct, false)
          and r.validation_state = 'valid'
          and upper(btrim(coalesce(r.product_code, ''))) <> all (
                select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
      ) as value
  ),
  emitted as (
    select g.dimension, g.key, g.label,
           g.hospital, g.store, g.pharmacy,
           g.unidentified_no_code, g.unidentified_no_name, g.direct_unnamed,
           g.total,
           null::text as rep_key,
           null::text as area_key
    from grids g
    union all
    select 'area_rep', a.area_code, a.rep_label,
           0, 0, 0, 0, 0, 0, 0,
           a.rep_key, null::text
    from area_reps a
    union all
    select 'brick_area', ba.brick_key, '',
           0, ba.store, 0, 0, 0, 0,
           ba.store,
           null::text, ba.area_key
    from brick_area ba
    union all
    select 'population', 'TOTAL', '',
           0, 0, 0, 0, 0, 0, p.value,
           null::text, null::text
    from population p
  )
  select coalesce(jsonb_agg(row_to_json(e) order by e.dimension, e.total desc, e.key), '[]'::jsonb)
  from emitted e;
$function$;

revoke all on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) from public;
revoke all on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) from anon, authenticated;
grant execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) to service_role;
