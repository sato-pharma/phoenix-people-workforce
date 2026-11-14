-- phoenix_crm_validation_left_items
--
-- WHAT THIS CHANGES: replaces eight functions and clears two sets of stale values. Each function starts from
--   the body production holds today (the digests are below) and changes only what is named here. No table,
--   column, constraint, index or grant changes.
--   1. public.phoenix_crm_decide_validation_review(jsonb) — approving a held validation whose place is seated
--      in a building that is itself still held approves the review and leaves the customer pending. The
--      answer and the `validation_review_approved` event carry `waiting_for_building`. The building's row is
--      read under a share lock, before the customer's row is locked.
--   2. public.phoenix_crm_restore_validation(jsonb) — the same wait when a rejection is taken back.
--   3. public.phoenix_crm_decide_shared_place(jsonb) — on approving a building: (a) a customer whose seat a
--      person already approved is validated even when the building has no timetable on file or his own
--      timetable verdict is other_name or no_schedule; (b) a review still pending holds a customer only while
--      the place it is about is active; (c) the update that validates a customer clears `reopened_at`.
--   4. public.phoenix_crm_restore_shared_place(jsonb) — (a) and (b), in the holds it lifts from 3.
--   5. public.phoenix_crm_place_on_trusted_point(jsonb) — its `location_in_review` refusal makes test (b).
--   6. public.phoenix_crm_share_line_validation(jsonb) — the update that validates a customer clears
--      `reopened_at`.
--   7. public.phoenix_crm_decide_request(jsonb) — an add that admits a customer validated clears
--      `reopened_at`; a bring-back that returns him validated with his place clears it too.
--   8. public.phoenix_crm_reverse_list_request(jsonb) — a reversed drop that returns him validated with his
--      place clears `reopened_at`.
--   9. Data: `reopened_at` is set to null on every customer whose status is 'active' (237 on production).
--  10. Data: pin_lat, pin_lon and pin_accuracy_meters are set to null on every place seated in a building
--      (point_source 'shared_place') whose pin is an exact copy of its point (641 on production).
-- WHY: the items the validation audit of 2026-11-14 listed as left as they were (the header of
--   20261114050048_phoenix_crm_validation_audit_fixes.sql, "NOT IN THIS FILE"), which the owner asked to be
--   closed the same day.
--   1-4. Nobody behind a building still being checked counts in a KPI until the building is approved (owner,
--      2026-10-14). Approving a customer's held validation validated him at once all the same. Holding him
--      there alone would have stranded him: the building's approval skips exactly the customers a review is
--      held for (no timetable, other_name, no_schedule), so "approve the review, then the building" would
--      leave him pending with nothing left to decide. So the wait and the release change together. Production
--      holds 8 real reviews pending on a place seated in a held building today (3 of them other_name) and no
--      real customer validated behind a held building, so nobody's standing changes when this is applied.
--   3-5. A rejected building, and a place retired from the list, leave a pending review of the retired place
--      pending. The audit made the door and every reader count a pending review only while its place is
--      active; these three still counted any. Latent: production holds no pending review on a retired place.
--   3, 6-8. `reopened_at` puts a customer first in To validate. The audit cleared it where the rep's own
--      validation, the approval of a held one and the trusted point validate; these four doors still left it.
--   9. The stamps those doors left: 237 customers in use carry one. Every reader filters on status 'pending',
--      so nothing on screen changes; it stops an old refusal's age coming back the next time he is sent to To
--      validate by a path that stamps nothing.
--  10. A seating has no reading of its own. Until 20261114050048 the building's point was copied into the pin
--      columns, where it reads as a second reading taken at this customer's place. 641 of the 643 seated
--      places carry that copy; every one equals lat/lon exactly, and its accuracy equals accuracy_meters.
-- ROLLBACK: re-run the block of each function from the migration that last defined it —
--   phoenix_crm_decide_validation_review and phoenix_crm_place_on_trusted_point from
--   20261114050048_phoenix_crm_validation_audit_fixes.sql, phoenix_crm_restore_validation from
--   20261114051314_phoenix_crm_validation_owner_decisions.sql, phoenix_crm_decide_shared_place from
--   20261014200147_phoenix_crm_held_venue_customers_wait_for_approval.sql, phoenix_crm_restore_shared_place
--   from 20261015220318_phoenix_crm_restore_shared_place.sql, phoenix_crm_share_line_validation from
--   20261112221819_phoenix_crm_line_twin_validation.sql, and phoenix_crm_decide_request and
--   phoenix_crm_reverse_list_request from
--   20261111013233_phoenix_crm_bring_back_never_validates_without_place.sql. A customer left waiting for his
--   building by 1 or 2 is validated by approving the building. The data of 9 and 10 comes back from the
--   pre-image on production: phoenix_crm_backup_20261114.left_items_reopen_stamps (id, reopened_at) and
--   phoenix_crm_backup_20261114.left_items_copied_pins (id, pin_lat, pin_lon, pin_accuracy_meters).
--
-- md5(prosrc) on production, project ozucdzovmcqvepbozvqf, read 2026-11-14 — BEFORE this file, and what
-- pg_proc must answer AFTER it:
--   phoenix_crm_decide_validation_review  69ffc695771d1894e25c49ef68d762e2  ->  deb4db4e9342b4d09d3ac28a6fd3b75e
--   phoenix_crm_restore_validation        45a6d5b94c9f2bd3cb496126f6cb7fd1  ->  856f77c5db70d077b9e52d12c4b2c441
--   phoenix_crm_decide_shared_place       5798d729a666d7a3aad2c333646ce4ac  ->  4692843a9d19b894c421f3868122ac34
--   phoenix_crm_restore_shared_place      6125bcd0036791bc866fa1d34f70b323  ->  1f197da1ea9943f050375c54e3e13358
--   phoenix_crm_place_on_trusted_point    8d2b86912b0c8213750d198025117307  ->  afb57a138edf00eff639ddab64922d50
--   phoenix_crm_share_line_validation     16f1fee6bd46b948ce6f20b9ea315a84  ->  60782903ed872d66844618f2d6a02f0f
--   phoenix_crm_decide_request            9ff9cd6c9194cbc65c6a49f29d624374  ->  867331bbeec8231a62d578a6c0921876
--   phoenix_crm_reverse_list_request      421a3d7e05190bee1c2bb7f5779870b4  ->  3f23ab63310174713f1867f46e674b90
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

