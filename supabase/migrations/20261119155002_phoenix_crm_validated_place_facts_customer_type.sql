-- phoenix_crm_validated_place_facts_customer_type
--
-- WHAT THIS CHANGES: public.phoenix_crm_validated_place_facts(uuid[], uuid[]) also returns each customer's
--   customer_type beside the speciality. The body is 20261108200549's, unchanged but for that one key
--   (production and staging both ran exactly that body on 2026-11-19: md5(prosrc) af84176be56912352e1e6519b51ba4aa).
-- WHY: migration 20261119151229 (owner, 2026-11-19: "hospital is not a speciality") moved Hospital, Contract,
--   Pharmacy and the other places out of speciality into customer_type, so the Place checks "validated places"
--   list, which prints the speciality from this function, went blank for every hospital and contract.
--   loadValidatedPlaces (validation-reviews.ts) now prints customerKindText(customer_type, speciality).
-- ROLLBACK: re-apply 20261108200549_phoenix_crm_validated_place_facts.sql (the extra key is harmless to leave).
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_validated_place_facts(p_place_ids uuid[], p_customer_ids uuid[])
returns jsonb
language sql
stable
security definer
set statement_timeout to '60s'
set search_path to 'public'
as $$
  select jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'list_type', c.list_type, 'speciality', c.speciality, 'customer_type', c.customer_type))
      from public.phoenix_crm_customers c
      where c.id = any(p_customer_ids)
    ), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'place_id', r.place_id, 'status', r.status, 'decided_by_hr_id', r.decided_by_hr_id, 'decided_at', r.decided_at))
      from public.phoenix_crm_validation_reviews r
      where r.customer_id = any(p_customer_ids)
    ), '[]'::jsonb),
    'visit_counts', coalesce((
      select jsonb_object_agg(v.place_id, v.n)
      from (
        select place_id, count(*) as n
        from public.phoenix_crm_visits
        where place_id = any(p_place_ids)
        group by place_id
      ) v
    ), '{}'::jsonb),
    'active_places', coalesce((
      select jsonb_object_agg(p.customer_id, p.n)
      from (
        select customer_id, count(*) as n
        from public.phoenix_crm_places
        where customer_id = any(p_customer_ids) and status = 'active'
        group by customer_id
      ) p
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.phoenix_crm_validated_place_facts(uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validated_place_facts(uuid[], uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;
