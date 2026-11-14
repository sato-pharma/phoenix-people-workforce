-- WHAT: the nightly re-check of marketing pharmacy codes (enterprise audit REC-077, F-MKT-011; 14 Nov 2026).
--   1. public.phx_preview_marketing_pharmacy_code_matches(uuid[]) — READ-ONLY: for the given code rows,
--      what the sales customer master would match NOW, with the same matching as
--      phx_resolve_marketing_pharmacy_codes (exact code, then the code without leading zeros, inside the
--      vendor's Sales distributor family). It writes nothing; a null or empty id list returns nothing.
--   2. marketing_pharmacy_distributor_codes.master_recheck_kept_at / master_recheck_kept_by_hr_id — a
--      person's "keep as decided" on a code the master has since learned, so it leaves the list.
-- WHY: phx_resolve_marketing_pharmacy_codes ran once, at capture, so a code entered before the sales
--   master knew its pharmacy read "unresolved" for good. The owner chose (14 Nov 2026) "pin untouched,
--   list rest": nightly, a code nobody has decided on is matched exactly as it would have been at
--   capture; a code a person approved or wrote a note on is never changed, and is listed in Marketing
--   Control for a person to confirm one at a time. The preview is what lets the nightly run and the list
--   see a match WITHOUT writing one: a code the master knows may belong to a different shop
--   (1536256, «صيدلية زمزم»), so a person's code is only ever shown, never resolved, until they confirm.
-- ROLLBACK: drop function if exists public.phx_preview_marketing_pharmacy_code_matches(uuid[]);
--           alter table public.marketing_pharmacy_distributor_codes
--             drop column if exists master_recheck_kept_at,
--             drop column if exists master_recheck_kept_by_hr_id;
--           (the two columns hold only "keep as decided" marks; dropping them puts those codes back on the list)

alter table public.marketing_pharmacy_distributor_codes
  add column if not exists master_recheck_kept_at timestamptz,
  add column if not exists master_recheck_kept_by_hr_id text;

comment on column public.marketing_pharmacy_distributor_codes.master_recheck_kept_at is
  'When a person chose to keep this code as decided after the sales master learned it (REC-077). Set, the code leaves the Marketing Control re-check list.';
comment on column public.marketing_pharmacy_distributor_codes.master_recheck_kept_by_hr_id is
  'Who kept this code as decided after the sales master learned it (REC-077).';

create or replace function public.phx_preview_marketing_pharmacy_code_matches(p_code_ids uuid[])
returns table (
  code_id uuid,
  match_kind text,
  distributor_code text,
  customer_code text,
  customer_name text,
  area_code text
)
language sql
stable
security invoker
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  with fam as (
    select md.id as distributor_id,
           array_agg(distinct ru.sos_distributor_code) as sos_codes
    from public.marketing_distributors md
    join public.marketing_roi_distributor_rollup ru
      on ru.marketing_normalized_name = md.normalized_name
    group by md.id
  ),
  target as (
    select mpdc.id, mpdc.normalized_pharmacy_code, fam.sos_codes
    from public.marketing_pharmacy_distributor_codes mpdc
    left join fam on fam.distributor_id = mpdc.distributor_id
    where coalesce(cardinality(p_code_ids), 0) > 0
      and mpdc.id = any(p_code_ids)
  ),
  exact_c as (
    select t.id, cm.distributor_code, cm.customer_code, cm.customer_name, cm.brick_id, cm.area_code
    from target t
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = any(t.sos_codes)
     and coalesce(cm.active, true)
     and lower(btrim(cm.customer_code)) = t.normalized_pharmacy_code
  ),
  digit_c as (
    select t.id, cm.distributor_code, cm.customer_code, cm.customer_name, cm.brick_id, cm.area_code
    from target t
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = any(t.sos_codes)
     and coalesce(cm.active, true)
     and t.normalized_pharmacy_code ~ '^[0-9]+$'
     and btrim(cm.customer_code) ~ '^[0-9]+$'
     and ltrim(btrim(cm.customer_code), '0') = ltrim(t.normalized_pharmacy_code, '0')
    where not exists (select 1 from exact_c e where e.id = t.id)
  ),
  cand as (
    select 'exact'::text as kind, * from exact_c
    union all
    select 'digit_normalized'::text as kind, * from digit_c
  ),
  agg as (
    select c.id, min(c.kind) as kind, count(distinct c.brick_id) as bricks
    from cand c
    group by c.id
  ),
  pick as (
    select distinct on (c.id) c.id, c.distributor_code, c.customer_code, c.customer_name, c.area_code
    from cand c
    order by c.id, c.distributor_code, c.customer_code, c.brick_id
  )
  -- The same verdict the resolver would write: one brick pins the shop, more than one is ambiguous.
  select a.id,
         case when a.bricks = 1 then a.kind else 'ambiguous' end,
         case when a.bricks = 1 then p.distributor_code end,
         case when a.bricks = 1 then p.customer_code end,
         case when a.bricks = 1 then p.customer_name end,
         case when a.bricks = 1 then p.area_code end
  from agg a
  join pick p on p.id = a.id;
$function$;

revoke execute on function public.phx_preview_marketing_pharmacy_code_matches(uuid[]) from public, anon, authenticated;
grant execute on function public.phx_preview_marketing_pharmacy_code_matches(uuid[]) to service_role;
