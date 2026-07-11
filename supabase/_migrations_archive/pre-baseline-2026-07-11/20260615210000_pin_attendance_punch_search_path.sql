-- ============================================================================
-- Pin search_path on phx_insert_attendance_raw_punch
-- ----------------------------------------------------------------------------
-- Finding (Low, security advisor 0011 function_search_path_mutable): the
-- attendance raw-punch idempotent-insert function (added 2026-06-15 by
-- 20260615121752_attendance_raw_punch_idempotent_insert) has no fixed
-- search_path, so object resolution depends on the caller's session
-- search_path. This pins it, matching the pattern already used by
-- pin_function_search_path (private.phx_exec_source, generate_report_it_number,
-- phx_sos_try_date, report_it_set_updated_at).
--
-- The function is SECURITY INVOKER and language sql, so practical risk is low,
-- but the advisor expects an explicit search_path. `public, pg_temp` covers
-- every object it references (attendance tables live in public; the rest are
-- pg_catalog built-ins, always implicitly resolved first). ALTER FUNCTION ...
-- SET search_path does not change behaviour beyond pinning resolution.
-- Reversible with: alter function ... reset search_path;
--
-- Verified live signature (ref ozucdzovmcqvepbozvqf):
--   public.phx_insert_attendance_raw_punch(
--     text, text, text, timestamptz, text, text, jsonb, text)
-- ============================================================================

alter function public.phx_insert_attendance_raw_punch(
  text, text, text, timestamp with time zone, text, text, jsonb, text
) set search_path = public, pg_temp;
