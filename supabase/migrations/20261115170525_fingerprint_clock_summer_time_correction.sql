-- fingerprint_clock_summer_time_correction
--
-- WHAT THIS CHANGES:
--   1. Copies every Head Office fingerprint punch whose device time falls between 2026-10-30 00:00 and
--      2026-11-11 00:00 Cairo (265 rows on 2026-11-15) into attendance_backup_20261115.raw_punches_clock_shift,
--      untouched.
--   2. Moves those punches ONE HOUR EARLIER and records the time the device reported in
--      raw_payload.clock_correction.original_punch_time (device_local_time is left exactly as the device sent it).
--   3. Adds a BEFORE INSERT trigger on attendance_raw_punches that applies the same one-hour correction to any
--      punch from the same device inside the same window that arrives later.
--
-- WHY:
--   Egypt's summer time ended at midnight after Thursday 29 October 2026 and the ZKTeco device
--   (zkteco-main, 192.168.100.52) kept summer time until its clock was put right overnight between
--   10 November 19:13 and 11 November 08:27 (device time). Every punch in between was recorded one hour
--   late: the median first punch of the day moved from ~09:05 (18-29 Oct) to ~10:08 (1-10 Nov) and back to
--   ~09:09 from 11 Nov; the median last punch from ~17:01 to ~18:18 and back. The weekly attendance digest
--   turned that into 67 "late" lines for 1-10 Nov.
--
--   The trigger exists because the agent re-reads the device's WHOLE buffer on every sync, and the device
--   still holds those punches at the wrong time. Without it, the very next sync would insert the wrong-time
--   copies again beside the corrected rows. With it, a re-sent punch is shifted on the way in, lands on the
--   corrected row's key, and the insert's ON CONFLICT DO NOTHING ignores it as a duplicate.
--   No punch is recorded inside the window any more (the device clock is right since 11 Nov), so the
--   trigger only ever meets re-sent copies.
--
-- ROLLBACK:
--   drop trigger attendance_raw_punches_clock_correction on public.attendance_raw_punches;
--   drop function public.phx_attendance_raw_punch_clock_correction();
--   update public.attendance_raw_punches
--      set punch_time = (raw_payload->'clock_correction'->>'original_punch_time')::timestamptz,
--          raw_payload = raw_payload - 'clock_correction'
--    where raw_payload ? 'clock_correction';
--   (the untouched rows are also in attendance_backup_20261115.raw_punches_clock_shift)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- 1. Pre-image, in its own dated schema (never public).
create schema if not exists attendance_backup_20261115;
revoke all on schema attendance_backup_20261115 from public, anon, authenticated;

create table if not exists attendance_backup_20261115.raw_punches_clock_shift as
select *
from public.attendance_raw_punches
where device_id = 'zkteco-main'
  and punch_time >= timestamptz '2026-10-30 00:00:00+02'
  and punch_time <  timestamptz '2026-11-11 00:00:00+02'
  and not (raw_payload ? 'clock_correction');

revoke all on table attendance_backup_20261115.raw_punches_clock_shift from public, anon, authenticated;

-- 2. The trigger function. SECURITY INVOKER: it runs as whoever inserts the punch (service_role).
create or replace function public.phx_attendance_raw_punch_clock_correction()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.device_id = 'zkteco-main'
     and new.punch_time >= timestamptz '2026-10-30 00:00:00+02'
     and new.punch_time <  timestamptz '2026-11-11 00:00:00+02'
     and not (coalesce(new.raw_payload, '{}'::jsonb) ? 'clock_correction')
  then
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb) || jsonb_build_object(
      'clock_correction', jsonb_build_object(
        'minutes', -60,
        'original_punch_time', new.punch_time,
        'reason', 'device clock kept summer time after it ended on 2026-10-29'
      )
    );
    new.punch_time := new.punch_time - interval '1 hour';
  end if;
  return new;
end;
$$;

revoke execute on function public.phx_attendance_raw_punch_clock_correction() from public, anon, authenticated;

drop trigger if exists attendance_raw_punches_clock_correction on public.attendance_raw_punches;
create trigger attendance_raw_punches_clock_correction
before insert on public.attendance_raw_punches
for each row execute function public.phx_attendance_raw_punch_clock_correction();

-- 3. Correct the rows already stored (exactly the rows copied in step 1).
update public.attendance_raw_punches p
   set raw_payload = p.raw_payload || jsonb_build_object(
         'clock_correction', jsonb_build_object(
           'minutes', -60,
           'original_punch_time', p.punch_time,
           'reason', 'device clock kept summer time after it ended on 2026-10-29'
         )
       ),
       punch_time = p.punch_time - interval '1 hour'
  from attendance_backup_20261115.raw_punches_clock_shift b
 where p.id = b.id
   -- Never shift a row twice: a re-applied file finds every row already marked and moves nothing.
   and not (p.raw_payload ? 'clock_correction');

commit;
