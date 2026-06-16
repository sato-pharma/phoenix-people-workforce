-- Backfill the extended columns on outstation_location_audit_logs that exist in
-- production (written by src/lib/outstation/service.ts) but were never captured
-- in a source-controlled migration. Required by 20260615090000_audit_view_security_invoker.sql
-- which references validation_result, validation_reason, and fraud_flags_json.
-- All ADD COLUMN IF NOT EXISTS — idempotent / safe to run on production.

alter table public.outstation_location_audit_logs
  add column if not exists accuracy_check_result text null,
  add column if not exists calculated_distance_km numeric null,
  add column if not exists captured_accuracy_meters numeric null,
  add column if not exists captured_latitude numeric null,
  add column if not exists captured_longitude numeric null,
  add column if not exists distance_km numeric null,
  add column if not exists duration_minutes numeric null,
  add column if not exists fraud_flags_json jsonb null,
  add column if not exists previous_captured_at timestamptz null,
  add column if not exists previous_latitude numeric null,
  add column if not exists previous_longitude numeric null,
  add column if not exists residence_latitude numeric null,
  add column if not exists residence_longitude numeric null,
  add column if not exists speed_check_result text null,
  add column if not exists suspicious_location_score numeric null,
  add column if not exists territory_check_result text null,
  add column if not exists timestamp_check_result text null,
  add column if not exists validation_reason text null,
  add column if not exists validation_result text null;
