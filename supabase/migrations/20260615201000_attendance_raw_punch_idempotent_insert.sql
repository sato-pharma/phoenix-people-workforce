-- Idempotent raw-punch insert for the fingerprint attendance agent.
--
-- Background: the local ZKTeco agent re-pushes punch batches (overlapping sync
-- windows, retries). Uniqueness is enforced by two partial indexes:
--   attendance_raw_punches_idempotency_typed_idx     (..., punch_type) WHERE punch_type IS NOT NULL
--   attendance_raw_punches_idempotency_null_type_idx (...)            WHERE punch_type IS NULL
--
-- The previous ingestion path did a plain INSERT and caught the resulting
-- 23505 in the app. Dedupe worked, but Postgres still logged an ERROR for every
-- re-pushed punch (many per second), drowning out real errors in the logs.
--
-- This function performs the same single-row insert with a bare
-- ON CONFLICT DO NOTHING (no conflict target, so it covers BOTH partial
-- idempotency indexes). Re-pushed punches are silently ignored at the database
-- level with no error logged. Returns the new id, or NULL when the punch
-- already existed -- the caller uses that to count inserted vs duplicate.
--
-- SECURITY INVOKER (default): the only caller is the server-side service_role
-- client, which already holds INSERT on the table and bypasses RLS. Execute is
-- locked to service_role to match the table's grants.

create or replace function public.phx_insert_attendance_raw_punch(
  p_device_id text,
  p_device_user_id text,
  p_employee_hr_id text,
  p_punch_time timestamptz,
  p_punch_type text,
  p_verify_mode text,
  p_raw_payload jsonb,
  p_source_run_id text
)
returns bigint
language sql
as $$
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
  values (
    p_device_id,
    p_device_user_id,
    p_employee_hr_id,
    p_punch_time,
    p_punch_type,
    p_verify_mode,
    coalesce(p_raw_payload, '{}'::jsonb),
    p_source_run_id,
    now()
  )
  on conflict do nothing
  returning id;
$$;

revoke all on function public.phx_insert_attendance_raw_punch(
  text, text, text, timestamptz, text, text, jsonb, text
) from public;
grant execute on function public.phx_insert_attendance_raw_punch(
  text, text, text, timestamptz, text, text, jsonb, text
) to service_role;

comment on function public.phx_insert_attendance_raw_punch(
  text, text, text, timestamptz, text, text, jsonb, text
) is
  'Idempotent single raw-punch insert for the fingerprint attendance agent. Uses ON CONFLICT DO NOTHING so re-pushed punches are silently ignored at the database level (no duplicate-key ERROR logged). Returns the new id, or NULL when the punch already existed.';
