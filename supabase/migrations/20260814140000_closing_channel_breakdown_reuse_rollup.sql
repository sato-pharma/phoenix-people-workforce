-- Speed up phx_closing_channel_breakdown by reusing the channel rollup shipped in #2115.
--
-- WHAT WAS SLOW (measured on production, CNS 2026-07 = 17,281 fact rows, whole call 1,594 ms):
--   ~800 ms was phx_fold_customer_name() evaluated PER ROW, PER STEM inside the classifier — two
--   EXISTS(unnest(stems)) branches, ~13.6k + 13.5k loops over the retail rows. The fold is
--   IMMUTABLE and the resolved name is already known per (distributor, client_code), so folding it
--   once per customer at rollup-build time and reading it back is exactly equivalent and far cheaper.
--
-- THE FIX — a function-body swap only. No new table, no schema change, no backfill, no new refresh
-- wiring (the rollup is the one #2115 already builds and keeps fresh). Two surgical changes;
-- EVERYTHING else is preserved byte-for-byte:
--
--   1. `names` now reads client_name AND its precomputed fold from
--      source_of_sales_channel_customer_rollup instead of scanning the directory rollup live. That
--      rollup resolves the newest-wins name by the IDENTICAL rule (distinct on
--      (line, period, distributor, client_code) order by latest_row_created_at desc) and stores
--      folded_name = phx_fold_customer_name(that name). Verified on prod: 0 fold mismatches across
--      all 158,232 rollup rows.
--   2. retail carries `folded_name` from that join; direct folds inline (few rows, no client_code so
--      not in the rollup). The classifier's two stem branches match on `u.folded_name` instead of
--      re-folding u.client_name every row — so u.folded_name == phx_fold_customer_name(u.client_name)
--      to the character.
--
-- WHAT IS DELIBERATELY NOT CHANGED — the `population` row. It is an INDEPENDENT re-read of
-- source_of_sales_fact_rollup + source_of_sales_import_rows, kept verbatim. monthly-closing-export.ts
-- checks every grid TOTAL against it ("Source tables (EGP)"), and that check only works because
-- population does NOT reuse the retail/direct CTE path — it is how a missing 4.36M on CNS was caught.
-- Summing `tagged` instead would give the identical number while silently neutering that guard, so
-- the re-read stays. The classifier CASE ordering, the seat/rep attribution, the four grids,
-- area_reps, brick_area, and the emitted array + its jsonb order are all unchanged.
--
-- Proven output-identical (whole-array jsonb equality) on staging (40) + production (58) slice x
-- variant comparisons, both restricted variants, every line and period incl. July's direct overlay,
-- negative-total slices, and the restricted-collapse slices. Rollback: CREATE OR REPLACE the previous
-- body (folding per row, reading the directory rollup live). No data is mutated anywhere.

create or replace function public.phx_closing_channel_breakdown(
  p_line text,
  p_period text,
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_pharmacy_override_codes text[] DEFAULT '{}'::text[],
  p_store_override_codes text[] DEFAULT '{}'::text[]
)
  returns jsonb
  language sql
  stable parallel safe security definer
  set search_path to 'public', 'au'
  set statement_timeout to '60s'
as $function$
  with
  -- The name the distributor actually sent, newest wins — same rule as phx_customer_directory — now
  -- read from the channel rollup (#2115), which already resolved it AND stored its fold. One row per
  -- (distributor, client_code) for this line+period. client_code is not null on retail rows there.
  names as (
    select r.distributor_code, r.client_code, r.client_name, r.folded_name
    from public.source_of_sales_channel_customer_rollup r
    where r.line_key = lower(btrim(p_line))
      and r.period = p_period
      and not r.is_direct
      and r.client_code is not null
  ),
  -- Distributor sell-out, at the closing's own value formula. No `client_code is not null` filter —
  -- see the header: that filter is what made these grids sum to less than the Closing Matrix.
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      -- The key an owner override is matched on. This grid did not need the code before, because
      -- nothing here was ever keyed by customer — the override is the first rule that is.
      f.client_code                                   as client_key,
      f.distributor_code                              as distributor_code,
      coalesce(n.client_name, '')                     as client_name,
      -- Precomputed fold of the same resolved name (== phx_fold_customer_name(client_name)).
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
  -- Direct orders. They carry no client_code, so the fact rollup cannot name them; the import rows
  -- are the only place the customer survives. They carry no area and no brick either — hence the
  -- __DIRECT__ buckets below. Not in the rollup (no client_code), so their fold is computed inline.
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(r.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(r.brick_id, '')), '')     as brick_id,
      -- Direct orders carry no client code at all, so there is nothing for an override to match and
      -- this is null on purpose. It exists only so the union above it keeps one column list.
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
        -- The unattributable answers come first, ahead of the classifier whose fallback is
        -- `pharmacy`. See phx_closing_channel_totals for the money each one was hiding.
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        -- Hospital wins the overlap, matching classifyCustomerChannel(). Fold precomputed.
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'hospital'
        -- The owner's rulings beat the keyword, both directions, on the same keys and in the same
        -- position as phx_closing_channel_totals — the two must agree or the workbook's grids would
        -- disagree with its own channel totals. Direct rows carry a null client_key and never match.
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
  -- Rep attribution: sales area -> canonical area -> the line's active REP seat -> its current
  -- occupant. Every join is a LEFT join on purpose — a sale whose area is not on the seat model, or
  -- whose seat nobody occupies today, must still appear rather than vanishing.
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
  -- One long table of (dimension, key, label) so the four grids share one aggregation.
  keyed as (
    select 'product' as dimension,
           coalesce(nullif(sd.product_code, ''), '__NO_PRODUCT__') as key,
           coalesce(sd.product_name, '')                           as label,
           sd.channel, sd.value
    from seated sd
    union all
    select 'area',
           case when sd.is_direct then '__DIRECT__' else coalesce(sd.area_code, '__NO_AREA__') end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'brick',
           case when sd.is_direct then '__DIRECT__'
                when sd.brick_id is null then '__NO_BRICK__'
                else sd.brick_id end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'rep',
           case when sd.is_direct then '__DIRECT__'
                when sd.occupant_hr_id is not null then sd.occupant_hr_id::text
                when sd.seat_id is not null then '__VACANT__:' || sd.seat_id::text
                else '__NO_SEAT__' end,
           case when sd.is_direct then ''
                when sd.occupant_hr_id is not null then coalesce(e.full_name, '')
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
      -- max() rather than an extra group-by column: a key always carries one label, and a stray
      -- blank must never split a row in two.
      coalesce(max(nullif(k.label, '')), '')                                       as label,
      coalesce(sum(k.value) filter (where k.channel = 'hospital'), 0)              as hospital,
      coalesce(sum(k.value) filter (where k.channel = 'store'), 0)                 as store,
      coalesce(sum(k.value) filter (where k.channel = 'pharmacy'), 0)              as pharmacy,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_code'), 0)  as unidentified_no_code,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_name'), 0)  as unidentified_no_name,
      coalesce(sum(k.value) filter (where k.channel = 'direct_unnamed'), 0)        as direct_unnamed,
      -- The row's FULL total, every channel and every bucket. Deliberately not hospital+store+
      -- pharmacy: the app that reads this before the matching code is deployed shows `total`, and a
      -- complete month is the right thing for it to show.
      coalesce(sum(k.value), 0)                                                    as total
    from keyed k
    group by k.dimension, k.key
  ),
  -- WHICH REP OWNS EACH AREA — every area on the crosswalk, not only the ones that sold this month.
  -- An area can RECEIVE a share of a city's store sales while selling nothing itself, and it still
  -- has to reach a rep. Same four LEFT joins and the same key vocabulary as the rep grid above, so
  -- a key here always names a row there.
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
  -- WHICH AREA EACH BRICK'S STORE MONEY SITS IN. The city split moves a wholesaler's sell-in out of
  -- the area it was booked in; the brick it was booked on is no more the place it was consumed than
  -- the area was, so that money leaves the brick too. This says how much of it each brick holds.
  -- Direct rows are excluded: they carry no brick and no area and never take part in the split.
  -- Only non-zero store money is emitted, so this stays a short list.
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
  -- The same independent re-read as phx_closing_channel_totals, for this one month, so the
  -- breakdown sheet can check itself without trusting its own four grids to agree. KEPT VERBATIM:
  -- monthly-closing-export.ts measures every grid TOTAL against this number, and the check only has
  -- teeth because this re-reads the source tables rather than summing the same rows the grids use.
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
  -- One flat array, exactly as before, so a reader that only knows the four grid dimensions keeps
  -- working: it filters on `dimension` and never sees the rows below.
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
    -- `store` carries the money and `area_key` says where it sits; `total` mirrors `store` so a
    -- reader that only knows the old fields still sees a self-consistent row.
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

-- Preserve the SECURITY DEFINER posture (CREATE OR REPLACE keeps existing grants; re-stated for clarity).
revoke execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) to service_role;
