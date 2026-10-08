-- phoenix_crm_merge_duplicate_customer
--
-- WHAT THIS CHANGES:
--   One new function, public.phoenix_crm_merge_duplicate_customer(p jsonb), executable by
--   service_role alone. No table, no column, no policy, no grant to anyone else, and NOT ONE ROW is
--   written by this migration. Creating the function merges nothing: it does work only when the
--   one-off script scripts/phoenix-crm-merge-same-seat-duplicates.ts calls it with --apply, which
--   needs the owner's go and a pre-image first.
--
-- WHY:
--   The owner's ruling of 2026-10-08: "auto-merge the proven duplicates, with a pre-image and a
--   report". Measured that day: 172 groups, 347 rows, 175 that would leave the lists, 37 seats — one
--   rep's own list holding the same person twice (the duplicates board's own set: same seat, same
--   list type, same folded name, no speciality conflict). The DECISION of which row stays is made in
--   Node by the script, through the board's own fold, because a SQL copy of that fold would act on a
--   set the board never showed. This function is the WRITE: eight child tables and a status change
--   must land together or not at all, and a client timeout that still commits server-side is a known
--   trap here, so it is one transaction per group.
--
--   🔴 THE LOSER IS ARCHIVED, NEVER DELETED. status 'dropped', dropped_reason 'duplicate'. A deleted
--   reference-backed row would be re-minted by phoenix_crm_ensure_reference_customers within minutes
--   (it is idempotent on seat + iReports360 contact + is_test, and the row would no longer exist), so
--   the merge would quietly undo itself; phoenix_crm_customer_moves is ON DELETE RESTRICT; production
--   has no PITR; and the duplicates board already leaves 'dropped' out, so the group clears.
--
--   It re-checks every guard the script relies on, so a stale plan can never write: same seat, same
--   is_test, same list type, neither already archived, the keeper holding an active place whenever a
--   loser does and validated whenever a loser is, the five-active-place cap, and no collision on any
--   of the four unique keys a repoint touches. A loser with a move on record is refused rather than
--   rewriting that history. Grade, phone and the other fields are NEVER copied from the loser: copying
--   a grade writes one nobody set. The script reports them instead.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_merge_duplicate_customer(jsonb);
--     -- DATA COST: none. The function holds no data. Undoing a merge it already performed is a
--     -- restore from the pre-image schema the script requires before --apply.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration only creates a function.

begin;
set local lock_timeout = '5s';

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
    'requests_withdrawn', v_withdrawn
  );
end;
$$;

comment on function public.phoenix_crm_merge_duplicate_customer(jsonb) is
  'Merges one rep''s same-person duplicate rows into the keeper row the caller chose: repoints places, visits, reviews, plan items, unplanned visits, visit asks and list requests, withdraws anything pending on the loser, archives the loser as dropped/duplicate (never deleted), and writes customer_merged_out/in events. Refuses on any guard. Called only by scripts/phoenix-crm-merge-same-seat-duplicates.ts.';

revoke execute on function public.phoenix_crm_merge_duplicate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_merge_duplicate_customer(jsonb) to service_role;

commit;
