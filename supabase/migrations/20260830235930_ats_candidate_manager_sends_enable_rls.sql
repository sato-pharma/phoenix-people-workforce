-- Turn RLS on for public.ats_candidate_manager_sends -- the one table in production `public` that
-- still has it off.
--
-- WHY THIS FILE EXISTS. Measured on production (ozucdzovmcqvepbozvqf) 2026-08-30 from pg_catalog,
-- not from the migration ledger: of 21 `ats_*` tables, 20 have relrowsecurity = true and exactly
-- one does not, and it is the only RLS-off table in the whole of `public` (count over pg_class
-- where relkind='r' and not relrowsecurity returned 1). scripts/check-schema-shape.ts raises
-- `rls_disabled` on it at severity "warning", and after
-- 20260830133000_move_adhoc_pre_images_out_of_public.sql relocated the five ad-hoc pre-images it
-- is the sole remaining name in that warning.
--
-- WAS IT DELIBERATE? No. The evidence is the same author, the same feature and the same day:
--
--   20260830220000_candidate_manager_sends.sql          <- this table. No RLS, no policy, no grant.
--   20260830223000_candidate_manager_comments.sql       <- RLS on + service_role policy + grant.
--   20260830234500_candidate_manager_folders.sql        <- RLS on + service_role policy + grant.
--
-- All three were written in one sitting (PR #2765 and its followers), all three are children of
-- ats_candidates, and all three are read and written only through the service-role client. The two
-- written LATER both carry the posture; the first one does not. Elsewhere the pattern is stated
-- outright -- 20260827213000 says of ats_candidate_views that "a policy-less RLS-enabled table is
-- the correct closed default rather than an oversight", and 20260830124500 says of
-- ats_whatsapp_outbound_messages that "RLS is not optional here". Nothing anywhere argues for
-- leaving it off. This is the first file of a batch missing what the rest of the batch has.
--
-- WHY IT IS WORTH CLOSING EVEN THOUGH NOTHING IS EXPOSED TODAY. Measured before writing this:
-- relacl is {postgres, service_role} only, and has_table_privilege(anon,'SELECT') and
-- has_table_privilege(authenticated,'SELECT') are both false -- so the ERROR-severity
-- `exposed_without_rls` rule does not fire and there is no live breach. The warning's own text is
-- the argument: not a breach "while no browser-facing role can reach them, but it removes the
-- safety net if a grant is ever added". `public` is the only schema PostgREST serves, and three
-- tables in this very family (ats_candidate_cv_extractions, ats_cv_intake_events,
-- ats_email_intake_cursors) DO carry anon and authenticated grants from an earlier era of Supabase
-- default privileges -- they are safe purely because RLS is on. That is precisely the net this
-- table is missing, and these rows say which named manager was sent which job applicant's CV.
--
-- PROVABLY A NO-OP FOR THE APPLICATION. Verified against production before applying:
--   * service_role has rolbypassrls = true, so RLS is not consulted for it at all;
--   * every read and write goes through recruitmentDb() -> getSupabaseAdmin(), which is built from
--     SUPABASE_SERVICE_ROLE_KEY (src/lib/supabase/server.ts:144);
--   * 0 views, 0 functions and 0 user triggers reference the table, so there is no SECURITY DEFINER
--     or view path that would reach it under a different role;
--   * anon, authenticated and authenticator all have rolbypassrls = false, so the policy below
--     genuinely closes them out rather than merely appearing to.
-- This matches AGENTS.md 8: visibility in this app is application-scoped, not RLS-scoped.
--
-- POLICY SHAPE. Copied statement for statement from the two same-day siblings above, so the three
-- tables of one feature end up identical. A service_role-only policy is belt-and-braces given the
-- bypass, but it is what the siblings carry and a policy-less table is harder to read as
-- intentional later. Per AGENTS.md, "RLS on with no `authenticated` grant is the NORM here -- 222
-- of 308 tables", so no anon/authenticated policy is wanted and adding one would be a widening.
--
-- The revoke follows 20260830124500's precedent and is a no-op today (neither role holds anything).
-- It is named-role only, never `from public`: a `revoke ... from public` against a default ACL also
-- strips service_role, which is the role the application connects as.
--
-- Re-running is safe: `enable row level security` is idempotent, the policy is dropped before it is
-- created, and grant/revoke are idempotent.
--
-- ROLLBACK, if this ever needs undoing:
--   alter table public.ats_candidate_manager_sends disable row level security;
--   drop policy if exists phx_ats_candidate_manager_sends_service_role
--     on public.ats_candidate_manager_sends;
-- No row is read, written or deleted by this file; the table's 40 rows are untouched.
--
-- Deliberately NOT guarded by to_regclass. Migrations run in filename order, so
-- 20260830220000_candidate_manager_sends.sql has always created the table first; if that is ever
-- untrue this should fail loudly rather than silently record itself as applied and leave the table
-- unprotected -- which is exactly the drift this file exists to remove.

begin;

alter table public.ats_candidate_manager_sends enable row level security;

drop policy if exists phx_ats_candidate_manager_sends_service_role
  on public.ats_candidate_manager_sends;
create policy phx_ats_candidate_manager_sends_service_role
  on public.ats_candidate_manager_sends
  to service_role using (true) with check (true);

grant all on table public.ats_candidate_manager_sends to service_role;

-- Deliberately NO grant to anon or authenticated. Every read goes through the service-role client
-- behind a route that has already proved the viewer's place in the org chart, and these rows record
-- which job applicants a named manager was asked to review.
revoke all on table public.ats_candidate_manager_sends from anon, authenticated;

commit;
