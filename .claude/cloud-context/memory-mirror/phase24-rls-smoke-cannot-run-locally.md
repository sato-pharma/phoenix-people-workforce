---
name: phase24-rls-smoke-cannot-run-locally
description: "The phase24 RLS smoke aborts before any check — its env file lists the retired HR Specialist role and its staging test-user passwords are dead"
metadata: 
  node_type: memory
  type: project
  originSessionId: c139b350-0753-43a0-9dd3-00cd120e658d
  modified: 2026-08-12T22:23:33.110Z
---

`scripts/phase24-real-auth-rls-api-smoke.ts` cannot complete a run on this machine, and fails for two
independent reasons — both in the gitignored `.env.staging.rls.local`, so nothing in the repo shows it.
Confirmed 2026-08-13.

1. **Wrong role set.** `parseUsersConfig()` throws
   `PHOENIX_RLS_TEST_USERS_JSON is missing Phase 24 roles: Talent Acquisition` before a single table is
   touched. The JSON still lists **`HR Specialist`**, the role retired by `49dea832`. The 15 configured
   roles are the old set; the script's `roles` array wants the new one.
2. **Dead credentials.** Even for a role that IS present, `signInWithPassword` against staging
   (`cifwmndunmlxjhyjugxa`) returns `Invalid login credentials`. Verified with Medical Rep.

**Why it matters:** this is why the `payroll_expenses` false green survived a month unnoticed — nobody
could run the thing. The script also has **no `package.json` entry** and is not in CI; the only thing
that runs is `tests/phase24-real-auth-rls-api-smoke.test.ts`, which reads the script as *text* and
asserts on its source. So a source-level mistake is caught and a runtime one never is.

**How to apply:** do not claim this smoke passed or failed from a local run — it aborts at startup.
Fixing it needs the owner to supply staging test users (creating auth users in staging is his call, not
a session's). Until then, verify RLS read surfaces directly with `has_table_privilege('authenticated',
oid, 'SELECT')` plus a PostgREST probe, which is what actually distinguishes a missing table
(`PGRST205`, "could not find the table ... in the schema cache") from a denied one (`42501`,
"permission denied for table ...").

## Its table list was stale too — corrected 2026-08-13

The five surfaces it probed dated from commit `7ce1e971` (**2026-05-19**) and three were wrong:

- `payroll_expenses` — renamed to `outstation_expenses` by `20260713120000` a month earlier, so it
  matched nothing and returned "coverage skipped". That is the false green above. Now corrected to
  `outstation_expenses`, which is a genuine authenticated read surface.
- `employee_probation`, `v2_vacation_requests` — service-role-only by design, so demanding an
  authenticated read of them was simply wrong. Moved to a declared `SERVICE_ROLE_ONLY_SURFACES`
  list, reported in the run output. See
  [[rls-policy-without-an-authenticated-grant-is-usually-correct]].

**Declared, not asserted, on purpose:** `scripts/phase25-staging-rls-mutation-smoke.ts` (~lines
291-293) issues `grant select, insert, update, delete` on **both** of those tables to
`authenticated` against this same approved staging project and never revokes it. A negative
assertion in phase24 would therefore go red because a sibling smoke had run, not because anything
broke. phase25/26 also `create table if not exists` them — these scripts were written for a
disposable sandbox they build themselves, which the current 1:1 production clone is not.

The companion `tests/phase24-real-auth-rls-api-smoke.test.ts` only checked that each table name
appeared *somewhere* in the script, which is how a dead name passed for a month; it now parses both
lists and asserts membership.

## RESOLVED 2026-08-13 — it now runs end to end

The 7 roles phase24 needs were provisioned in staging and `PHOENIX_RLS_TEST_USERS_JSON` rewritten
(retired `HR Specialist` key dropped, `Talent Acquisition` added). First real run: **59 passed,
20 failed, 0 skipped.**

**The supported provisioning script does NOT work — do not reach for it first.**
`tests/scripts/prepare-staging-rls-test-users.ts` dies on
`password authentication failed for user "postgres"`: `PHOENIX_STAGING_DATABASE_URL` holds a dead
password, and the DB password is not recoverable (reading project secrets is outside the standing
Supabase grant). Provision over HTTPS instead — `auth.admin.createUser/updateUserById` plus
service-role upserts into `employees` and `user_access_profiles` — using
`PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY`, which is live.

**That script also writes the WRONG `user_access_profiles.role`.** It uses
`mapPhoenixRoleToLegacyBootstrapRole` → `admin`/`manager`/`employee`, but phase24 asserts that column
equals the COARSE role (`super_admin`, `finance`, `company_reader`, `manager`, `employee`) and
`current_access_role()` returns the column verbatim. Write the coarse role or every
`Access profile` check fails.

**Real failures the first run surfaced** (none are the smoke's own fault):
- `employee_probation`, `v2_vacation_requests` — `permission denied` for all 7 roles, no
  authenticated grant. See [[rls-policy-without-an-authenticated-grant-is-usually-correct]].
- `sales_records` — **statement timeout for the 5 scoped roles**; only Super Admin and CEO pass.
  The scoped RLS predicate is too expensive to evaluate, not a permission problem.
- `salary rows stay inside allowed scope` — CEO flagged for 7 rows. **NOT a leak.** All 7 hr_ids
  (`b-20`, `b-21`, `b-87`, `b-89`, `b-90`, `b-93`, `b-121`) are ORPHAN `salary_records` rows with no
  `employees` row; staging holds 12 such rows. The check builds its allowed-set from `employees`, so
  an orphan payroll row is flagged automatically. Fix the check or the data, not the RLS.

`payroll_expenses` still survives in ~8 other `scripts/phase*` files.

Related: [[list-migrations-reports-ledger-not-reality]] · [[merged-migration-file-does-not-mean-grants-are-live]] · [[rls-policy-without-an-authenticated-grant-is-usually-correct]]
