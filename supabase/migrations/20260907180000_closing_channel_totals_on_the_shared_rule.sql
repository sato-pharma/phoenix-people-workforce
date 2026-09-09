-- The Monthly Closing's channel totals were the second copy of "who is a warehouse", and the last
-- one still stopping at the six words.
--
-- #3440 put the rule in ONE SQL function (`phx_customer_channel`) and moved Channels by Rep onto it,
-- leaving these closing functions for their own review because their bodies also decide the
-- unidentified and direct buckets — answers that are not channels at all and must keep coming first.
-- This migration moves `phx_closing_channel_totals`; its sibling `phx_closing_channel_breakdown`
-- follows in the migration beside it.
--
-- WHAT WAS WRONG. The grid asked five questions — hospital stems, pharmacy override codes, store
-- override codes, store stems, else pharmacy — while the app asks eight. So the owner's «م - »
-- prefix rulings, his company and chain rulings, the never-store words, El Qema's wholesale-only
-- book and the trade phrase all stopped here. Same customers, two answers, on a workbook and a
-- screen he reads side by side.
--
-- THE THREE BUCKETS ABOVE THE CHANNEL ARE UNCHANGED and still come first: a direct row with no
-- customer name, a row with no client code, a row with no name. None of them is a channel question,
-- and routing them through the classifier would answer "pharmacy" for money nobody has identified.
--
-- WHY THE OLD ARRAY PARAMETERS SURVIVE. A migration lands before the deploy that calls it. With an
-- empty payload the function rebuilds the pre-2026-09-07 rule from the arrays and answers exactly as
-- it does today, rather than reclassifying a published closing for the length of a build.
--
-- WHAT MOVES WHEN THE PAYLOAD ARRIVES. Only periods at or after each line's cutover — Pedia from
-- 2026-08, every other line from 2026-09. August Anti Infective is published and locked and is
-- judged by the old rule, here as everywhere else.

drop function if exists public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[]);

create function public.phx_closing_channel_totals(
  p_line text,
  p_periods text[],
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_pharmacy_override_codes text[] default '{}'::text[],
  p_store_override_codes text[] default '{}'::text[],
  p_rule jsonb default '{}'::jsonb
)
returns table(period text, channel text, customers bigint, units numeric, value numeric)
language plpgsql
stable
parallel safe
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_include_all boolean;
  v_rule jsonb;
begin
  if coalesce(cardinality(p_exclude_codes), 0) = 0 then
    v_include_all := true;
  elsif (
    select coalesce(array_agg(distinct upper(btrim(x)) order by upper(btrim(x))), '{}'::text[])
    from unnest(p_exclude_codes) as x
  ) = array['LA003', 'LA004', 'SS001']::text[] then
    v_include_all := false;
  else
    raise exception
      'phx_closing_channel_totals: p_exclude_codes must be empty or exactly {LA003,LA004,SS001}; got %', p_exclude_codes
      using errcode = '22023';
  end if;

  -- No payload means the caller has not deployed yet. Rebuild what it used to send, so this
  -- function's answer does not change until the code that knows the whole rule is live.
  v_rule := case
              when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
                'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
                'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
                'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
                'storeOverrideKeys', to_jsonb(coalesce(p_store_override_codes, '{}'::text[]))
              )
              else p_rule
            end;

  return query
  with
  base as (
    select
      r.period,
      r.client_key,
      r.distributor_code,
      r.client_name,
      r.folded_name,
      r.no_client_code,
      r.is_direct,
      case when v_include_all then r.units_all else r.units_all - r.units_restricted end as units,
      case when v_include_all then r.value_all else r.value_all - r.value_restricted end as value,
      case when v_include_all then r.rows_all  else r.rows_all  - r.rows_restricted  end as rows_kept
    from public.source_of_sales_channel_customer_rollup r
    where r.line_key = lower(btrim(p_line))
      and r.period = any (p_periods)
  ),
  folded as (
    select b.* from base b where b.rows_kept > 0
  ),
  tagged as (
    select
      u.period,
      u.client_key,
      u.units,
      u.value,
      case
        -- Not channel questions. These three answer "we do not know who this is", and they must stay
        -- above the classifier: it would call every one of them a pharmacy.
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        -- And the channel itself, from the one place that holds the rule.
        else public.phx_customer_channel(
               u.client_name, u.client_key, u.distributor_code, u.period, p_line, v_rule)
      end as channel
    from folded u
  ),
  channels as (
    select
      t.period,
      t.channel,
      count(distinct t.client_key) as customers,
      sum(t.units)                 as units,
      sum(t.value)                 as value
    from tagged t
    group by t.period, t.channel
  ),
  population as (
    select b.period, sum(b.units) as units, sum(b.value) as value
    from base b
    group by b.period
  )
  select c.period, c.channel, c.customers, c.units, c.value from channels c
  union all
  select p.period, '__population__'::text, 0::bigint, p.units, p.value from population p;
end;
$function$;

comment on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[], jsonb) is
  'Monthly Closing channel totals per period. Classification is delegated to phx_customer_channel so this grid cannot drift from customer-channel.ts; the unidentified and direct buckets are decided here, above it.';

revoke execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[], jsonb)
  to service_role;
