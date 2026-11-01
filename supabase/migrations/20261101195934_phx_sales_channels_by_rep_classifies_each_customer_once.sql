-- phx_sales_channels_by_rep_classifies_each_customer_once
--
-- WHAT THIS CHANGES: two functions, for speed only. No filter, select list, signature, grant or
-- returned row is touched.
-- * public.phx_sales_channels_by_rep adds up rows that are the same customer, period, line and area
--   first, then classifies each such group once, in a MATERIALIZED step.
-- * public.phx_customer_channel takes its squashed name from the fold it already did.
--
-- WHY. The tab asks for the whole history and the app gives up at 15 s. The cost was measured, not
-- assumed: `tagged` is named once, so Postgres inlined it and copied the classifier into all six
-- FILTERs. Staging, one month with the confidential three excluded: 23,423 rows, 140,538 calls, 32.9 s
-- of 34.1 s, and half of each call folding the same name twice.
-- * MATERIALIZED alone: that month 4.7 s, the whole history 27.9 s.
-- * Adding up equal rows first: 94,690 classifications for 168,642 rows, 25.6 s. It wins over
--   MATERIALIZED alone because it does not need parallel workers to be free.
-- * Folding once on top of that: 14.5 s in the probe.
-- Old against new, milliseconds:
--   staging, whole history, three excluded      222,397 -> 15,981
--   staging, one month, three excluded           30,761 ->  2,370
--   staging, one month, nothing excluded         58,728 ->  3,797
--   production, 2026-07, three excluded          45,293 ->  3,317
--   production, 2026-09, three excluded          72,451 ->  8,561
--   production, 2026-09, nothing excluded       124,759 -> 11,336
--   production, whole history, three excluded  not run -> 32,299
-- A month past the cutover costs more because the classifier walks its longer branch.
-- 🔴 THE WHOLE HISTORY IS STILL OVER 15 s, so the app gives this read a 50 s budget. And the whole
-- history with nothing excluded was never run, old or new, on either database: staging restarted
-- uncleanly 7 min 45 s into that call on 2026-11-01. Its time and its effect on the server are unknown.
-- The function's own `set statement_timeout to '60s'` stays, and it stops nothing: the timer is armed
-- when the outer statement starts, so a 1 s limit set this way let a 4 s sleep finish on staging.
--
-- WHY THE ANSWER IS UNCHANGED. Grouping cannot change a total: numeric addition is exact, and rows are only
-- merged when equal on every column the classifier and the seat join read, so each count of distinct
-- customers sees the same pairs. phx_squash_customer_name is exactly replace(phx_fold_customer_name(x),
-- ' ', ''). Old against new as text through EXCEPT ALL in both directions, with the new classifier in
-- a private copy, before either was applied:
-- * Staging, 19 calls, 0 differences: all 8 months with the three excluded, all 8 with an empty list,
--   a NULL list, no rule payload, and the whole history with the three excluded (112 rows,
--   70984571.286685, the figure the previous run recorded).
-- * Production, 4 calls, 0 differences: 2026-07, 2026-08 and 2026-09 with the three excluded, and
--   2026-09 with an empty list. Staging holds 27 rows past the cutover, so those months are the real
--   test of that branch.
-- * The classifier alone on staging's 70,115 distinct customers with the rule forced in force: 0
--   differences across 454 hospitals, 755 stores and 68,906 pharmacies, and 0 on 10 awkward names.
-- Staging and production held the same classifier before this, by md5 with comments and whitespace
-- removed (d820515b113121837a87a54107ed7c3f). Neither function writes, so no published month moves.
--
-- ROLLBACK: re-run the two definitions the file 20261101190920_phx_period_price_joins_never_nest_blind.sql
-- (Channels by Rep) and 20260907170000_one_channel_rule_in_sql.sql (the classifier) hold; the classifier
-- must keep `set search_path to 'public', 'pg_temp'`, which 20260929215727 gave it by ALTER.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_customer_channel(
  p_client_name text,
  p_client_code text,
  p_distributor_code text,
  p_period text,
  p_official_line text,
  p_rule jsonb
)
returns text
language plpgsql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_spaced   text := public.phx_fold_customer_name(p_client_name);
  -- phx_squash_customer_name is this very expression around a second fold of the same name.
  v_squashed text := replace(v_spaced, ' ', '');
  v_code     text := ltrim(btrim(coalesce(p_client_code, '')), '0');
  v_dist     text := upper(btrim(coalesce(p_distributor_code, '')));
  v_line     text := regexp_replace(lower(btrim(coalesce(p_official_line, ''))), '[\s_-]+', ' ', 'g');
  v_from     text;
  v_active   boolean;