-- 1. Approving a held validation: a seat in a building still being checked waits for the building.
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

-- 2. Taking a rejection back: the same wait.
create or replace function public.phoenix_crm_restore_validation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  -- The Super Admin's own spelling of the customer's name (owner, 2026-11-10: "Both"). The service has
  -- already refused everybody else and checked the three names; null means "keep the name as it stands".
  v_corrected text := nullif(left(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), 200), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_renamed boolean := false;
  -- 2026-11-14 (left items): the building the place is seated in, and whether the approval waits for it.
  v_building_status text;
  v_waiting boolean := false;
begin
  -- 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"). It used to raise
  -- bad_input on a null note; the four events and the review row this writes all accept one, and
  -- `who` and `when` are on the record whether or not he writes a word about it.
  if v_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  if v_review.status <> 'rejected' then
    raise exception 'phoenix_crm:review_not_rejected';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  -- The place must still be in the state the rejection left it in. A moved or already-active place is
  -- a different story and is not undone here.
  if v_place.status <> 'retired' then
    raise exception 'phoenix_crm:place_not_retired';
  end if;

  -- 🔴 "APPROVE IT AFTER ALL" STOPS AND SAYS WHY (owner, 14 Nov 2026: "Stop and say why"). It used to
  -- bring the place back whatever had happened since the refusal, and 15 customers ended with two active
  -- places at one door, one with an active seat in a retired building. Each of the three is refused by
  -- name before anything is written; he clears what is in the way, then approves.
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:restore_customer_dropped';
  end if;
  if v_place.shared_place_id is not null and exists (
    select 1 from public.phoenix_crm_shared_places sp
    where sp.id = v_place.shared_place_id and sp.status = 'retired'
  ) then
    raise exception 'phoenix_crm:restore_building_retired';
  end if;
  -- The same door, captured again since: another active place of this customer in the same building, or
  -- within 150 m of this one (the line the Google check draws round a door).
  if exists (
    select 1 from public.phoenix_crm_places o
    where o.customer_id = v_place.customer_id
      and o.id <> v_place.id
      and o.status = 'active'
      and (
        (v_place.shared_place_id is not null and o.shared_place_id = v_place.shared_place_id)
        or (
          v_place.lat is not null and v_place.lon is not null and o.lat is not null and o.lon is not null
          and 6371000 * 2 * asin(least(1, sqrt(
            power(sin(radians(o.lat - v_place.lat) / 2), 2)
            + cos(radians(v_place.lat)) * cos(radians(o.lat)) * power(sin(radians(o.lon - v_place.lon) / 2), 2)
          ))) <= 150
        )
      )
  ) then
    raise exception 'phoenix_crm:restore_door_captured_again';
  end if;

  -- The corrected name first, so everything below reads the customer as he now is. The rep's own rename:
  -- the name key, the contact's name row and the history move exactly as when he saves a name himself, and
  -- a second customer of the same name is the administrator's to judge, never a refusal.
  if v_corrected is not null and v_corrected is distinct from v_customer.name and v_customer.status <> 'dropped' then
    perform public.phoenix_crm_rename_customer(jsonb_build_object(
      'seat_id', v_customer.seat_id,
      'actor_hr_id', v_actor,
      'is_test', v_customer.is_test,
      'customer_id', v_customer.id,
      'name', v_corrected,
      'speciality', v_customer.speciality,
      'allow_same_name', true
    ));
    -- A full name still waiting on "PM full names to check" is answered by the name he just wrote.
    update public.phoenix_crm_customers c
    set full_name_held = null,
        full_name_held_at = null,
        full_name_held_by_hr_id = null,
        full_name_held_score = null,
        full_name_held_board = null,
        updated_at = now()
    where c.id = v_customer.id and c.full_name_held is not null;
    select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer.id;
    v_renamed := true;
  end if;

  update public.phoenix_crm_places pl
  set status = 'active', retired_at = null, retired_by_hr_id = null, updated_at = now()
  where pl.id = v_place.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'place_restored', v_actor,
    jsonb_build_object('reason', v_note, 'label', v_place.label, 'why', 'validation_restored', 'review_id', v_id,
      'rejected_by_hr_id', v_review.decided_by_hr_id, 'rejection_note', v_review.decision_note),
    v_review.is_test
  );

  -- The rejection sent him back to To validate when this was his only place; the restore undoes that,
  -- in the REP's own name — he validated it, and a reversal does not take that away from him.
  -- 🔴 2026-11-14 (left items): the same wait as phoenix_crm_decide_validation_review. A place brought back
  -- into a building still being checked validates nobody until the building is approved; the review is
  -- approved all the same, and the building's approval reads it. The building's row is share-locked, so a
  -- decision on the building made at the same moment is seen whole or not at all.
  select sp.status into v_building_status
  from public.phoenix_crm_shared_places sp
  where sp.id = v_place.shared_place_id
  for share;
  v_waiting := v_customer.status = 'pending' and v_place.shared_place_id is not null and coalesce(v_building_status, '') = 'held';

  if v_customer.status = 'pending' and not v_waiting then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_review.created_by_hr_id,
        -- A validated customer carries no stamp of an old refusal (validation audit, 14 Nov 2026).
        reopened_at = null,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    v_validated := true;
  end if;

  -- One review row per place (the UNIQUE index), so this is an UPDATE. What it was before is kept in
  -- `google`, beside the events, rather than being thrown away.
  update public.phoenix_crm_validation_reviews r
  set status = 'approved',
      decided_by_hr_id = v_actor,
      decided_at = now(),
      decision_note = v_note,
      google = coalesce(r.google, '{}'::jsonb) || jsonb_build_object(
        'restored', true,
        'rejected_by_hr_id', v_review.decided_by_hr_id,
        'rejected_at', v_review.decided_at,
        'rejection_note', v_review.decision_note
      )
  where r.id = v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'validation_review_approved', v_actor,
    jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'why', 'restored_after_rejection',
      'renamed', v_renamed, 'waiting_for_building', v_waiting),
    v_review.is_test
  );

  return jsonb_build_object(
    'review_id', v_id,
    'status', 'approved',
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'place_id', v_place.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'waiting_for_building', v_waiting,
    'renamed', v_renamed
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_validation(jsonb) to service_role;

-- 3. The building's approval: releases a seat a person approved, counts a waiting review only on an active place, clears the old stamp.
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

-- 4. The building's take-back: the same two tests.
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
    'validated', v_validated,
    'still_waiting', v_still_waiting
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_shared_place(jsonb) to service_role;

-- 5. The trusted point: a waiting review counts only on an active place.
create or replace function public.phoenix_crm_place_on_trusted_point(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_loc jsonb := p -> 'location';
  v_basis jsonb := p -> 'basis';
  v_customer public.phoenix_crm_customers%rowtype;
  v_place_id uuid;
  v_event text;
  v_was text;
begin
  if v_seat is null or v_actor is null or p ->> 'customer_id' is null
    or jsonb_typeof(v_loc) is distinct from 'object'
    or jsonb_typeof(v_basis) is distinct from 'object'
    or (v_loc ->> 'lat') is null or (v_loc ->> 'lon') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = (p ->> 'customer_id')::uuid
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:archived';
  end if;
  if v_customer.status not in ('pending', 'active') then
    raise exception 'phoenix_crm:not_on_list';
  end if;
  if v_customer.list_type not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if exists (
    select 1 from public.phoenix_crm_places pl
    where pl.customer_id = v_customer.id and pl.status = 'active'
  ) then
    raise exception 'phoenix_crm:already_has_place';
  end if;
  -- 2026-11-14 (left items): only while the place that review is about is still ACTIVE, the test every other
  -- door makes since the validation audit. A customer with an active place was already refused just above,
  -- so this can no longer fire; it is kept so the doors read alike if that order ever changes.
  if exists (
    select 1 from public.phoenix_crm_validation_reviews r
    where r.customer_id = v_customer.id and r.status = 'pending'
      and exists (select 1 from public.phoenix_crm_places pl where pl.id = r.place_id and pl.status = 'active')
  ) then
    raise exception 'phoenix_crm:location_in_review';
  end if;

  insert into public.phoenix_crm_places (
    customer_id, seat_id, lat, lon, accuracy_meters, timings, photo_path, captured_at, created_by_hr_id, is_test,
    point_source, trusted_basis, address, zone, brick_lookup, brick_id, brick_name, brick_distance_km,
    area_code, area_name, region_code, region_name
  )
  values (
    v_customer.id,
    v_seat,
    (v_loc ->> 'lat')::double precision,
    (v_loc ->> 'lon')::double precision,
    nullif(v_loc ->> 'accuracy_meters', '')::numeric,
    '[]'::jsonb,
    null,
    now(),
    v_actor,
    v_is_test,
    'trusted',
    v_basis,
    left(nullif(v_loc ->> 'address', ''), 200),
    left(nullif(v_loc ->> 'zone', ''), 80),
    coalesce(nullif(v_loc ->> 'brick_lookup', ''), 'could_not_look'),
    nullif(v_loc ->> 'brick_id', ''),
    nullif(v_loc ->> 'brick_name', ''),
    nullif(v_loc ->> 'brick_distance_km', '')::numeric,
    nullif(v_loc ->> 'area_code', ''),
    nullif(v_loc ->> 'area_name', ''),
    nullif(v_loc ->> 'region_code', ''),
    nullif(v_loc ->> 'region_name', '')
  )
  returning id into v_place_id;

  v_was := v_customer.status;
  if v_customer.status = 'pending' then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_actor,
        reopened_at = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;

    -- 2026-11-14 (validation audit): a drop request still open on him is withdrawn, exactly as the rep's own
    -- validation and the approval of a held one withdraw it. This door validated him and left it standing.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          stage = null,
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Validated instead of dropped'
      where q.seat_id = v_seat
        and q.is_test = v_is_test
        and q.kind = 'drop'
        and q.status = 'pending'
        and (
          q.customer_id = v_customer.id
          or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
        )
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
    from withdrawn w;

    v_event := 'customer_validated';
  else
    v_event := 'place_added';
  end if;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, v_place_id, v_event, v_actor,
    jsonb_build_object('mode', 'trusted_point', 'basis', v_basis, 'was', v_was),
    v_is_test
  );

  return jsonb_build_object(
    'place_id', v_place_id,
    'customer_id', v_customer.id,
    'status', 'active',
    'event', v_event
  );
end;
$$;

revoke execute on function public.phoenix_crm_place_on_trusted_point(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_place_on_trusted_point(jsonb) to service_role;

-- 6. The line twin: a validation clears the old refusal stamp.
create or replace function public.phoenix_crm_share_line_validation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_ids jsonb := p -> 'source_place_ids';
  v_customer public.phoenix_crm_customers%rowtype;
  v_source record;
  v_place_id uuid;
  v_place_ids uuid[] := '{}';
  v_source_customers uuid[] := '{}';
  v_validated_by text := upper(nullif(trim(coalesce(p ->> 'validated_by_hr_id', '')), ''));
  v_wanted int;
  v_found int;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'customer_id', '') is null
    or jsonb_typeof(v_ids) is distinct from 'array'
    or jsonb_array_length(v_ids) not between 1 and 5 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = (p ->> 'customer_id')::uuid
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.list_type not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_customer.status <> 'pending' or v_customer.validated_at is not null then
    return jsonb_build_object('skipped', 'not_waiting', 'customer_id', v_customer.id);
  end if;
  if exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active') then
    return jsonb_build_object('skipped', 'has_place', 'customer_id', v_customer.id);
  end if;
  if exists (select 1 from public.phoenix_crm_validation_reviews r where r.customer_id = v_customer.id and r.status = 'pending') then
    return jsonb_build_object('skipped', 'in_review', 'customer_id', v_customer.id);
  end if;
  if exists (
    select 1 from public.phoenix_crm_list_requests q
    where q.seat_id = v_seat
      and q.is_test = v_is_test
      and q.kind = 'drop'
      and q.status = 'pending'
      and (
        q.customer_id = v_customer.id
        or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
      )
  ) then
    return jsonb_build_object('skipped', 'drop_requested', 'customer_id', v_customer.id);
  end if;
  if v_customer.full_name_held is not null then
    return jsonb_build_object('skipped', 'full_name_held', 'customer_id', v_customer.id);
  end if;

  -- Every source must still be an own place of a Phoenix validation of the same list, on another seat and line.
  v_wanted := (select count(distinct e) from jsonb_array_elements_text(v_ids) e);
  select count(*) into v_found
  from public.phoenix_crm_places pl
  join public.phoenix_crm_customers sc on sc.id = pl.customer_id
  where pl.id in (select e::uuid from jsonb_array_elements_text(v_ids) e)
    and pl.status = 'active'
    and pl.point_source <> 'line_twin'
    and pl.is_test = v_is_test
    and pl.seat_id <> v_seat
    and sc.status = 'active'
    and sc.validated_at is not null
    and sc.list_type = v_customer.list_type
    and sc.is_test = v_is_test
    and sc.line_code is distinct from v_customer.line_code;
  if v_found <> v_wanted then
    return jsonb_build_object('skipped', 'source_gone', 'customer_id', v_customer.id);
  end if;

  for v_source in
    select pl.*, sc.line_code as source_line, sc.validated_at as source_validated_at, sc.validated_by_hr_id as source_validated_by, e.ord
    from jsonb_array_elements_text(v_ids) with ordinality as e(id, ord)
    join public.phoenix_crm_places pl on pl.id = e.id::uuid
    join public.phoenix_crm_customers sc on sc.id = pl.customer_id
    order by e.ord
  loop
    if not (v_source.customer_id = any (v_source_customers)) then
      v_source_customers := v_source_customers || v_source.customer_id;
    end if;
    v_validated_by := coalesce(v_validated_by, upper(v_source.source_validated_by));

    insert into public.phoenix_crm_places (
      customer_id, seat_id, label, address, brick_id, brick_name, zone, lat, lon, accuracy_meters, timings,
      photo_path, captured_at, created_by_hr_id, is_test, brick_distance_km, area_code, area_name, region_code,
      region_name, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters,
      photo_captured_at, point_source, brick_lookup, session, trusted_basis
    )
    values (
      v_customer.id, v_seat, v_source.label, v_source.address, v_source.brick_id, v_source.brick_name, v_source.zone,
      v_source.lat, v_source.lon, v_source.accuracy_meters, v_source.timings,
      null, v_source.captured_at, v_actor, v_is_test, v_source.brick_distance_km, v_source.area_code, v_source.area_name,
      v_source.region_code, v_source.region_name,
      case when v_source.point_source in ('photo', 'pin') then v_source.pin_lat end,
      case when v_source.point_source in ('photo', 'pin') then v_source.pin_lon end,
      case when v_source.point_source in ('photo', 'pin') then v_source.pin_accuracy_meters end,
      v_source.photo_lat, v_source.photo_lon, v_source.photo_accuracy_meters, v_source.photo_captured_at,
      'line_twin', v_source.brick_lookup, v_source.session,
      jsonb_build_object(
        'kind', 'line_twin',
        'source_place_id', v_source.id,
        'source_customer_id', v_source.customer_id,
        'source_seat_id', v_source.seat_id,
        'source_line', v_source.source_line,
        'source_point_source', v_source.point_source,
        'source_validated_at', v_source.source_validated_at,
        'source_validated_by_hr_id', v_source.source_validated_by
      )
    )
    returning id into v_place_id;
    v_place_ids := v_place_ids || v_place_id;
  end loop;

  update public.phoenix_crm_customers c
  set status = 'active',
      validated_at = now(),
      validated_by_hr_id = coalesce(v_validated_by, v_actor),
      -- 2026-11-14 (left items): validated, so nothing waits to be captured again.
      reopened_at = null,
      dropped_reason = null,
      dropped_note = null,
      status_changed_at = now(),
      updated_at = now()
  where c.id = v_customer.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, v_place_ids[1], 'customer_validated', v_actor,
    jsonb_build_object(
      'mode', 'line_twin',
      'place_ids', to_jsonb(v_place_ids),
      'source_place_ids', v_ids,
      'source_customer_ids', to_jsonb(v_source_customers),
      'validated_by_hr_id', coalesce(v_validated_by, v_actor),
      'reference_contact_crm_id', v_customer.reference_contact_crm_id
    ),
    v_is_test
  );

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'place_ids', to_jsonb(v_place_ids),
    'status', 'active',
    'event', 'customer_validated'
  );
