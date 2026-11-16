-- phoenix_crm_super_admin_approval_is_final
--
-- WHAT THIS CHANGES: adds one function and replaces two. No table, column, constraint, index or data changes.
--   1. public.phoenix_crm_is_super_admin(text) — new: true when the HR id holds an active, non-test
--      'Super Admin' login in app_auth_users. SECURITY DEFINER, service_role only.
--   2. public.phoenix_crm_decide_validation_review(jsonb) — a REJECT by anybody but a Super Admin raises
--      phoenix_crm:approved_by_super_admin when the review was approved by a Super Admin, or when the place
--      was created by a Super Admin (a trusted point, a seat he placed). Nothing else in the body changes.
--   3. public.phoenix_crm_decide_shared_place(jsonb) — a REJECT of an active building a Super Admin approved,
--      by anybody but a Super Admin, raises the same code. Nothing else in the body changes.
-- WHY: owner, 2026-11-16: "when super admin approve something sfe or whoever cannot reject it back bec its
--   approved by admin". On 2026-11-15 18:58 Cairo the SFE Manager refused the administrator's three
--   trusted-point validations on Mostafa Galal's Pedia list ("no signboard" — a trusted point has no photo by
--   design), and the three doctors went back to To validate. The administrator restored them on 2026-11-16.
-- ROLLBACK: re-run the blocks of phoenix_crm_decide_validation_review and phoenix_crm_decide_shared_place from
--   20261114062049_phoenix_crm_validation_left_items.sql, then
--   drop function public.phoenix_crm_is_super_admin(text);
--
-- md5(prosrc) on production, project ozucdzovmcqvepbozvqf, read 2026-11-16 — BEFORE this file:
--   phoenix_crm_decide_validation_review  deb4db4e9342b4d09d3ac28a6fd3b75e
--   phoenix_crm_decide_shared_place       4692843a9d19b894c421f3868122ac34
-- (both equal the bodies 20261114062049 wrote, which this file starts from).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

