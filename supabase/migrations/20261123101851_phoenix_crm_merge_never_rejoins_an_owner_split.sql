-- =============================================================================
-- Phoenix CRM — a duplicate merge never joins two people the owner split.
--
-- WHAT: two functions, both `create or replace`, no table, no row.
--   1. public.phoenix_crm_merge_duplicate_customer(jsonb) — its live body (20261017000000, production
--      md5(prosrc) 6ffc0e4b169f5b39ade188aa017f79f9 read 23 Nov 2026) plus ONE new guard: it raises
--      phoenix_crm:owner_split_them when the loser or the keeper carries a customer_restored event with
--      details->>'why' = 'merge_reversed' — the owner's own split of a merge.
--   2. public.phoenix_crm_customer_merge_counts(uuid[]) — its live body (20261016180401) plus a fourth
--      key, "owner_split": { customer_id: true }, so the duplicates board and the merge script read the
--      same fact and show such a pair as refused instead of offering to merge it.
--
-- WHY (owner, 23 Nov 2026): Aya Ibrahim's Anti Infective list holds two different doctors named
--      أحمد محمد الصباغ — one in Kafr El Bagour, one in Sers El Layan. The 8 October merge joined them;
--      the owner split them on 13 October (customer_restored, why = merge_reversed); the 13 November bulk
--      merge joined them AGAIN, because nothing in the merge read his split, and both doctors' visits and
--      comments then showed as one customer. The rows were split again by hand on 23 Nov 2026 (event
--      57163 names every visit, place and plan day moved). Only one owner split exists today: this pair.
--
-- SECURITY DEFINER with search_path public, executable by service_role only, exactly as before.
--
-- ROLLBACK: re-apply both functions from 20261017000000 and 20261016180401.
-- =============================================================================

begin;

create or replace function public.phoenix_crm_merge_duplicate_customer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_keeper_id uuid := nullif(p ->> 'keeper_id', '')::uuid;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_loser_ids uuid[];
  v_keeper public.phoenix_crm_customers%rowtype;
  v_loser public.phoenix_crm_customers%rowtype;
  v_loser_id uuid;
  v_n integer;
  v_places integer := 0;
  v_visits integer := 0;
  v_reviews integer := 0;
  v_plan_items integer := 0;
  v_unplanned integer := 0;
  v_asks integer := 0;
  v_requests integer := 0;
  v_withdrawn integer := 0;
  v_manager_plan integer := 0;
  v_manager_visits integer := 0;
