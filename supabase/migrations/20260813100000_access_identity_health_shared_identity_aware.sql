-- v_access_identity_health: stop reporting a shared-identity ALIAS account as a person with no login.
--
-- THE REPORTED SYMPTOM. After 20260812190000 removed the terminal-status false positives, both
-- projects reported exactly one issue:
--     active_employee_without_auth_user | ADMIN-HR | {"employee_status": "active"}
--
-- THIS IS NOT A DATA BUG, and ADMIN-HR must NOT be retired to silence it. Investigated 2026-08-13:
--
--   public.employees has TWO rows, byte-identical in every meaningful field —
--     ADMIN-HR  created 2026-05-15   full_name 'Phoenix System Administrator'
--     PHX-1     created 2026-06-29   full_name 'Phoenix System Administrator'
--   both job_title 'System Administrator', both active, both payroll_eligible=false and
--   organogram_visible=false, neither referenced as anybody's manager.
--   The login `admin-HR` in app_auth_users carries hr_id = 'PHX-1'.
--
-- ADMIN-HR is the artifact of the completed admin identity remediation
-- (docs/security/production-blocker-remediation-plan.md step 6, "create only the minimal dedicated
-- system employee row", which recommended the HR_ID `admin-HR`). PHX-1 superseded it six weeks
-- later. Both are then DECLARED ALIASES of canonical B-10 in src/lib/auth/identity-aliases.ts —
-- "the single source of truth for 'these HR_IDs are the same human'" — whose header states plainly
-- that the aliases are DELIBERATELY not collapsed at the data layer, because doing so "would make
-- the system-admin employee row unreachable and would silently rewrite stored HR_IDs", and because
-- historic rows must keep their original HR_ID so an audit trail still shows which console acted.
--
-- So two employee rows for one human is the intended design. The defect is that this VIEW has no
-- concept of shared identity, and therefore reports an alias account as a person who cannot sign in.
-- The human behind ADMIN-HR signs in perfectly well — as `admin-HR`, which resolves to PHX-1.
--
-- THE FIX. The branch now asks the right question. Not "does a login exist for THIS hr_id?" but
-- "does a login exist for anyone in this hr_id's shared-identity group?". Encoded as a CTE, so a
-- future group is one more row rather than new logic.
--
-- ── THE DUPLICATION THIS INTRODUCES, STATED PLAINLY ───────────────────────────────────────────
-- identity-aliases.ts calls itself the single source of truth, and this migration puts a second
-- copy of one group into SQL. That is a real cost and it is accepted deliberately: a view cannot
-- read TypeScript, the alternative was leaving a permanent known-false-positive in a health check
-- (which is exactly how the 18 terminal-status false positives made this check unreadable), and
-- adding a group to identity-aliases.ts already requires explicit owner confirmation, so the two
-- lists cannot drift silently through routine work.
--
-- IF YOU ADD A GROUP TO sharedIdentityGroups IN src/lib/auth/identity-aliases.ts, ADD IT HERE TOO.
--
-- REJECTED ALTERNATIVE, for the record: filtering on `not organogram_visible and not
-- payroll_eligible` would need no alias list and would cover this row — but
-- src/lib/imports/employee-lifecycle.ts documents that active executives and advisors are
-- payroll_eligible=false and that intentionally-hidden nodes are organogram_visible=false, so that
-- predicate would silently stop flagging real people with no login. Under-reporting in a detector
-- is worse than over-reporting; same reasoning as the deny-list in 20260812190000.
--
-- CREATE OR REPLACE with `with (security_invoker = true)` restated — the live view carries it on
-- both projects and a bare create-or-replace SILENTLY STRIPS IT (see 20260801104500). Replace also
-- preserves the grants that drop+create would discard.
--
-- Rollback: re-apply 20260812190000, which is this definition without the shared_identity CTE.

begin;

create or replace view public.v_access_identity_health
  with (security_invoker = true)
as
 WITH active_profiles AS (
         SELECT user_access_profiles.auth_user_id,
            lower(TRIM(BOTH FROM COALESCE(user_access_profiles.hr_id, ''::text))) AS hr_key,
            lower(TRIM(BOTH FROM COALESCE(user_access_profiles.login_id, ''::text))) AS login_key,
            count(*) OVER (PARTITION BY user_access_profiles.auth_user_id) AS auth_user_active_profile_count,
            count(*) OVER (PARTITION BY (lower(TRIM(BOTH FROM COALESCE(user_access_profiles.hr_id, ''::text))))) AS hr_id_active_profile_count,
            count(*) OVER (PARTITION BY (lower(TRIM(BOTH FROM COALESCE(user_access_profiles.login_id, ''::text))))) AS login_id_active_profile_count
           FROM user_access_profiles
          WHERE COALESCE(user_access_profiles.is_active, true) = true
        ), shared_identity AS (
         -- MIRROR of sharedIdentityGroups in src/lib/auth/identity-aliases.ts. person_key is the
         -- canonical HR_ID; one row per HR_ID in the group, including the canonical one. Keys are
         -- lower/trimmed to match how this view compares HR_IDs everywhere else.
         --   B-10 (Omar Anwar Gawish) = PHX-1 = admin-HR — HR Manager and the Phoenix
         --   system-administrator console are the same person (owner confirmation 2026-07-04,
         --   re-confirmed 2026-07-25).
         SELECT 'b-10'::text AS person_key, unnest(ARRAY['b-10'::text, 'phx-1'::text, 'admin-hr'::text]) AS hr_key
        )
 SELECT 'duplicate_active_auth_user_profile'::text AS issue_type,
    active_profiles.auth_user_id::text AS entity_key,
    jsonb_build_object('count', active_profiles.auth_user_active_profile_count) AS details
   FROM active_profiles
  WHERE active_profiles.auth_user_id IS NOT NULL AND active_profiles.auth_user_active_profile_count > 1
UNION ALL
 SELECT 'duplicate_active_hr_id_profile'::text AS issue_type,
    active_profiles.hr_key AS entity_key,
    jsonb_build_object('count', active_profiles.hr_id_active_profile_count) AS details
   FROM active_profiles
  WHERE active_profiles.hr_key <> ''::text AND active_profiles.hr_id_active_profile_count > 1
UNION ALL
 SELECT 'duplicate_active_login_id_profile'::text AS issue_type,
    active_profiles.login_key AS entity_key,
    jsonb_build_object('count', active_profiles.login_id_active_profile_count) AS details
   FROM active_profiles
  WHERE active_profiles.login_key <> ''::text AND active_profiles.login_id_active_profile_count > 1
UNION ALL
 SELECT 'active_employee_without_auth_user'::text AS issue_type,
    e.hr_id AS entity_key,
    jsonb_build_object('employee_status', e.employment_status) AS details
   FROM employees e
  WHERE NULLIF(TRIM(BOTH FROM COALESCE(e.hr_id, ''::text)), ''::text) IS NOT NULL AND (lower(COALESCE(e.employment_status, 'active'::text)) <> ALL (ARRAY['resigned'::text, 'terminated'::text, 'inactive'::text, 'left'::text, 'historical_payroll_record'::text, 'system_placeholder'::text])) AND NOT (EXISTS ( SELECT 1
           FROM app_auth_users a
          WHERE lower(TRIM(BOTH FROM COALESCE(a.hr_id, ''::text))) = lower(TRIM(BOTH FROM e.hr_id))))
    -- ...and nobody sharing this person's identity holds a login either.
    AND NOT (EXISTS ( SELECT 1
           FROM shared_identity mine
             JOIN shared_identity theirs ON theirs.person_key = mine.person_key
             JOIN app_auth_users a2 ON lower(TRIM(BOTH FROM COALESCE(a2.hr_id, ''::text))) = theirs.hr_key
          WHERE mine.hr_key = lower(TRIM(BOTH FROM e.hr_id))))
UNION ALL
 SELECT 'auth_user_without_employee'::text AS issue_type,
    a.login_id AS entity_key,
    jsonb_build_object('hr_id', a.hr_id, 'role', a.role) AS details
   FROM app_auth_users a
  WHERE NULLIF(TRIM(BOTH FROM COALESCE(a.hr_id, ''::text)), ''::text) IS NOT NULL AND NOT (EXISTS ( SELECT 1
           FROM employees e
          WHERE lower(TRIM(BOTH FROM COALESCE(e.hr_id, ''::text))) = lower(TRIM(BOTH FROM a.hr_id))))
UNION ALL
 SELECT 'auth_user_missing_role'::text AS issue_type,
    a.login_id AS entity_key,
    jsonb_build_object('hr_id', a.hr_id) AS details
   FROM app_auth_users a
  WHERE NULLIF(TRIM(BOTH FROM COALESCE(a.role, ''::text)), ''::text) IS NULL;

comment on view public.v_access_identity_health is
  'Identity-layer health: duplicate active profiles, employees with no login, logins with no '
  'employee, logins with no role. The active-employee branch excludes terminal lifecycle statuses '
  '(resigned, terminated, inactive, left, historical_payroll_record, system_placeholder) AND excludes '
  'shared-identity alias accounts whose person already holds a login elsewhere — see the '
  'shared_identity CTE, which mirrors sharedIdentityGroups in src/lib/auth/identity-aliases.ts. Add a '
  'group there and you must add it here too. Kept as a deny-list on purpose: a missed terminal status '
  'over-reports (visible), while an allow-list that missed an active status would hide a real person '
  'with no login.';

-- ── VERIFY ────────────────────────────────────────────────────────────────────────────────────
do $verify$
declare
  invoker text;
  missing_grants int;
  alias_rows int;
begin
  select array_to_string(reloptions, ',') into invoker
  from pg_class where oid = 'public.v_access_identity_health'::regclass;
  if invoker is null or position('security_invoker=true' in invoker) = 0 then
    raise exception 'security_invoker is no longer set (reloptions=%) — the replace stripped it. Rolling back.',
      coalesce(invoker, '(null)');
  end if;

  select count(*) into missing_grants
  from unnest(array['service_role', 'authenticated']) as g(role_name)
  where not has_table_privilege(g.role_name, 'public.v_access_identity_health', 'SELECT');
  if missing_grants > 0 then
    raise exception '% expected grantee(s) lost SELECT — rolling back.', missing_grants;
  end if;

  -- The fix itself: no declared alias may be reported as an employee without a login, on any
  -- project where that person does hold a login somewhere.
  if exists (
    select 1 from public.v_access_identity_health
    where issue_type = 'active_employee_without_auth_user'
      and lower(btrim(entity_key)) in ('b-10', 'phx-1', 'admin-hr')
  ) then
    raise exception
      'a declared shared-identity alias is still reported as an employee without a login — rolling back.';
  end if;

  -- Guard against the CTE silently matching nothing (a typo in the key list would look like success).
  select count(*) into alias_rows
  from public.employees e
  where lower(btrim(e.hr_id)) in ('b-10', 'phx-1', 'admin-hr');
  if alias_rows = 0 then
    raise warning
      'no employees row matches any declared alias HR_ID — the shared_identity CTE is inert here. '
      'Expected on an environment without the system-administrator rows; suspicious anywhere else.';
  end if;

  raise notice 'verify: security_invoker intact, grants intact, % alias employee row(s) covered', alias_rows;
end
$verify$;

commit;
