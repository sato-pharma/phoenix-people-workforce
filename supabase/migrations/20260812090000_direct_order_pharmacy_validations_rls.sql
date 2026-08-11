-- MIGRATION-LEDGER DRIFT — NOT a production exposure. The ledger never enables RLS on
-- direct_order_pharmacy_validations, so any environment REBUILT FROM MIGRATIONS (staging, or a
-- future clone) creates it unprotected. Production is and has been service-role-only.
--
-- VERIFIED AGAINST LIVE PRODUCTION 2026-08-12, not the ledger:
--   rls_enabled = true · policies = 1 (ALL, naming service_role only)
--   relacl      = {postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--   has_table_privilege('anon', …, 'SELECT'/'INSERT') = false, false
-- anon and authenticated appear nowhere in the ACL. Nothing was ever readable or writable with the
-- public anon key. An earlier draft of this file said otherwise; that claim was wrong and is
-- retracted here so the permanent record does not assert a breach that did not happen.
--
-- HOW THE LEDGER DRIFTED. The table was created 2026-08-05
-- (20260805024500_direct_order_pharmacy_validation.sql:17) — FOUR DAYS BEFORE
-- 20260809130000_public_default_privileges_revoke_anon.sql removed the `public` schema default.
-- Per that migration's own measurement, every table born in `public` before it inherited
-- anon=arwdDxtm authenticated=arwdDxtm — full SELECT/INSERT/UPDATE/DELETE/TRUNCATE — and, quoting
-- it directly: "Every real application table survives that only because it also has RLS enabled,
-- which fail-closes the grant."
--
-- In the LEDGER this table has no such fail-close. It was also missed by the revoke sweep in
-- 20260809170000_revoke_inert_anon_grants.sql:55-64, which lists the module's other six tables.
-- Production escaped it because RLS was enabled there out-of-band; the migrations never recorded it.
--
-- WHAT WOULD BE AT RISK IN A REBUILT ENVIRONMENT — the reason this is worth a migration rather than
-- a note. Rows carry requested_by_hr_id, captured_latitude / captured_longitude /
-- captured_accuracy_meters / captured_address (where a NAMED REP was physically standing when they
-- photographed a pharmacy), claimed_pharmacy_name / claimed_doctor_name / claimed_address, and
-- storage_path. The evidence bucket itself is private (public = false), so a leaked storage_path
-- alone would not yield the photograph without a server-minted signed URL — but the GPS trail and
-- the HR_ID linkage would be readable, and the table writable. None of that happened in production.
--
-- THIS IS THE THIRD INSTANCE OF THIS EXACT SHAPE in this repo: 20260806010000_share_links_rls_parity.sql
-- fixed direct_order_report_share_links and names backup_employee_crm_identity_20260805 as its own
-- precedent. Matching the module's established posture: RLS enabled, service-role only. (Production
-- additionally carries one service_role-named ALL policy on this table and on
-- direct_order_report_share_links; the module's other six tables carry none. Both shapes deny anon
-- and authenticated, which is the invariant that matters — see docs/specs/direct-orders.md.)

begin;

alter table public.direct_order_pharmacy_validations enable row level security;

-- Belt and braces, exactly as 20260809170000 did for the sibling tables. RLS alone fail-closes the
-- inherited grant, but leaving a live grant behind means the next person to add a policy for an
-- unrelated reason silently re-opens anon access.
revoke all on public.direct_order_pharmacy_validations from anon;
revoke all on public.direct_order_pharmacy_validations from authenticated;

comment on table public.direct_order_pharmacy_validations is
  'Pharmacy validation claims with GPS-stamped storefront evidence. RLS enabled, service-role only, '
  'like every other direct_order_* table: no policy names anon or authenticated. The browser never '
  'reads this directly; the server uses getSupabaseAdmin(). Do not add a policy without re-reading '
  '20260812090000_direct_order_pharmacy_validations_rls.sql.';

notify pgrst, 'reload schema';

commit;
