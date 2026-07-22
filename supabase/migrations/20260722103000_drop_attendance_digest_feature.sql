-- Drop the weekly attendance digest / self-settlement feature.
-- Paused in production since 2026-07-03 (live incident); owner has now
-- requested a full teardown of the feature, code and data.
-- SAFE: intentional full teardown of a deprecated feature, explicitly owner-approved;
-- all corresponding application code is removed in the same delivery.
--
-- FK-safe order: children before parents.
--   attendance_missing_punch_verifications, attendance_settlements -> FK to attendance_digest_lines
--   attendance_digest_flags, attendance_digest_lines             -> FK to attendance_weekly_digests (cascade)
--   attendance_digest_settings                                   -> standalone singleton config

drop table if exists public.attendance_missing_punch_verifications;
drop table if exists public.attendance_settlements;
drop table if exists public.attendance_digest_flags;
drop table if exists public.attendance_digest_lines;
drop table if exists public.attendance_weekly_digests;
drop table if exists public.attendance_digest_settings;

-- Trigger function only used by attendance_settlements' immutability trigger,
-- which is dropped along with the table above; the function object itself
-- is not auto-dropped and must be removed explicitly.
drop function if exists public.phx_attendance_settlement_immutable();