begin
  select coalesce(array_agg(distinct x::uuid), '{}')
  into v_loser_ids
  from jsonb_array_elements_text(coalesce(p -> 'loser_ids', '[]'::jsonb)) as x;

  if v_actor is null or v_keeper_id is null or cardinality(v_loser_ids) = 0 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_keeper_id = any (v_loser_ids) then
    raise exception 'phoenix_crm:keeper_is_loser';
  end if;
  if v_note is null or char_length(v_note) < 10 or char_length(v_note) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;

  select c.* into v_keeper from public.phoenix_crm_customers c where c.id = v_keeper_id for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_keeper.status = 'dropped' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;

  -- The seat's own lock, the key phoenix_crm_move_customer takes, so a merge and a move on one list
  -- can never interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_keeper.seat_id));

  foreach v_loser_id in array v_loser_ids loop
    select c.* into v_loser from public.phoenix_crm_customers c where c.id = v_loser_id for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_loser.status = 'dropped' then
      raise exception 'phoenix_crm:customer_dropped';
    end if;
    if v_loser.seat_id <> v_keeper.seat_id or v_loser.is_test <> v_keeper.is_test then
      raise exception 'phoenix_crm:not_same_list';
    end if;
    if v_loser.list_type <> v_keeper.list_type then
      raise exception 'phoenix_crm:list_type_differs';
    end if;
    if v_loser.validated_at is not null and v_keeper.validated_at is null then
      raise exception 'phoenix_crm:keeper_not_validated';
    end if;
    if exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_loser.id and pl.status = 'active')
       and not exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_keeper.id and pl.status = 'active') then
      raise exception 'phoenix_crm:keeper_holds_no_place';
    end if;
    if exists (select 1 from public.phoenix_crm_customer_moves m where m.customer_id = v_loser.id) then
      raise exception 'phoenix_crm:loser_has_moves';
    end if;
    -- Two different people the owner split after a merge are never merged again (23 Nov 2026: the
    -- 13 November bulk run joined the two أحمد محمد الصباغ — Kafr El Bagour and Sers El Layan — a month
    -- after he had split them). His split is the customer_restored event with why = merge_reversed.
    if exists (
      select 1 from public.phoenix_crm_list_events r
      where r.customer_id in (v_loser.id, v_keeper.id)
        and r.event_type = 'customer_restored'
        and r.details ->> 'why' = 'merge_reversed'
    ) then
      raise exception 'phoenix_crm:owner_split_them';
    end if;

    -- The four unique keys a repoint could collide on. Each measured 0 on 2026-10-08; each still
    -- refuses, so a collision can never be resolved silently by whichever row the update hit first.
    if exists (
      select 1 from public.phoenix_crm_visits a
      join public.phoenix_crm_visits b
        on b.seat_id = a.seat_id and b.visit_date = a.visit_date and b.is_test = a.is_test
      where a.customer_id = v_loser.id and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:visit_same_day';
    end if;
    if exists (
      select 1 from public.phoenix_crm_plan_items a
      join public.phoenix_crm_plan_items b on b.plan_id = a.plan_id and b.plan_date = a.plan_date
      where a.customer_id = v_loser.id and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:plan_same_day';
    end if;
    if exists (
      select 1 from public.phoenix_crm_visit_asks a
      join public.phoenix_crm_visit_asks b
        on b.seat_id = a.seat_id and b.kind = a.kind and b.is_test = a.is_test and b.status = 'waiting'
      where a.customer_id = v_loser.id and a.status = 'waiting' and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:ask_waiting_twice';
    end if;
    -- The district manager's own visit (owner, 2026-10-16): one per customer per day, like a rep's.
    if exists (
      select 1 from public.phoenix_crm_manager_visits a
      join public.phoenix_crm_manager_visits b
        on b.manager_hr_id = a.manager_hr_id and b.visit_date = a.visit_date and b.is_test = a.is_test
      where a.customer_id = v_loser.id and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:manager_visit_same_day';
    end if;

    -- Anything still waiting on the loser is withdrawn first — something waiting on a row that has
    -- left the list is a decision nobody can take — which also clears the one-pending unique key.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          stage = null,
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Merged into the same customer entered once on this list'
      where q.customer_id = v_loser.id
        and q.status = 'pending'
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_loser.seat_id, v_loser.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'merged'), v_loser.is_test
    from withdrawn w;
    get diagnostics v_n = row_count;
    v_withdrawn := v_withdrawn + v_n;

    update public.phoenix_crm_places set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_places := v_places + v_n;
    update public.phoenix_crm_visits set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_visits := v_visits + v_n;
    update public.phoenix_crm_validation_reviews set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_reviews := v_reviews + v_n;
    update public.phoenix_crm_plan_items set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_plan_items := v_plan_items + v_n;
    update public.phoenix_crm_unplanned_visits set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_unplanned := v_unplanned + v_n;
    update public.phoenix_crm_visit_asks set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_asks := v_asks + v_n;
    update public.phoenix_crm_list_requests set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_requests := v_requests + v_n;
    -- The district manager's half-day already holding the keeper keeps that one row: it is one person.
    delete from public.phoenix_crm_manager_plan_customers a
    where a.customer_id = v_loser.id
      and exists (
        select 1 from public.phoenix_crm_manager_plan_customers b
        where b.slot_id = a.slot_id and b.customer_id = v_keeper.id
      );
    update public.phoenix_crm_manager_plan_customers set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_manager_plan := v_manager_plan + v_n;
    update public.phoenix_crm_manager_visits set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_manager_visits := v_manager_visits + v_n;

    update public.phoenix_crm_customers c
    set status = 'dropped',
        dropped_reason = 'duplicate',
        dropped_note = v_note,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_loser.id;

    -- Two events on the one list's trail, the shape phoenix_crm_move_customer writes: the row that
    -- left reads where it went, and the row that stayed reads what joined it.
    insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
    values
      (v_loser.seat_id, v_loser.id, 'customer_merged_out', v_actor,
       jsonb_build_object('into_customer_id', v_keeper.id, 'note', v_note), v_loser.is_test),
      (v_keeper.seat_id, v_keeper.id, 'customer_merged_in', v_actor,
       jsonb_build_object('from_customer_id', v_loser.id, 'note', v_note), v_keeper.is_test);
  end loop;

  -- The five-active-place cap, after the repoint, so it reads exactly what the keeper now holds.
  select count(*) into v_n from public.phoenix_crm_places pl where pl.customer_id = v_keeper.id and pl.status = 'active';
  if v_n > 5 then
    raise exception 'phoenix_crm:too_many_places';
  end if;

  return jsonb_build_object(
    'keeper_id', v_keeper.id,
    'merged', cardinality(v_loser_ids),
    'places', v_places,
    'visits', v_visits,
    'validation_reviews', v_reviews,
    'plan_items', v_plan_items,
    'unplanned_visits', v_unplanned,
    'visit_asks', v_asks,
    'list_requests', v_requests,
    'requests_withdrawn', v_withdrawn,
    'manager_plan_customers', v_manager_plan,
    'manager_visits', v_manager_visits
  );
end;
$$;
revoke execute on function public.phoenix_crm_merge_duplicate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_merge_duplicate_customer(jsonb) to service_role;

create or replace function public.phoenix_crm_customer_merge_counts(p_customer_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'active_places', coalesce((
      select jsonb_object_agg(counted.customer_id, counted.n)
      from (
        select p.customer_id, count(*)::integer as n
        from public.phoenix_crm_places p
        where p.customer_id = any (p_customer_ids)
          and p.status = 'active'
        group by p.customer_id
      ) counted
    ), '{}'::jsonb),
    'visits', coalesce((
      select jsonb_object_agg(counted.customer_id, counted.n)
      from (
        select v.customer_id, count(*)::integer as n
        from public.phoenix_crm_visits v
        where v.customer_id = any (p_customer_ids)
        group by v.customer_id
      ) counted
    ), '{}'::jsonb),
    'moves', coalesce((
      select jsonb_object_agg(counted.customer_id, counted.n)
      from (
        select m.customer_id, count(*)::integer as n
        from public.phoenix_crm_customer_moves m
        where m.customer_id = any (p_customer_ids)
        group by m.customer_id
      ) counted
    ), '{}'::jsonb),
    'owner_split', coalesce((
      select jsonb_object_agg(split.customer_id, true)
      from (
        select distinct r.customer_id
        from public.phoenix_crm_list_events r
        where r.customer_id = any (p_customer_ids)
          and r.event_type = 'customer_restored'
          and r.details ->> 'why' = 'merge_reversed'
      ) split
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.phoenix_crm_customer_merge_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_merge_counts(uuid[]) to service_role;

commit;
