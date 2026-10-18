-- attendance_raw_punch_batch_insert
--
-- WHAT THIS CHANGES: adds public.phx_insert_attendance_raw_punches(p_rows jsonb) returns integer — the
--   BATCH form of phx_insert_attendance_raw_punch. One INSERT ... SELECT over a jsonb array of punches
--   with a bare ON CONFLICT DO NOTHING (no conflict target, so it covers BOTH partial idempotency
--   indexes, exactly as the single-row function does). Returns how many rows were newly inserted; the
--   caller counts the rest of the batch as already-present duplicates. Additive: nothing is dropped,
--   altered or rewritten, and the single-row function stays as the fallback.
-- WHY: /api/attendance/raw-punches called the single-row function once per punch, 50 at a time. On
--   18 Oct 2026 between 10:16 and 10:33 Cairo that was 10,461 calls — a replay of punches the table
--   already held, which inserted almost nothing — while production was entering the slowdown that,
--   between 10:30 and 11:55, timed out the login check for the Talent Acquisition seat. A 1,000-punch
--   request now costs about four calls instead of up to a thousand.
-- ROLLBACK: drop function public.phx_insert_attendance_raw_punches(jsonb);
--   (the route falls back to the single-row function by itself when this one is missing or errors.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive and non-destructive; it writes no data when applied.

begin;

create or replace function public.phx_insert_attendance_raw_punches(p_rows jsonb)
returns integer
language sql
set search_path to 'public', 'pg_temp'
as $$
  with inserted as (
    insert into public.attendance_raw_punches (
      device_id,
      device_user_id,
      employee_hr_id,
      punch_time,
      punch_type,
      verify_mode,
      raw_payload,
      source_run_id,
      ingested_at
    )
    select
      r.device_id,
      r.device_user_id,
      r.employee_hr_id,
      r.punch_time,
      r.punch_type,
      r.verify_mode,
      coalesce(r.raw_payload, '{}'::jsonb),
      r.source_run_id,
      now()
    from jsonb_to_recordset(p_rows) as r(
      device_id text,
      device_user_id text,
      employee_hr_id text,
      punch_time timestamptz,
      punch_type text,
      verify_mode text,
      raw_payload jsonb,
      source_run_id text
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$$;

-- Same posture as the single-row function and the table: service_role only. `from public` alone is
-- not enough on Supabase (default privileges grant EXECUTE straight to anon and authenticated), so
-- those are revoked by name as well.
revoke all on function public.phx_insert_attendance_raw_punches(jsonb) from public, anon, authenticated;
grant execute on function public.phx_insert_attendance_raw_punches(jsonb) to service_role;

comment on function public.phx_insert_attendance_raw_punches(jsonb) is
  'Idempotent BATCH raw-punch insert for the fingerprint attendance agent: p_rows is a jsonb array of {device_id, device_user_id, employee_hr_id, punch_time, punch_type, verify_mode, raw_payload, source_run_id}. ON CONFLICT DO NOTHING skips punches the table already holds; returns the number of rows newly inserted.';

commit;