-- 1. Who is a Super Admin, by HR id. A test account (is_test_persona) never counts, and neither does a
--    login that is switched off.
create or replace function public.phoenix_crm_is_super_admin(p_hr_id text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select nullif(trim(coalesce(p_hr_id, '')), '') is not null and exists (
    select 1
    from public.app_auth_users u
    where upper(u.hr_id) = upper(trim(p_hr_id))
      and u.role = 'Super Admin'
      and u.is_active is true
      and coalesce(u.is_test_persona, false) = false
  );
$$;

revoke execute on function public.phoenix_crm_is_super_admin(text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_is_super_admin(text) to service_role;

-- The same list, whole, for the screen: which buttons to hide (src/lib/phoenix-crm/server/super-admin-approval.ts).
-- One definition, so the screen and the guard can never disagree about who counts.
create or replace function public.phoenix_crm_super_admin_hr_ids()
returns setof text
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct upper(trim(u.hr_id))
  from public.app_auth_users u
  where public.phoenix_crm_is_super_admin(u.hr_id);
$$;

revoke execute on function public.phoenix_crm_super_admin_hr_ids() from public, anon, authenticated;
grant execute on function public.phoenix_crm_super_admin_hr_ids() to service_role;

-- 2. Deciding a validation: what a Super Admin approved, only a Super Admin rejects.
create or replace function public.phoenix_crm_decide_validation_review(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  -- what the rep is told about his own photo (2026-10-08). Accepted null here and REQUIRED by the
  -- service; the column CHECK is what guarantees the value is one of the eight.
  v_reason text := nullif(trim(coalesce(p ->> 'refusal_reason', '')), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_reopened boolean := false;
  -- 2026-11-14 (left items): the building the place is seated in, and whether the approval waits for it.
  v_building_status text;
  v_waiting boolean := false;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  -- 🔴 THE ONE EDIT OF THIS MIGRATION (owner, 2026-10-15: "make admin able to reject validation even
  -- if approved before"). A REJECT of an APPROVED review is the undo of that approval and runs the
  -- reject branch below exactly as a held review's rejection does — the place is retired, the
  -- customer goes back to To validate when it was his only one, reopened_at is stamped and the rep is
  -- told what is wrong with his photo. Everything else still raises review_decided: approving an
  -- approved review changes nothing, and a rejected one is reversed by
  -- phoenix_crm_restore_validation, which checks the place is still retired before it brings it back.
  if not (v_review.status = 'approved' and v_decision = 'reject') and v_review.status <> 'pending' then
    raise exception 'phoenix_crm:review_decided';
  end if;

  -- 🔴 WHAT THE SUPER ADMIN APPROVED, ONLY THE SUPER ADMIN REJECTS (owner, 2026-11-16: "when super admin
  -- approve something sfe or whoever cannot reject it back bec its approved by admin"). The SFE Manager
  -- refused the administrator's three trusted-point validations on 2026-11-15 for a missing signboard — a
  -- trusted point has no photograph by design. A reject by anybody but a Super Admin is refused when the
  -- review was approved by a Super Admin, or when the place itself is the Super Admin's own (a trusted
  -- point, a seat he placed): both are his approval. The Super Admin himself is never blocked.
  if v_decision = 'reject' and not public.phoenix_crm_is_super_admin(v_actor) and (
    (v_review.status = 'approved' and public.phoenix_crm_is_super_admin(v_review.decided_by_hr_id))
    or exists (
      select 1 from public.phoenix_crm_places pl
      where pl.id = v_review.place_id and public.phoenix_crm_is_super_admin(pl.created_by_hr_id)
    )
  ) then
    raise exception 'phoenix_crm:approved_by_super_admin';
  end if;

  -- 2026-11-14 (left items): the building this place is seated in, read under a share lock and BEFORE the
  -- customer's row is locked. phoenix_crm_decide_shared_place holds the building's row for the whole of its
  -- decision and then writes the customers seated in it, so the two can neither miss each other nor wait on
  -- each other in a ring. No row, and so null, for a place of the customer's own.
  select sp.status into v_building_status
  from public.phoenix_crm_shared_places sp
  where sp.id = (select pl.shared_place_id from public.phoenix_crm_places pl where pl.id = v_review.place_id)
  for share;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  if v_decision = 'approve' then
    update public.phoenix_crm_validation_reviews
    set status = 'approved', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note
    where id = v_id;

    -- 🔴 2026-11-14 (left items): NOBODY BEHIND A BUILDING STILL BEING CHECKED COUNTS YET (owner, 2026-10-14:
    -- "until the admin confirm the polyclinic and the doctors in it"). This approval used to validate the
    -- customer at once, building held or not. The review is approved all the same; the customer is validated
    -- when the building is (phoenix_crm_decide_shared_place reads this approval), or goes back to To validate
    -- if the building is rejected.
    v_waiting := v_review.kind = 'validation' and v_customer.status = 'pending' and v_place.status = 'active'
      and v_place.shared_place_id is not null and coalesce(v_building_status, '') = 'held';
    if v_review.kind = 'validation' and v_customer.status = 'pending' and v_place.status = 'active' and not v_waiting then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_review.created_by_hr_id,
          -- 2026-11-14 (validation audit): validated, so nothing waits to be captured again.
          reopened_at = null,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;
      v_validated := true;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'Validated instead of dropped'
        where q.seat_id = v_review.seat_id
          and q.is_test = v_review.is_test
          and q.kind = 'drop'
          and q.status = 'pending'
          and (
            q.customer_id = v_customer.id
            or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
          )
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_review.seat_id, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_review.is_test
      from withdrawn w;
    end if;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_approved', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'waiting_for_building', v_waiting), v_review.is_test
    );
  else
    update public.phoenix_crm_validation_reviews
    set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note,
        refusal_reason = v_reason
    where id = v_id;

    if v_place.status = 'active' then
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_place.id;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_review.seat_id, v_customer.id, v_place.id, 'place_retired', v_actor,
        jsonb_build_object('reason', coalesce(v_note, 'The location could not be confirmed against Google Maps.'), 'label', v_place.label,
          'lat', v_place.lat, 'lon', v_place.lon, 'why', 'validation_rejected'),
        v_review.is_test
      );
    end if;

    if v_customer.status = 'active' and not exists (
      select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active'
    ) then
      update public.phoenix_crm_customers c
      set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
      where c.id = v_customer.id;
      v_reopened := true;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
      values (v_review.seat_id, v_customer.id, 'customer_pending', v_actor,
        jsonb_build_object('reference_contact_crm_id', v_customer.reference_contact_crm_id, 'why', 'validation_rejected'), v_review.is_test);
    end if;

    -- he is waiting to capture this place again, from now (2026-10-08).
    -- 🔴 c.status is read from the TABLE, deliberately, so it sees the reopen above; and this fires
    -- for a customer who was ALREADY pending (a held first validation), which v_reopened never does.
    update public.phoenix_crm_customers c
    set reopened_at = now(), updated_at = now()
    where c.id = v_customer.id and c.status = 'pending';

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_rejected', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'reopened', v_reopened, 'refusal_reason', v_reason), v_review.is_test
    );
  end if;

  return jsonb_build_object(
    'review_id', v_id,
    'status', case when v_decision = 'approve' then 'approved' else 'rejected' end,
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'waiting_for_building', v_waiting,
    'reopened', v_reopened,
    -- so the service notifies the rep without a second read. rep_hr_id is the rep who VALIDATED,
    -- never the person deciding: he is the one whose photo this is.
    'rep_hr_id', v_review.created_by_hr_id,
    'customer_name', v_customer.name,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_validation_review(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_validation_review(jsonb) to service_role;

-- 3. Deciding a polyclinic or centre: the same.
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

  if v_decision = 'approve' then
    update public.phoenix_crm_shared_places
    set status = 'active', decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note,
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
    'validated', v_validated,
    'reopened', v_reopened,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_shared_place(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