end;
$$;

revoke execute on function public.phoenix_crm_share_line_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_share_line_validation(jsonb) to service_role;

-- 7. The list request: an admitted add and a bring-back that returns him validated clear the stamp.
create or replace function public.phoenix_crm_decide_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_stage_in text := nullif(p ->> 'stage', '');
  v_approved_in text := nullif(p ->> 'approved_grade', '');
  v_potential_in text := nullif(p ->> 'potential_grade', '');
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_status text;
  v_final boolean := true;
  v_has_place boolean;
begin
  if v_actor is null or v_request_id is null or v_decision not in ('approve', 'refuse') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if (v_approved_in is not null and v_approved_in not in ('A', 'B', 'C'))
    or (v_potential_in is not null and v_potential_in not in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
    and q.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  v_seat := v_request.seat_id;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
  for update;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;
  -- Two people deciding at once: the second one's step has already moved on.
  if v_stage_in is not null and v_stage_in is distinct from v_request.stage then
    raise exception 'phoenix_crm:request_wrong_stage';
  end if;

  -- ── The district manager's step of a two-step request: approving hands it to SFE ──────────────
  if v_decision = 'approve' and v_request.stage = 'manager' then
    if v_request.kind = 'add' then
      if v_potential_in is null then
        raise exception 'phoenix_crm:potential_grade_required';
      end if;
      v_approved_in := coalesce(v_approved_in, v_request.proposed_grade);
    else
      v_approved_in := null;
      v_potential_in := null;
    end if;

    update public.phoenix_crm_list_requests q
    set stage = 'sfe',
        manager_decided_by_hr_id = v_actor,
        manager_decided_at = now(),
        manager_note = v_note,
        approved_grade = v_approved_in,
        potential_grade = v_potential_in
    where q.id = v_request.id
    returning q.* into v_request;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_request.customer_id, v_request.id, 'request_moved_on', v_actor,
      jsonb_build_object('kind', v_request.kind, 'to_stage', 'sfe', 'approved_grade', v_approved_in, 'potential_grade', v_potential_in),
      v_is_test
    );

    return jsonb_build_object(
      'request_id', v_request.id,
      'seat_id', v_seat,
      'kind', v_request.kind,
      'status', 'pending',
      'stage', 'sfe',
      'final', false,
      'customer_id', v_request.customer_id,
      'customer_name', v_request.customer_name,
      'list_type', v_request.list_type,
      'proposed_grade', v_request.proposed_grade,
      'drop_reason', v_request.drop_reason,
      'requested_by_hr_id', v_request.requested_by_hr_id
    );
  end if;

  if v_decision = 'approve' then
    v_status := 'approved';

    if v_request.kind = 'grade' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'active' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set grade = v_request.proposed_grade, updated_at = now()
      where c.id = v_customer.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'grade_changed', v_actor,
        jsonb_build_object('from', v_customer.grade, 'to', v_request.proposed_grade), v_is_test
      );

    elsif v_request.kind = 'add' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or not (
        v_customer.status = 'outside'
        or (v_customer.status = 'dropped' and v_customer.origin = 'new' and v_customer.validated_at is null)
      ) then
        raise exception 'phoenix_crm:not_outside';
      end if;
      -- 🔴 ADMITTED IS NOT VALIDATED (owner, 2026-11-11). Until this migration the approval stamped
      -- validated_at whatever had happened to the door since the request was filed, and 23 customers
      -- were validated with NO place — each one's only place had been rejected and retired first. A
      -- pharmacy is validated by its own pin and holds no place row, so it keeps the old door.
      v_has_place := v_customer.list_type not in ('AM', 'PM') or exists (
        select 1 from public.phoenix_crm_places pl
        where pl.customer_id = v_customer.id and pl.status = 'active'
      );
      if v_has_place then
        -- Admitted. validated_at is set NOW: the customer was validated at the door, and every visit
        -- logged against him since starts counting, in the month it happened (owner, 2026-09-29).
        update public.phoenix_crm_customers c
        set status = 'active',
            validated_at = now(),
            validated_by_hr_id = v_request.requested_by_hr_id,
            -- 2026-11-14 (left items): validated, so nothing waits to be captured again.
            reopened_at = null,
            grade = coalesce(v_request.approved_grade, v_approved_in, v_request.proposed_grade),
            potential_grade = coalesce(v_request.potential_grade, v_potential_in),
            dropped_reason = null,
            dropped_note = null,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      else
        -- Admitted with no door on file: he goes to "To validate", graded as approved, and the rep
        -- captures his place again. reopened_at is the same stamp a rejected validation leaves.
        update public.phoenix_crm_customers c
        set status = 'pending',
            validated_at = null,
            validated_by_hr_id = null,
            grade = coalesce(v_request.approved_grade, v_approved_in, v_request.proposed_grade),
            potential_grade = coalesce(v_request.potential_grade, v_potential_in),
            dropped_reason = null,
            dropped_note = null,
            reopened_at = now(),
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      end if;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_admitted', v_actor,
        jsonb_build_object('grade', v_customer.grade, 'potential_grade', v_customer.potential_grade,
          'validated', v_has_place, 'to', v_customer.status), v_is_test
      );

    elsif v_request.kind = 'restore' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'dropped' then
        raise exception 'phoenix_crm:not_archived';
      end if;
      -- Back where he was: on the list if he had been validated AND still holds a place, waiting to be
      -- validated if not. His last place can be retired while he sits in the Archive (a venue or a
      -- review rejected: both un-validate only an ACTIVE customer), and the stamp would then put him
      -- back on the list with nothing to measure a visit against (2026-11-11).
      v_has_place := v_customer.list_type not in ('AM', 'PM') or exists (
        select 1 from public.phoenix_crm_places pl
        where pl.customer_id = v_customer.id and pl.status = 'active'
      );
      update public.phoenix_crm_customers c
      set status = case when c.validated_at is not null and v_has_place then 'active' else 'pending' end,
          validated_at = case when v_has_place then c.validated_at else null end,
          validated_by_hr_id = case when v_has_place then c.validated_by_hr_id else null end,
          -- 2026-11-14 (left items): back in use with his place, so the stamp of an old refusal goes.
          reopened_at = case
            when c.validated_at is not null and not v_has_place then now()
            when c.validated_at is not null and v_has_place then null
            else c.reopened_at
          end,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('to', v_customer.status, 'place', v_has_place), v_is_test);

    elsif v_request.customer_id is not null then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      -- Active or pending: both leave the list. A pending one keeps validated_at null, so the visits
      -- logged against him never start counting — he was never validated. His places are KEPT
      -- (owner, 2026-09-29): the clinic is still where it was, and a bring-back needs no new photo.
      if not found or v_customer.status = 'dropped' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set status = 'dropped',
          dropped_reason = v_request.drop_reason,
          dropped_note = v_request.note,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'The customer left the list'
        where q.customer_id = v_customer.id
          and q.status = 'pending'
          and q.id <> v_request.id
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'dropped'), v_is_test
      from withdrawn w;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason), v_is_test
      );

    else
      select c.* into v_customer
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.reference_contact_crm_id = v_request.reference_contact_crm_id
        and c.is_test = v_is_test
      for update;
      if found then
        if v_customer.status = 'active' then
          raise exception 'phoenix_crm:already_validated';
        end if;
        if v_customer.status = 'dropped' then
          raise exception 'phoenix_crm:customer_dropped';
        end if;
        -- Pending: the customer was carried over from iReports360 and never validated.
        update public.phoenix_crm_customers c
        set status = 'dropped',
            dropped_reason = v_request.drop_reason,
            dropped_note = v_request.note,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      else
        insert into public.phoenix_crm_customers (
          seat_id, line_code, list_type, name, grade, origin, reference_contact_crm_id, status, validated_at,
          dropped_reason, dropped_note, status_changed_at, created_by_hr_id, is_test
        )
        values (
          v_seat, v_request.line_code, v_request.list_type, left(v_request.customer_name, 200), v_request.current_grade, 'reference',
          v_request.reference_contact_crm_id, 'dropped', null, v_request.drop_reason, v_request.note, now(),
          v_request.requested_by_hr_id, v_is_test
        )
        returning * into v_customer;
      end if;

      update public.phoenix_crm_list_requests q set customer_id = v_customer.id where q.id = v_request.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason, 'reference_contact_crm_id', v_request.reference_contact_crm_id),
        v_is_test
      );
    end if;
  else
    v_status := 'refused';

    -- A refused add sends the customer to the Archive: he was never admitted, and the rep can still
    -- ask again from there.
    if v_request.kind = 'add' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if found and v_customer.status = 'outside' then
        update public.phoenix_crm_customers c
        set status = 'dropped',
            dropped_reason = 'not_admitted',
            dropped_note = v_note,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;

        insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
        values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'add_refused'), v_is_test);
      end if;
    end if;
  end if;

  update public.phoenix_crm_list_requests q
  set status = v_status,
      stage = null,
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      manager_decided_by_hr_id = case when v_request.stage = 'manager' then v_actor else q.manager_decided_by_hr_id end,
      manager_decided_at = case when v_request.stage = 'manager' then now() else q.manager_decided_at end,
      manager_note = case when v_request.stage = 'manager' then v_note else q.manager_note end,
      sfe_decided_by_hr_id = case when v_request.stage = 'sfe' then v_actor else q.sfe_decided_by_hr_id end,
      sfe_decided_at = case when v_request.stage = 'sfe' then now() else q.sfe_decided_at end,
      sfe_note = case when v_request.stage = 'sfe' then v_note else q.sfe_note end,
      potential_grade = coalesce(q.potential_grade, case when v_request.kind = 'add' and v_status = 'approved' then v_potential_in end)
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, coalesce(v_customer.id, v_request.customer_id), v_request.id, 'request_decided', v_actor,
    jsonb_build_object('kind', v_request.kind, 'decision', v_status, 'stage', v_request.stage), v_is_test
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', v_status,
    'stage', null,
    'final', v_final,
    'customer_id', coalesce(v_customer.id, v_request.customer_id),
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_request(jsonb) to service_role;