begin
  -- Hospital wins the name overlap: a name like "جمعيه ... (ص مستشفى)" carries both, and it is the
  -- hospital that identifies the customer.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'hospitalStems', '[]'::jsonb)) s
    where s <> '' and v_spaced like '%' || s || '%'
  ) then
    return 'hospital';
  end if;

  -- Owner PHARMACY rulings by code outrank every store test. Keyed by customer code alone: the same
  -- shop is a pharmacy whichever distributor sold to it.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'pharmacyOverrideCodes', '[]'::jsonb)) c
    where v_code = ltrim(btrim(c), '0')
  ) then
    return 'pharmacy';
  end if;

  -- Owner STORE rulings, keyed by distributor + code because a code is unique only inside one
  -- distributor's catalogue.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeOverrideKeys', '[]'::jsonb)) k
    where v_dist = upper(btrim(split_part(k, '|', 1)))
      and v_code = ltrim(btrim(split_part(k, '|', 2)), '0')
  ) then
    return 'store';
  end if;

  -- Is the 2026-09-06 rule in force for this row's period AND line? The lines were published on
  -- different days and a published month never moves, so the cutover is per line. No payload, or a
  -- period before the cutover, falls to the rule exactly as it stood before: the six words plus the
  -- two code-keyed lists, both already answered above.
  v_from := coalesce(
    p_rule -> 'ruleFromPeriodByLine' ->> v_line,
    p_rule ->> 'ruleFromPeriodDefault'
  );
  v_active := v_from is not null
          and coalesce(p_period, '') ~ '^\d{4}-\d{2}$'
          and p_period >= v_from;

  if v_active then
    -- A ruling about one COMPANY, by name — it trades under several codes across distributors.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeOverrideNameStems', '[]'::jsonb)) s
      where s <> '' and (v_spaced like '%' || s || '%' or v_squashed like '%' || replace(s, ' ', '') || '%')
    ) then
      return 'store';
    end if;

    -- A ruling about one company or a whole CHAIN that it is a pharmacy. Over-matching here is safe
    -- and is why a name is usable: this list can only ever refuse a store, never create one.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'pharmacyOverrideNameStems', '[]'::jsonb)) s
      where s <> '' and (v_spaced like '%' || s || '%' or v_squashed like '%' || replace(s, ' ', '') || '%')
    ) then
      return 'pharmacy';
    end if;

    -- "Never a store": a pharmacy, a hospital, a paperwork note typed into the name field, or a
    -- government depot, which supplies its own institutions rather than a city's pharmacies.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'neverStoreStems', '[]'::jsonb)) s
      where s <> '' and (v_spaced like '%' || s || '%' or v_squashed like '%' || replace(s, ' ', '') || '%')
    ) then
      return 'pharmacy';
    end if;

    -- A distributor whose entire customer base is wholesalers. The name test exists to guess at a
    -- customer nobody has classified; here there is nothing to guess.
    if v_dist <> '' and exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'wholesaleOnlyDistributors', '[]'::jsonb)) d
      where v_dist = upper(btrim(d))
    ) then
      return 'store';
    end if;

    -- The six words, the start-anchored prefixes, and the trade phrase.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeStems', '[]'::jsonb)) s
      where s <> '' and v_spaced like '%' || s || '%'
    ) then
      return 'store';
    end if;

    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storePrefixes', '[]'::jsonb)) s
      where s <> '' and v_spaced like s || '%'
    ) then
      return 'store';
    end if;

    -- The phrase: the name has to say its BUSINESS is trading or distributing, and then either name
    -- the goods or carry both halves of تجارة + توزيع. تجارة on its own is right 47% of the time.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'tradeBusinessStems', '[]'::jsonb)) s
      where s <> '' and v_squashed like '%' || s || '%'
    ) and (
      (
        jsonb_array_length(coalesce(p_rule -> 'tradeBusinessPair', '[]'::jsonb)) > 0
        and not exists (
          select 1 from jsonb_array_elements_text(p_rule -> 'tradeBusinessPair') s
          where s = '' or v_squashed not like '%' || s || '%'
        )
      )
      or exists (
        select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'tradeGoodsStems', '[]'::jsonb)) s
        where s <> '' and v_squashed like '%' || s || '%'
      )
    ) then
      return 'store';
    end if;

    return 'pharmacy';
  end if;

  -- Pre-cutover, or no payload: the six words and nothing else.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeStems', '[]'::jsonb)) s
    where s <> '' and v_spaced like '%' || s || '%'
  ) then
    return 'store';
  end if;

  return 'pharmacy';
