-- Recruitment / ATS — harden the ats_candidate_source_context view.
--
-- The previous migration (20260726154207) created it as a plain view, which Postgres runs with
-- the DEFINER's privileges — so it bypasses the row-level security on the underlying
-- ats_cv_intake_events table. The Supabase security advisor correctly flags that as
-- `security_definer_view` (ERROR): because this repo's public schema default-grants SELECT to the
-- authenticated role, the view would be readable via PostgREST and could leak applicant PII
-- (email subjects, sender phone/email, the buffered WhatsApp message text) to any signed-in user.
--
-- It is only ever read server-side through the service-role client (recruitmentDb), which bypasses
-- RLS regardless, so nothing legitimate needs anon/authenticated access. Two-part fix, matching the
-- repo's existing view-hardening pattern (see secure_public_views_security_invoker):
--   1. security_invoker = true — the view runs as the QUERYING role, so it respects
--      ats_cv_intake_events' RLS instead of bypassing it.
--   2. revoke SELECT from anon/authenticated — so PostgREST does not expose it at all; only
--      service_role (and the table owner) can read it.

alter view public.ats_candidate_source_context set (security_invoker = true);

revoke all on public.ats_candidate_source_context from anon, authenticated;
