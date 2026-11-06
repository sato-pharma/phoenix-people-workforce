-- phoenix_crm_admin_edit_reroutes_offplan_past_reviewer
--
-- WHAT THIS CHANGES:
--   1. A new function, phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(visit_id): an off-plan visit still
--      waiting at its manager's step (`manager_pending`, or `admin_pending` bound for it) whose reviewing manager is
--      now ON the visit moves to the SFE step — exactly the routing a visit gets when it is saved that way.
--   2. phoenix_crm_admin_edit_visit (the Super Admin's correction of who was on a visit) calls it after it rewrites
--      who went. The body is otherwise the live definition, unchanged.
--   3. The rows already stuck that way move to the SFE step (production, 6 Nov 2026: one — Samah Ashraf's off-plan
--      visit to Dr. Ashraf Zaghloul on 31 Oct, corrected from a single to a double visit with her district manager).
-- WHY:
--   A manager who was on an off-plan visit does not approve it — the SFE does (owner, 2026-10-12). The save routes
--   such a visit to the SFE, and the 2026-10-23 trigger holds the rule at INSERT. But the Super Admin's correction
--   adds a manager AFTER the approval row exists, and nothing re-routed it: on 31 Oct 2026 18:29 Cairo a correction
--   added the district manager five minutes after the visit was raised, so the visit sat at her step, her Approve
--   was refused ("You were on this visit, so SFE decides it rather than you") and the SFE could not reach it.
--   Removing a manager from a visit is NOT reversed here: a visit already with the SFE stays there, where it can
--   still be decided.
-- ROLLBACK:
--   Re-apply the phoenix_crm_admin_edit_visit body from 20261027185332_phoenix_crm_visit_any_companions.sql, then
--   drop function if exists public.phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(uuid);
--   The repaired row is not reversed by that: it would be put back by hand to 'manager_pending'
--   (visit id 6b3a7749-0bd2-4ad2-a153-7413d399ebb5).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(p_visit_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_on text[];
begin
  if p_visit_id is null then
    return;
  end if;
  -- The same lock the decision and the Administrator's review take, so a correction cannot cross a decision.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:unplanned:' || p_visit_id::text));
  -- Everyone on the visit: the fixed places and phoenix_crm_visit_companions, upper-cased and trimmed.
  v_on := public.phoenix_crm_visit_companion_ids(p_visit_id);

  update public.phoenix_crm_unplanned_visits u
  set status = case when u.status = 'manager_pending' then 'sfe_pending' else u.status end,
      after_admin_status = case when u.status = 'admin_pending' then 'sfe_pending' else u.after_admin_status end,
      version = u.version + 1,
      updated_at = now()
  where u.visit_id = p_visit_id
    and u.manager_hr_id is not null
    and upper(btrim(u.manager_hr_id)) = any (v_on)
    and (
      u.status = 'manager_pending'
      or (u.status = 'admin_pending' and u.after_admin_status = 'manager_pending')
    );
end;
$function$;

revoke execute on function public.phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(uuid) from public, anon, authenticated;
grant execute on function public.phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(uuid) to service_role;

create or replace function public.phoenix_crm_admin_edit_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  -- Who was on the visit changes ONLY when the caller says so; otherwise the three slots below are
  -- ignored, so a typo in a comment can never re-check (or move) anybody.
  v_change_who boolean := coalesce((p ->> 'change_who')::boolean, false);
  v_kind text := coalesce(p ->> 'kind', '');
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  v_product_manager text := upper(nullif(trim(coalesce(p ->> 'product_manager_hr_id', '')), ''));
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_products text[];
  v_visit public.phoenix_crm_visits%rowtype;
  v_new_kind text;
  v_new_manager text;
  v_new_senior text;
  v_new_product_manager text;
  v_linked_before jsonb;
  -- Everyone on the visit, the fixed places and phoenix_crm_visit_companions together, sorted.
  v_before_set text[];
  v_after_set text[];