end;
$function$;

revoke execute on function public.phx_customer_channel(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_customer_channel(text, text, text, text, text, jsonb) to service_role;

create or replace function public.phx_sales_channels_by_rep(
  p_store_stems text[],
  p_hospital_stems text[],
  p_excluded_product_codes text[],
  p_period text default null::text,
  p_store_override_keys text[] default '{}'::text[],
  p_pharmacy_override_codes text[] default '{}'::text[],
  p_rule jsonb default '{}'::jsonb
)
returns table(seat_id text, rep_hr_id text, rep_name text, line_code text, area_code text, area_name text, hospital_value numeric, store_value numeric, pharmacy_value numeric, total_value numeric, hospital_customers bigint, store_customers bigint, pharmacy_customers bigint)
language sql
stable security definer
set search_path to 'public', 'au'
set statement_timeout to '60s'
as $function$
  with rule as (
    select case
             when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
               'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
               'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
               'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
               'storeOverrideKeys', to_jsonb(coalesce(p_store_override_keys, '{}'::text[]))
             )
             else p_rule
           end as payload
  ),
  period_price as (
    select d.product_code || '|' || d.invoice_period as pair,
           public.phx_factory_price(d.product_code, d.invoice_period) as period_price
    from (
      select distinct r.product_code, r.invoice_period
      from public.source_of_sales_import_rows r
      where (p_period is null or r.invoice_period = p_period)
    ) d
  ),
  rows_in_scope as (
    -- The closing's value: a distributor row is its paid units x factory price, and a direct order
    -- keeps its own order value. The sheet's typed value is never read for a distributor row.
    select r.client_code,
           r.distributor_code,
           r.area_code,
           r.official_line,
           r.invoice_period,
           r.client_name,
           case
             when coalesce(r.is_direct, false) then coalesce(r.value, 0)
             else coalesce(r.qty, 0) * coalesce(pp.period_price, 0)
           end as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp
      on pp.pair = r.product_code || '|' || r.invoice_period
    where (p_period is null or r.invoice_period = p_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (array(
            select upper(btrim(code))
            from unnest(coalesce(p_excluded_product_codes, '{}')) code))
  ),
  grouped as (
    -- The classifier can only tell rows apart by these columns, and the seat join below only by
    -- area_code and official_line, so rows equal on all six are one row to everything after this.
    select t.client_name,
           t.client_code,
           t.distributor_code,
           t.invoice_period,
           t.official_line,
           t.area_code,
           sum(t.value) as value
    from rows_in_scope t
    group by t.client_name, t.client_code, t.distributor_code,
             t.invoice_period, t.official_line, t.area_code
  ),
  tagged as materialized (
    -- MATERIALIZED, or the planner copies this call into all six FILTERs below (see the header).
    select t.client_code,
           t.distributor_code,
           t.area_code,
           t.official_line,
           t.value,
           public.phx_customer_channel(
             t.client_name, t.client_code, t.distributor_code,
             t.invoice_period, t.official_line, rule.payload
           ) as channel
    from grouped t
    cross join rule
  ),
  seated as (
    select t.channel,
           t.value,
           t.client_code,
           t.distributor_code,
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
    coalesce(sum(rp.value) filter (where rp.channel = 'hospital'), 0)            as hospital_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'store'), 0)               as store_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'pharmacy'), 0)            as pharmacy_value,
    coalesce(sum(rp.value), 0)                                                   as total_value,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'hospital')                                     as hospital_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'store')                                        as store_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'pharmacy')                                     as pharmacy_customers
  from repped rp
  left join public.employees e on e.hr_id = rp.occupant_hr_id
  left join au.canonical_areas ca on ca.area_code = rp.seat_area_code
  group by 1, 2, 3, 4, 5, 6
  order by 10 desc;
$function$;

revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) from public, anon, authenticated;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) to service_role;

commit;
