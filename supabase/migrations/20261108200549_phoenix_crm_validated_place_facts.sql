-- phoenix_crm_validated_place_facts
--
-- WHAT THIS CHANGES: adds one read-only function, public.phoenix_crm_validated_place_facts(uuid[], uuid[]),
--   that answers in ONE call the four lookups `loadValidatedPlaces` (src/lib/phoenix-crm/server/validation-reviews.ts)
--   made by id chunks: each customer's name, list and speciality; every validation review of those customers;
--   how many visits each place has; and how many active places each customer has. Nothing is written.
-- WHY: owner, 2026-11-08: "enhance more the performance of this page, hilarious slow". Place checks reads
--   ~5,400 active places, and the four lookups went 150 ids at a time — 179 HTTP requests (61 for the visit
--   count alone) and about 16 s measured from the laptop, the biggest single share of the page. The ids now
--   travel in the request BODY (an RPC is a POST), so there is no URL or header ceiling to chunk around, and
--   the answer is one jsonb value, so PostgREST's row cap never cuts it.
-- ROLLBACK: drop function if exists public.phoenix_crm_validated_place_facts(uuid[], uuid[]);
--   (the app falls back to nothing — revert the code that calls it first).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phoenix_crm_validated_place_facts(p_place_ids uuid[], p_customer_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
  select jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'list_type', c.list_type, 'speciality', c.speciality))
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

commit;