-- 8. The reversal of a drop: the same.
create or replace function public.phoenix_crm_reverse_list_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_seat text;
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_old_grade text;
  v_reason text;
  v_has_place boolean;
begin
  if v_request_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select q.* into v_request from public.phoenix_crm_list_requests q where q.id = v_request_id and q.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  v_seat := v_request.seat_id;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request from public.phoenix_crm_list_requests q where q.id = v_request_id for update;
  if v_request.status <> 'approved' or v_request.customer_id is null then
    raise exception 'phoenix_crm:request_not_approved';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
  if not found then
    raise exception 'phoenix_crm:reverse_customer_moved_on';
  end if;

  -- Anything that touched this customer after the decision (another request, a place, a move) means the
  -- picture is no longer the one the decision made: say so, change nothing.
  if exists (
    select 1 from public.phoenix_crm_list_events ev
    where ev.customer_id = v_customer.id
      and ev.created_at > v_request.decided_at
      and ev.request_id is distinct from v_request.id
  ) or exists (
    select 1 from public.phoenix_crm_list_requests q2
    where q2.customer_id = v_customer.id and q2.id <> v_request.id and q2.requested_at > v_request.decided_at
  ) then
    raise exception 'phoenix_crm:reverse_customer_moved_on';
  end if;

  if v_request.kind = 'grade' then
    if v_customer.status <> 'active' or v_customer.grade is distinct from v_request.proposed_grade then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    select e.details ->> 'from' into v_old_grade
    from public.phoenix_crm_list_events e
    where e.request_id = v_request.id and e.event_type = 'grade_changed'
    order by e.id desc limit 1;
    if v_old_grade is null then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    update public.phoenix_crm_customers c set grade = v_old_grade, updated_at = now() where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'grade_change_reversed', v_actor,
            jsonb_build_object('from', v_customer.grade, 'to', v_old_grade), v_is_test);

  elsif v_request.kind = 'add' then
    -- 'pending' too (2026-11-11): an add approved for a customer with no place admits him to
    -- "To validate", and that decision must stay as undoable as one that validated him. Anything
    -- that moved him since is already refused above.
    if v_customer.status not in ('active', 'pending') then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    -- Back out the way a refused add leaves: in the Archive, never admitted, the rep may ask again.
    update public.phoenix_crm_customers c
    set status = 'dropped',
        dropped_reason = 'not_admitted',
        dropped_note = v_note,
        validated_at = null,
        validated_by_hr_id = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'add_reversed'), v_is_test);

  elsif v_request.kind = 'restore' then
    if v_customer.status not in ('active', 'pending') then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    select coalesce(nullif(e.details ->> 'reason', ''), case when e.event_type = 'customer_archived' then 'not_admitted' end)
      into v_reason
    from public.phoenix_crm_list_events e
    where e.customer_id = v_customer.id and e.event_type in ('customer_dropped', 'customer_archived') and e.created_at <= v_request.decided_at
    order by e.id desc limit 1;
    update public.phoenix_crm_customers c
    set status = 'dropped',
        dropped_reason = coalesce(v_reason, 'other'),
        dropped_note = v_note,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'restore_reversed'), v_is_test);

  elsif v_request.kind = 'drop' then
    if v_customer.status <> 'dropped' then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    -- Back where he was: on the list if he had been validated, waiting to be validated if not. The
    -- other requests the drop withdrew stay withdrawn - the rep asks again if he still needs them.
    -- ...and on the list only while he still holds a place (2026-11-11, the same door as a bring-back).
    v_has_place := v_customer.list_type not in ('AM', 'PM') or exists (
      select 1 from public.phoenix_crm_places pl
      where pl.customer_id = v_customer.id and pl.status = 'active'
    );
    update public.phoenix_crm_customers c
    set status = case when c.validated_at is not null and v_has_place then 'active' else 'pending' end,
        validated_at = case when v_has_place then c.validated_at else null end,
        validated_by_hr_id = case when v_has_place then c.validated_by_hr_id else null end,
        -- 2026-11-14 (left items): back in use with his place, so the stamp of an old refusal goes.
        reopened_at = case
          when c.validated_at is not null and not v_has_place then now()
          when c.validated_at is not null and v_has_place then null
          else c.reopened_at
        end,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('why', 'drop_reversed', 'place', v_has_place), v_is_test);

  else
    raise exception 'phoenix_crm:reverse_customer_moved_on';
  end if;

  update public.phoenix_crm_list_requests q
  set status = 'refused',
      stage = null,
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      admin_decided_by_hr_id = v_actor,
      admin_decided_at = now(),
      admin_note = v_note
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_customer.id, v_request.id, 'request_reversed', v_actor,
          jsonb_build_object('kind', v_request.kind, 'was', 'approved'), v_is_test);

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', 'refused',
    'stage', null,
    'final', true,
    'customer_id', v_customer.id,
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_reverse_list_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_reverse_list_request(jsonb) to service_role;

-- 9. The stamps the eight doors above left behind. A customer in use has nothing waiting to be captured
--    again; no reader shows the stamp while he is validated. The pre-image is in
--    phoenix_crm_backup_20261114.left_items_reopen_stamps (production).
update public.phoenix_crm_customers c
set reopened_at = null
where c.status = 'active' and c.reopened_at is not null;

-- 10. The building's point copied into a seated place's pin columns. A seating has no reading of its own
--     (phoenix_crm_insert_place writes these null since 20261114050048); only an exact copy is cleared. The
--     pre-image is in phoenix_crm_backup_20261114.left_items_copied_pins (production).
update public.phoenix_crm_places pl
set pin_lat = null, pin_lon = null, pin_accuracy_meters = null
where pl.point_source = 'shared_place'
  and pl.pin_lat is not null
  and pl.pin_lat = pl.lat
  and pl.pin_lon = pl.lon;

notify pgrst, 'reload schema';

commit;