begin
  if v_id is null or v_seat is null or v_actor is null
    or v_comment is null or char_length(v_comment) > 1000 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The same per-territory lock the rep's own save takes, so a correction and a save cannot interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select v.* into v_visit
  from public.phoenix_crm_visits v
  where v.id = v_id
    and v.seat_id = v_seat
    and v.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_not_found';
  end if;

  v_before_set := public.phoenix_crm_visit_companion_ids(v_id);
  v_after_set := v_before_set;
  v_new_kind := v_visit.kind;
  v_new_manager := v_visit.manager_hr_id;
  v_new_senior := v_visit.senior_hr_id;
  v_new_product_manager := v_visit.product_manager_hr_id;

  if v_change_who then
    -- Only a visit the rep entered himself, or the Super Admin entered for him. A manager's own visit
    -- keeps its people: re-picking them would turn his record into one that reads as entered by
    -- somebody who was not on it.
    if v_visit.rep_hr_id is null
      or not (v_visit.entered_by_hr_id = v_visit.rep_hr_id or v_visit.capture_source = 'admin') then
      raise exception 'phoenix_crm:visit_people_fixed';
    end if;

    -- The shape `phoenix_crm_visits_participants` holds, for a visit that has a rep on it, refused here
    -- as a sentence rather than as a constraint violation.
    if not (
      (v_kind = 'single' and v_manager is null and v_senior is null and v_product_manager is null)
      or (v_kind = 'double' and v_manager is not null and v_senior is null and v_product_manager is null)
      or (v_kind = 'chain' and v_manager is not null and (v_senior is not null or v_product_manager is not null))
      or (v_kind = 'product_manager' and v_manager is null and v_senior is null and v_product_manager is not null)
    ) or v_manager = v_visit.rep_hr_id
      or v_senior = v_visit.rep_hr_id
      or v_senior = v_manager
      or v_product_manager = v_visit.rep_hr_id then
      raise exception 'phoenix_crm:bad_participants';
    end if;

    v_new_kind := v_kind;
    v_new_manager := v_manager;
    v_new_senior := v_senior;
    v_new_product_manager := v_product_manager;
    select coalesce(array_agg(distinct s.hr_id order by s.hr_id), '{}'::text[])
    into v_after_set
    from (
      select upper(btrim(h)) as hr_id
      from unnest(array[v_manager, v_senior, v_product_manager]) as h
      where nullif(btrim(coalesce(h, '')), '') is not null
      union
      select upper(btrim(e ->> 'hr_id'))
      from jsonb_array_elements(case when jsonb_typeof(p -> 'companions') = 'array' then p -> 'companions' else '[]'::jsonb end) as e
      where jsonb_typeof(e) = 'object'
        and nullif(btrim(coalesce(e ->> 'hr_id', '')), '') is not null
        and upper(btrim(e ->> 'hr_id')) <> upper(btrim(v_visit.rep_hr_id))
    ) s;
  end if;

  -- Nothing different: no copy, no write, and the caller is told so.
  if v_new_kind is not distinct from v_visit.kind
    and v_new_manager is not distinct from v_visit.manager_hr_id
    and v_new_senior is not distinct from v_visit.senior_hr_id
    and v_new_product_manager is not distinct from v_visit.product_manager_hr_id
    and v_after_set is not distinct from v_before_set
    and v_products is not distinct from v_visit.products
    and v_comment is not distinct from v_visit.comment then
    return jsonb_build_object('visit_id', v_id, 'changed', false);
  end if;

  -- The pharmacy visits this one filed carry the same products it does, so they follow it.
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'products', to_jsonb(l.products)) order by l.id), '[]'::jsonb)
  into v_linked_before
  from public.phoenix_crm_visits l
  where l.linked_from_visit_id = v_id;

  -- The copy first, so nothing is overwritten that is not already kept.
  insert into public.phoenix_crm_visit_edits (
    visit_id, seat_id, customer_id, visit_date, edited_by_hr_id, is_test, before_edit, after_edit
  )
  values (
    v_visit.id, v_visit.seat_id, v_visit.customer_id, v_visit.visit_date, v_actor, v_visit.is_test,
    jsonb_build_object(
      'kind', v_visit.kind,
      'manager_hr_id', v_visit.manager_hr_id,
      'senior_hr_id', v_visit.senior_hr_id,
      'product_manager_hr_id', v_visit.product_manager_hr_id,
      'companion_hr_ids', to_jsonb(v_before_set),
      'products', to_jsonb(v_visit.products),
      'comment', v_visit.comment,
      'linked_pharmacy_visits', v_linked_before
    ),
    jsonb_build_object(
      'kind', v_new_kind,
      'manager_hr_id', v_new_manager,
      'senior_hr_id', v_new_senior,
      'product_manager_hr_id', v_new_product_manager,
      'companion_hr_ids', to_jsonb(v_after_set),
      'products', to_jsonb(v_products),
      'comment', v_comment
    )
  );

  update public.phoenix_crm_visits
  set kind = v_new_kind,
      manager_hr_id = v_new_manager,
      senior_hr_id = v_new_senior,
      product_manager_hr_id = v_new_product_manager,
      products = v_products,
      comment = v_comment
  where id = v_id;

  if v_change_who then
    perform public.phoenix_crm_set_visit_companions(v_id, p -> 'companions');
    -- A manager added here may be the one this visit's off-plan approval waits for; his step is then
    -- unavailable and it goes to the SFE, as it would have had the rep recorded him (owner, 2026-10-12).
    perform public.phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(v_id);
  end if;

  update public.phoenix_crm_visits
  set products = v_products
  where linked_from_visit_id = v_id
    and products is distinct from v_products;

  return jsonb_build_object('visit_id', v_id, 'changed', true);
end;
$function$;

revoke execute on function public.phoenix_crm_admin_edit_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_edit_visit(jsonb) to service_role;

-- The rows already stuck. Repeatable: a second run finds none.
select public.phoenix_crm_unplanned_route_past_a_reviewer_on_the_visit(u.visit_id)
from public.phoenix_crm_unplanned_visits u
where u.manager_hr_id is not null
  and (u.status = 'manager_pending' or (u.status = 'admin_pending' and u.after_admin_status = 'manager_pending'))
  and upper(btrim(u.manager_hr_id)) = any (public.phoenix_crm_visit_companion_ids(u.visit_id));

commit;
