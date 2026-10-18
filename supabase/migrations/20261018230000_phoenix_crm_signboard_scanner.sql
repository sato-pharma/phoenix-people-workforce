-- phoenix_crm_signboard_scanner
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_refused_readings.reason accepts two more values, 'signboard_unreadable' and
--      'signboard_no_plate'. The table gains one nullable column, signboard_key — the place, the
--      customer, or a new customer's folded name the refused SIGNBOARD photo was taken for — and a CHECK
--      that no other reason carries one. One partial index serves the count the door asks before a save.
--   2. One new security-definer function, phoenix_crm_retake_place_signboard(jsonb): a rep replaces the
--      signboard photo of a place he already has, through the same single-use photo slot every
--      photograph in this module goes through. It sets photo_path and signboard_check on that one row,
--      and logs the photo and check it replaced to phoenix_crm_list_events. The location, the address,
--      the brick, the timings and the status are never touched.
--   No policy is changed, and no existing row is touched.
--
-- WHY:
--   Owner, 2026-10-18: "fix all the unreadable … find the root cause … a real fixation plan for
--   historicals and upcomings". Audited that evening on production: 532 active places filed "Not
--   readable", every one ACCEPTED at the door and found unreadable afterwards, when the rep had left.
--   Re-read by a reader that can read Arabic plates, the rest show no readable name — a hospital
--   front, a blank door, a blurred street — and only a new photo of that door can fix them.
--   So the signboard is read at the door like the timetable (his 2026-10-17 rule, "3 tries then held
--   to confirmation by admin"), counted here per rep, per customer, per Cairo day; and the old places
--   are sent back to their rep, who replaces the photo through the function below.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_retake_place_signboard(jsonb);
--   delete from public.phoenix_crm_refused_readings
--     where reason in ('signboard_unreadable', 'signboard_no_plate');
--   drop index if exists public.phoenix_crm_refused_readings_signboard_idx;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint if exists phoenix_crm_refused_readings_signboard_key_check;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint phoenix_crm_refused_readings_reason_check;
--   alter table public.phoenix_crm_refused_readings
--     add constraint phoenix_crm_refused_readings_reason_check
--     check (reason = any (array['no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text,
--                                'timetable_unreadable'::text, 'timetable_missing'::text]));
--   alter table public.phoenix_crm_refused_readings drop column signboard_key;
--   Additive in full. A photo replaced through the function is recoverable from its
--   'place_signboard_retaken' event, which keeps the replaced photo_path and signboard_check.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This writes no rows and deletes nothing.

begin;
set local lock_timeout = '5s';

-- 1 ─ The door's count of refused signboard photos ──────────────────────────────────────────────

alter table public.phoenix_crm_refused_readings
  add column if not exists signboard_key text;

comment on column public.phoenix_crm_refused_readings.signboard_key is
  'What a refused SIGNBOARD photo was taken for (place:<id>, customer:<id> or name:<folded name>), for reason signboard_unreadable / signboard_no_plate only. Null for every other reason. See src/lib/phoenix-crm/signboard-rules.ts, signboardDoorAction.';

alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_reason_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_reason_check
  check (reason = any (array[
    'no_fix'::text,
    'rough'::text,
    'off_listing'::text,
    'blocked'::text,
    'timetable_unreadable'::text,
    'timetable_missing'::text,
    'signboard_unreadable'::text,
    'signboard_no_plate'::text
  ]));

-- Half of the pairing, as the timetable's: no other reason may carry a key. The other half — a signboard
-- row always names one — is the writer's (`recordSignboardRefusal` refuses to write without it).
alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_signboard_key_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_signboard_key_check
  check (
    reason = any (array['signboard_unreadable'::text, 'signboard_no_plate'::text])
    or signboard_key is null
  );

-- The door's count: this key, this rep, this Cairo day.
create index if not exists phoenix_crm_refused_readings_signboard_idx
  on public.phoenix_crm_refused_readings (signboard_key, rep_hr_id, visit_date)
  where signboard_key is not null;

-- 2 ─ A rep replaces the signboard photo of a place he already has ──────────────────────────────

create or replace function public.phoenix_crm_retake_place_signboard(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_photo text := nullif(trim(coalesce(p ->> 'photo_path', '')), '');
  v_check jsonb := p -> 'signboard_check';
  v_place public.phoenix_crm_places%rowtype;
begin
  if v_seat is null or v_actor is null or v_photo is null or nullif(p ->> 'place_id', '') is null
     or v_check is null or jsonb_typeof(v_check) <> 'object' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select pl.* into v_place
  from public.phoenix_crm_places pl
  where pl.id = (p ->> 'place_id')::uuid
    and pl.seat_id = v_seat
    and pl.is_test = v_is_test
  for update;
  if not found or v_place.status <> 'active' then
    raise exception 'phoenix_crm:place_not_found';
  end if;
  -- A seated customer's photo is the BUILDING's timetable, replaced at the venue — never here.
  if v_place.shared_place_id is not null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The same slot discipline every photograph in this module goes through: issued by this server to
  -- THIS person for THIS territory, single-use, and no older than its slot allows.
  perform public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'place', v_is_test);

  -- Only the photograph and what was read in it. The location stays frozen (20260923020000), and
  -- captured_at stays the day the place was validated.
  update public.phoenix_crm_places pl
  set photo_path = v_photo,
      signboard_check = v_check
  where pl.id = v_place.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_place.customer_id, v_place.id, 'place_signboard_retaken', v_actor,
    jsonb_build_object(
      'photo_path', v_photo,
      'before_photo_path', v_place.photo_path,
      'before_signboard_check', v_place.signboard_check,
      'verdict', v_check ->> 'verdict'
    ),
    v_is_test
  );

  return jsonb_build_object('place_id', v_place.id, 'customer_id', v_place.customer_id);
end;
$$;

revoke execute on function public.phoenix_crm_retake_place_signboard(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_retake_place_signboard(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
