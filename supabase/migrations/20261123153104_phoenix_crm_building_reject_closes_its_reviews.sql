-- phoenix_crm_building_reject_closes_its_reviews
--
-- WHAT THIS CHANGES: replaces two functions. No table, column, constraint, index or data changes.
--   1. public.phoenix_crm_decide_shared_place(jsonb) — the body 20261118220000 wrote (md5 2c29e6b3… on production,
--      read from pg_proc on 23 Nov 2026) with ONE addition in the REJECT branch: for each seat it retires, a
--      validation review still 'pending' on that place is closed as 'rejected' in the same transaction, carrying
--      the building's own decider, moment, note and refusal reason, with a 'validation_review_rejected' list event
--      (why = shared_place_rejected). The result gains 'reviews_closed'. No notice is added: the rep is told once,
--      by the building's rejection, through the 'reopened' list the service already reads.
--   2. public.phoenix_crm_restore_shared_place(jsonb) — the body 20261114062049 wrote (md5 1f197da1… on production)
--      with ONE addition: for each place it brings back, the review that building's rejection closed (rejected at
--      exactly the building's retired_at, by its decider, with no stored system advice) is put back to 'pending',
--      BEFORE the holds are read, so taking the rejection back behaves exactly as it did while those reviews
--      stayed pending. The result gains 'reviews_reopened'.
-- WHY: Place checks, the pass to 9.5 (owner, 23 Nov 2026: every item under 9.5 fixed). A rejected building retired
--   its seats and left their reviews 'pending' on retired places — nothing to decide, yet on the page and counted
--   in "N have waited over 72 hours". On production on 23 Nov: two real reviews stranded this way (19 Nov and
--   22 Nov rejections). Those two rows are closed separately, by an announced data change with a pre-image in
--   phoenix_crm_backup_20261123, stamped the same way so a take-back reopens them too.
-- ROLLBACK: re-run the phoenix_crm_decide_shared_place block of
--   20261118220000_phoenix_crm_building_reject_respects_super_admin_seats.sql and the
--   phoenix_crm_restore_shared_place block of 20261114062049_phoenix_crm_validation_left_items.sql. Reviews this
--   version closed stay 'rejected' after a rollback; reopen them from their stamps if ever needed.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: two function bodies are replaced, no row is written.

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_decide_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'shared_place_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_reason text := nullif(trim(coalesce(p ->> 'refusal_reason', '')), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_seated record;
  v_reopened jsonb := '[]'::jsonb;
  v_places integer := 0;
  v_validated jsonb := '[]'::jsonb;
  v_keeps_decision boolean := false;
  -- 2026-11-23: the review a rejection closes, and how many it closed.
  v_review_id uuid;
  v_reviews_closed integer := 0;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id;
  if not found then
    raise exception 'phoenix_crm:shared_place_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_venue.seat_id));
  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id for update;
  if v_venue.status = 'retired' then
    raise exception 'phoenix_crm:shared_place_retired';
  end if;

  -- 🔴 A BUILDING THE SUPER ADMIN APPROVED IS REJECTED BY THE SUPER ADMIN ALONE (owner, 2026-11-16, the same
  -- ruling as phoenix_crm_decide_validation_review).
  if v_decision = 'reject' and v_venue.status = 'active'
    and public.phoenix_crm_is_super_admin(v_venue.decided_by_hr_id)
    and not public.phoenix_crm_is_super_admin(v_actor) then
    raise exception 'phoenix_crm:approved_by_super_admin';
  end if;

  -- 🔴 ...AND NOT THROUGH THE BUILDING EITHER: rejecting it retires every seat in it, so it is refused for anyone but a
  -- Super Admin while a validated customer seated in it stands on his approval (a review he approved, or a place he
  -- created). Pending seats count for nothing yet, so a held building is still the SFE's to reject.
  if v_decision = 'reject' and not public.phoenix_crm_is_super_admin(v_actor) and exists (
    select 1
    from public.phoenix_crm_places pl
    join public.phoenix_crm_customers c on c.id = pl.customer_id
    where pl.shared_place_id = v_id and pl.status = 'active' and c.status = 'active'
      and (
        public.phoenix_crm_is_super_admin(pl.created_by_hr_id)
        or exists (
          select 1 from public.phoenix_crm_validation_reviews r
          where r.place_id = pl.id and r.status = 'approved' and public.phoenix_crm_is_super_admin(r.decided_by_hr_id)
        )
      )
  ) then
    raise exception 'phoenix_crm:approved_by_super_admin';
  end if;

  if v_decision = 'approve' then
    -- 🔴 KEEP IT / A BULK APPROVE OF A BUILDING A SUPER ADMIN ALREADY APPROVED LEAVES HIS NAME ON IT: the reject
    -- lock above reads decided_by_hr_id, so re-stamping it with the SFE Manager would dissolve the lock.
    -- His name, his time and his note stay together: a Keep it by anyone else changes none of the three.
    v_keeps_decision := coalesce(
      v_venue.status = 'active'
        and public.phoenix_crm_is_super_admin(v_venue.decided_by_hr_id)
        and not public.phoenix_crm_is_super_admin(v_actor),
      false
    );
    update public.phoenix_crm_shared_places
    set status = 'active',
        decided_at = case when v_keeps_decision then v_venue.decided_at else now() end,
        decided_by_hr_id = case when v_keeps_decision then v_venue.decided_by_hr_id else v_actor end,
        decision_note = case when v_keeps_decision then v_venue.decision_note else v_note end,
        refusal_reason = null, updated_at = now()
    where id = v_id;

    -- 🔴 APPROVING THE BUILDING CONFIRMS THE DOCTORS WAITING IN IT (owner, 2026-10-14: a visit to a doctor in
    -- a building the system was still checking counts in no KPI "until the admin confirm the polyclinic and
    -- the doctors in it"). A seating in a held venue left each customer pending
    -- (phoenix_crm_validate_customer); this is the one place that releases them. It is NOT a blanket
    -- validation: a building with no timetable on file, a timetable read as another name or as no
    -- schedule, and a customer whose own location is waiting on a validation review all STAY pending — the
    -- same three holds phoenix_crm_settle_venue_timetable keeps. `unjudged` and an unread board never hold
    -- (owner, 2026-10-08), so they are confirmed here.
    for v_seated in
      select pl.id as place_id, pl.customer_id, pl.schedule_check, pl.is_test, c.name as customer_name
      from public.phoenix_crm_places pl
      join public.phoenix_crm_customers c on c.id = pl.customer_id
      where pl.shared_place_id = v_id and pl.status = 'active' and c.status = 'pending'
      order by pl.created_at
    loop
      -- 2026-11-14 (left items), two changes to the three holds above and nothing else:
      --   * a review still waiting holds him only while the place it is about is ACTIVE. A place retired with
      --     its building leaves its review pending, and that review is nobody's to decide.
      --   * the first two holds (no timetable on file; a timetable read as another name or as no schedule) do
      --     not hold a seat A PERSON ALREADY APPROVED. Those are the very customers a review is held for, and
      --     phoenix_crm_decide_validation_review now leaves them waiting for this building: without this they
      --     would stay pending with nothing left to decide.
      if exists (
          select 1 from public.phoenix_crm_validation_reviews r
          where r.customer_id = v_seated.customer_id and r.status = 'pending'
            and exists (select 1 from public.phoenix_crm_places pl where pl.id = r.place_id and pl.status = 'active')
        )
        or (
          (v_venue.schedule_photo_path is null or (v_seated.schedule_check ->> 'verdict') in ('other_name', 'no_schedule'))
          and not exists (
            select 1 from public.phoenix_crm_validation_reviews r
            where r.place_id = v_seated.place_id and r.status = 'approved'
          )
        ) then
        continue;
      end if;

      update public.phoenix_crm_customers c
      -- 2026-11-14 (left items): validated, so nothing waits to be captured again.
      set status = 'active', validated_at = now(), validated_by_hr_id = v_actor, reopened_at = null,
          status_changed_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';
      if found then
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'customer_validated', v_actor,
          jsonb_build_object('why', 'shared_place_approved', 'shared_place_id', v_id, 'shared_place_name', v_venue.name),
          v_seated.is_test
        );
        v_validated := v_validated || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id, 'customer_name', v_seated.customer_name, 'place_id', v_seated.place_id
        ));
      end if;
    end loop;
  else
    update public.phoenix_crm_shared_places
    set status = 'retired', decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note,
        refusal_reason = v_reason, retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
    where id = v_id;

    -- Every customer seated in a rejected venue goes back to To validate, exactly as a rejected place
    -- of his own would send him — place retired, customer pending when he has no other active place,
    -- `reopened_at` stamped so he is first in the rep's To validate order.
    for v_seated in
      select pl.id as place_id, pl.customer_id, pl.label, pl.lat, pl.lon, pl.is_test, pl.created_by_hr_id, c.name as customer_name
      from public.phoenix_crm_places pl
      join public.phoenix_crm_customers c on c.id = pl.customer_id
      where pl.shared_place_id = v_id and pl.status = 'active'
      order by pl.created_at
      -- NO `for update` row lock on the cursor, by choice: each row is locked by the `update` that
      -- retires it two lines below, the whole function runs in one transaction behind an advisory
      -- `lock_timeout`, and a venue is decided by one administrator at a time. (It also keeps the
      -- migration-hygiene sweep honest — it reads `for update of pl, c` and `for update\nloop` as
      -- writes to tables called `of` and `loop`.)
    loop
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_seated.place_id;
      v_places := v_places + 1;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'place_retired', v_actor,
        jsonb_build_object(
          'reason', coalesce(v_note, 'This place could not be confirmed.'),
          'label', v_seated.label, 'lat', v_seated.lat, 'lon', v_seated.lon,
          'why', 'shared_place_rejected', 'shared_place_id', v_id
        ),
        v_seated.is_test
      );

      -- 🔴 2026-11-23 (Place checks, the pass to 9.5): A REVIEW STILL WAITING ON A PLACE THIS REJECTION RETIRES IS
      -- CLOSED WITH IT, in this transaction, as the building's own decision — the same decider, the same moment
      -- (now() is the building's retired_at, which phoenix_crm_restore_shared_place reads to reopen it), the same
      -- note and refusal reason. Until now it stayed 'pending' on a retired place: on Place checks with nothing
      -- left to decide, and counted in "N have waited over 72 hours" (19 Nov and 22 Nov 2026, two real reviews).
      -- Only a review of a place retired HERE is touched — the cursor is this building's active seats — and the
      -- rep is told nothing more: the building's rejection already told him, through `reopened` below.
      v_review_id := null;
      update public.phoenix_crm_validation_reviews r
      set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note,
          refusal_reason = v_reason
      where r.place_id = v_seated.place_id and r.status = 'pending'
      returning r.id into v_review_id;
      if v_review_id is not null then
        v_reviews_closed := v_reviews_closed + 1;
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'validation_review_rejected', v_actor,
          jsonb_build_object(
            'review_id', v_review_id, 'note', v_note, 'refusal_reason', v_reason,
            'why', 'shared_place_rejected', 'shared_place_id', v_id
          ),
          v_seated.is_test
        );
      end if;

      if not exists (
        select 1 from public.phoenix_crm_places pl where pl.customer_id = v_seated.customer_id and pl.status = 'active'
      ) then
        update public.phoenix_crm_customers c
        set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
        where c.id = v_seated.customer_id and c.status = 'active';
        insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, 'customer_pending', v_actor,
          jsonb_build_object('why', 'shared_place_rejected', 'shared_place_id', v_id), v_seated.is_test
        );
      end if;

      -- 🔴 Read from the TABLE, deliberately, so it sees the reopen above — and it fires for a
      -- customer who was already pending, which the branch above never does.
      update public.phoenix_crm_customers c
      set reopened_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';

      -- Who the service tells, and about whom. The rep is the one who captured the TIMETABLE, never
      -- the person deciding: it is his photo.
      if exists (select 1 from public.phoenix_crm_customers c where c.id = v_seated.customer_id and c.status = 'pending') then
        v_reopened := v_reopened || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id,
          'customer_name', v_seated.customer_name,
          'rep_hr_id', v_seated.created_by_hr_id,
          'is_test', v_seated.is_test
        ));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'shared_place_id', v_id,
    'status', case when v_decision = 'approve' then 'active' else 'retired' end,
    'seat_id', v_venue.seat_id,
    'is_test', v_venue.is_test,
    'name', v_venue.name,
    'places_retired', v_places,
    'reviews_closed', v_reviews_closed,
    'validated', v_validated,
    'reopened', v_reopened,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_shared_place(jsonb) to service_role;

