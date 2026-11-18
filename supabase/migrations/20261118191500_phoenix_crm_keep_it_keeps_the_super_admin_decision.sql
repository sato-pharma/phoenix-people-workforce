-- phoenix_crm_keep_it_keeps_the_super_admin_decision
--
-- WHAT THIS CHANGES: replaces one function, public.phoenix_crm_decide_shared_place(jsonb). No table, column,
--   constraint, index or data changes. The body is the one 20261118120000 wrote with ONE change: when the
--   approve branch keeps a Super Admin as decided_by_hr_id (an already-active building he approved, approved
--   again by somebody who is not one), it now keeps his decided_at and decision_note with his name, instead
--   of overwriting them with the new click's time and (often empty) note.
-- WHY: 20261118120000 kept the name and still re-stamped the other two, so a Keep it by the SFE Manager left
--   the Approved card reading "<Super Admin> . <today>" with his note gone, or the SFE Manager's note under his
--   name. A decision is one person's act: its name, its time and its note stay together. updated_at still moves.
-- ROLLBACK: re-run the phoenix_crm_decide_shared_place block of 20261118120000_phoenix_crm_super_admin_approval_survives_keep_it.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

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
