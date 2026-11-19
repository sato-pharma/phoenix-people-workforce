-- phoenix_crm_report_credits_every_companion
--
-- WHAT THIS CHANGES: public.phoenix_crm_report_manager_visits gains ONE arm — everyone stored in
--   phoenix_crm_visit_companions for a counted rep visit who is NOT already in one of the visit's three
--   fixed places (manager_hr_id, senior_hr_id, product_manager_hr_id). A product-side person is counted
--   as the visit's product manager ('product_manager'); a manager-side person past the fixed places
--   stands above the visit's manager and is counted where a senior is ('senior'). The three existing
--   arms are byte-for-byte the production body (md5 of prosrc 519e2d7afe359adb03f1ac920ba31d37, read
--   2026-11-19 = 20261031160000's definition). Same signature, same SECURITY DEFINER, same grants.
--   Nothing is written; no row changes.
--
-- WHY: since 2026-10-27 a visit can carry any mix of the managers above the territory and the line's
--   product side (20261027185332_phoenix_crm_visit_any_companions.sql), but this report — the Manager
--   visits board, and every figure that reuses its DONE rule — read only the three fixed places, so the
--   third person on a chain (a National Sales Manager past the District and Regional managers, a second
--   product-side person) went out with the rep and was credited with nothing.
--
-- ROLLBACK: re-run the phoenix_crm_report_manager_visits definition in
--   20261031160000_phoenix_crm_countable_visits_skip_imported_history.sql (lines 251-311), with its
--   revoke/grant lines. Nothing to restore: this migration writes no data.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phoenix_crm_report_manager_visits(p_hr_ids text[], p_from date, p_to date, p_include_test boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with people as (
    select distinct upper(trim(x.hr_id)) as hr_id
    from unnest(p_hr_ids) as x (hr_id)
    where nullif(trim(x.hr_id), '') is not null
  ),
  joined as (
    select pe.hr_id, 'manager'::text as role_on_visit, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits_with_history v on v.manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and v.kind in ('double', 'chain')
      and (p_include_test or not v.is_test)
    union all
    select pe.hr_id, 'senior'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits_with_history v on v.senior_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    union all
    -- The product manager, in his own column. Both kinds he can be on: 'product_manager' (the rep
    -- ticked one person under "Double visit" and it was him) and 'chain' (he was the second person on
    -- a chain). No `kind` filter is needed — product_manager_hr_id is set on those two kinds alone,
    -- and the constraint phoenix_crm_visits_participants is what guarantees it.
    select pe.hr_id, 'product_manager'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits_with_history v on v.product_manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    union all
    -- Everyone else who went (2026-11-19). phoenix_crm_visit_companions holds the fixed places too, so a
    -- person already in one of them is skipped — the arms above count him once, in his own place. Past
    -- the fixed places a product-side person is a product manager on the visit, and a manager-side person
    -- stands above the visit's manager, which is where a senior is counted. Someone past the fixed places
    -- is only ever on a chain or a product_manager visit (phoenix_crm_set_visit_companions refuses any
    -- other list), so no `kind` filter either; the double-visit figure (kind = 'double') cannot inflate.
    select pe.hr_id,
      (case when vc.side = 'product' then 'product_manager' else 'senior' end)::text,
      v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_visit_companions vc on vc.hr_id = pe.hr_id and vc.visit_id is not null
    join public.phoenix_crm_countable_visits_with_history v on v.id = vc.visit_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
      and vc.hr_id is distinct from upper(btrim(v.manager_hr_id))
      and vc.hr_id is distinct from upper(btrim(v.senior_hr_id))
      and vc.hr_id is distinct from upper(btrim(v.product_manager_hr_id))
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.hr_id, t.visit_date, t.seat_id), '[]'::jsonb)
  from (
    select
      j.hr_id,
      j.role_on_visit,
      j.visit_date,
      j.seat_id,
      j.rep_hr_id,
      (count(*) filter (where j.kind = 'double'))::integer as double_visits,
      (count(*) filter (where j.kind = 'chain'))::integer as chain_visits,
      -- Never added into double_visits: that figure is kind = 'double' on every board and district
      -- managers are judged on it.
      (count(*) filter (where j.kind = 'product_manager'))::integer as product_manager_visits,
      (count(*) filter (where j.list_type = 'AM'))::integer as am_visits,
      (count(*) filter (where j.list_type = 'PM'))::integer as pm_visits
    from joined j
    group by j.hr_id, j.role_on_visit, j.visit_date, j.seat_id, j.rep_hr_id
  ) t;
$$;

revoke execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) to service_role;

commit;