create or replace function public.phoenix_crm_restore_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'shared_place_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  -- Optional, as every admin note on this page is since 2026-10-15 ("admin comment is optional").
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_retired_at timestamptz;
  v_seated record;
  v_places integer := 0;
  v_validated jsonb := '[]'::jsonb;
  v_still_waiting jsonb := '[]'::jsonb;
  -- 2026-11-23: the reviews the rejection closed, waiting again.
  v_reviews_reopened integer := 0;
begin
  if v_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id;
  if not found then
    raise exception 'phoenix_crm:shared_place_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_venue.seat_id));
  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id for update;

  -- Only a REJECTED venue can be taken back, and only while it is still in the state the rejection
  -- left it in — the same pair of tests `phoenix_crm_restore_validation` makes about a place.
  if v_venue.status <> 'retired' or v_venue.retired_at is null then
    raise exception 'phoenix_crm:shared_place_not_retired';
  end if;
  v_retired_at := v_venue.retired_at;

  update public.phoenix_crm_shared_places
  set status = 'active',
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      refusal_reason = null,
      retired_at = null,
      retired_by_hr_id = null,
      updated_at = now()
  where id = v_id;

  insert into public.phoenix_crm_list_events (seat_id, event_type, actor_hr_id, details, is_test)
  values (
    v_venue.seat_id, 'shared_place_restored', v_actor,
    jsonb_build_object(
      'shared_place_id', v_id, 'shared_place_name', v_venue.name, 'note', v_note,
      'rejected_by_hr_id', v_venue.retired_by_hr_id, 'rejected_at', v_retired_at,
      'rejection_note', v_venue.decision_note, 'refusal_reason', v_venue.refusal_reason
    ),
    v_venue.is_test
  );

  -- Exactly the places that rejection retired — see the header on why this is `retired_at`.
  for v_seated in
    select pl.id as place_id, pl.customer_id, pl.label, pl.schedule_check, pl.is_test,
           c.name as customer_name, c.status as customer_status
    from public.phoenix_crm_places pl
    join public.phoenix_crm_customers c on c.id = pl.customer_id
    where pl.shared_place_id = v_id
      and pl.status = 'retired'
      and pl.retired_at = v_retired_at
    order by pl.created_at
  loop
    update public.phoenix_crm_places pl
    set status = 'active', retired_at = null, retired_by_hr_id = null, updated_at = now()
    where pl.id = v_seated.place_id;
    v_places := v_places + 1;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'place_restored', v_actor,
      jsonb_build_object(
        'reason', v_note, 'label', v_seated.label, 'why', 'shared_place_restored',
        'shared_place_id', v_id, 'rejected_at', v_retired_at
      ),
      v_seated.is_test
    );

    -- 🔴 2026-11-23: THE REVIEW THE BUILDING'S REJECTION CLOSED WAITS AGAIN. phoenix_crm_decide_shared_place now
    -- closes a review still waiting on each seat it retires, stamped with the building's own retired_at and
    -- decider; taking the rejection back puts exactly those back to 'pending' — never a review rejected on its
    -- own, which carries its own moment — so the hold below still sees it and the customer is not validated
    -- on a photo nobody decided. The page shows it again, waiting from when it was first sent.
    update public.phoenix_crm_validation_reviews r
    set status = 'pending', decided_by_hr_id = null, decided_at = null, decision_note = null, refusal_reason = null
    where r.place_id = v_seated.place_id
      and r.status = 'rejected'
      and r.decided_at = v_retired_at
      and r.decided_by_hr_id is not distinct from v_venue.retired_by_hr_id
      and r.system_advice_at_decision is null;
    if found then
      v_reviews_reopened := v_reviews_reopened + 1;
    end if;

    -- 🔴 THE SAME THREE HOLDS APPROVING A HELD VENUE KEEPS (owner, 2026-10-14): a building with no
    -- timetable on file, a timetable read as another name or as no schedule, and a customer whose own
    -- location is waiting on a validation review all STAY pending. That rule is lifted verbatim from
    -- the approve branch, never widened — bringing the building back must not confirm a doctor the
    -- building itself cannot answer for.
    if v_seated.customer_status = 'pending' then
      -- 2026-11-14 (left items): the same two changes as the approve branch of phoenix_crm_decide_shared_place,
      -- which this rule is lifted from — a waiting review holds only while its place is active, and a seat a
      -- person already approved is not held by the timetable.
      if exists (
          select 1 from public.phoenix_crm_validation_reviews r
          where r.customer_id = v_seated.customer_id and r.status = 'pending'
            and exists (select 1 from public.phoenix_crm_places pl where pl.id = r.place_id and pl.status = 'active')
        )
        or (
          (v_venue.schedule_photo_path is null or (v_seated.schedule_check ->> 'verdict') in ('other_name', 'no_schedule'))
          and not exists (
            select 1 from public.phoenix_crm_validation_reviews r
            where r.place_id = v_seated.place_id and r.status = 'approved'
          )
        ) then
        v_still_waiting := v_still_waiting || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id, 'customer_name', v_seated.customer_name
        ));
        continue;
      end if;

      update public.phoenix_crm_customers c
      set status = 'active', validated_at = now(), validated_by_hr_id = v_actor,
          status_changed_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';
      if found then
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'customer_validated', v_actor,
          jsonb_build_object('why', 'shared_place_restored', 'shared_place_id', v_id, 'shared_place_name', v_venue.name),
          v_seated.is_test
        );
        v_validated := v_validated || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id, 'customer_name', v_seated.customer_name, 'place_id', v_seated.place_id
        ));
      end if;
    end if;
  end loop;

  -- 🔴 THE WAIT IS CLEARED FOR WHOEVER IS BACK IN USE, AND KEPT FOR WHOEVER IS NOT. `reopened_at` is
  -- what puts a customer first in his rep's To validate order; a customer this restore confirmed has
  -- nothing left to capture, so leaving the stamp on would hold him at the top of a list he is no
  -- longer on. A customer still pending keeps it, because he really is still waiting.
  update public.phoenix_crm_customers c
  set reopened_at = null, updated_at = now()
  where c.status = 'active'
    and c.reopened_at is not null
    and exists (
      select 1 from public.phoenix_crm_places pl
      where pl.customer_id = c.id and pl.shared_place_id = v_id and pl.status = 'active'
    );

  return jsonb_build_object(
    'shared_place_id', v_id,
    'name', v_venue.name,
    'seat_id', v_venue.seat_id,
    'is_test', v_venue.is_test,
    'status', 'active',
    'places_restored', v_places,
    'reviews_reopened', v_reviews_reopened,
    'validated', v_validated,
    'still_waiting', v_still_waiting
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_shared_place(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
