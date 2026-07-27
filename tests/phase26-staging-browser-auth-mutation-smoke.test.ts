import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase26StagingBrowserAuthMutationSmokeTests() {
  const smoke = readFileSync("scripts/phase26-staging-browser-auth-mutation-smoke.ts", "utf8");

  assert.match(smoke, /chromium/);
  assert.match(smoke, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  // The approved staging target must come from the environment and fail closed when absent.
  // Pinning a literal ref here is what let the retired sandbox rot in place unnoticed.
  assert.match(smoke, /PHOENIX_APPROVED_STAGING_REF is required/);
  assert.doesNotMatch(smoke, /= "oaifhavixhdtwmseshff"/);
  assert.match(smoke, /blockedProductionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(smoke, /PHOENIX_STAGING_DATABASE_URL/);
  assert.match(smoke, /PHASE26-/);

  assert.match(smoke, /auth\/v1\/token\?grant_type=password/);
  assert.match(smoke, /phoenix_supabase_access_token/);
  assert.match(smoke, /phoenix_supabase_refresh_token/);
  assert.match(smoke, /rest\/v1/);

  assert.match(smoke, /create table if not exists public\.employee_probation/);
  assert.match(smoke, /create table if not exists public\.v2_vacation_requests/);
  assert.match(smoke, /alter table public\.employee_probation enable row level security/);
  assert.match(smoke, /alter table public\.v2_vacation_requests enable row level security/);
  assert.match(smoke, /revoke all on table public\.employee_probation from public, anon/);
  assert.match(smoke, /revoke all on table public\.v2_vacation_requests from public, anon/);
  assert.match(smoke, /current_access_can_manage_employees/);
  assert.match(smoke, /current_access_can_manage_payroll/);
  assert.match(smoke, /current_access_can_see_employee/);
  assert.match(smoke, /current_access_scope\(\) in \('TEAM', 'HIERARCHY'\)/);

  assert.match(smoke, /Employee browser token cannot create employee master rows/);
  assert.match(smoke, /HR browser token can create disposable employee fixture/);
  assert.match(smoke, /Super Admin browser token can create disposable employee fixture/);
  assert.match(smoke, /Finance browser token can create disposable expense fixture/);
  assert.match(smoke, /Employee browser token cannot mutate payroll expense/);
  assert.match(smoke, /HR browser token can create disposable probation fixture/);
  assert.match(smoke, /Employee browser token cannot self-mutate probation decisions/);
  assert.match(smoke, /Employee browser token can create own vacation request/);
  assert.match(smoke, /Employee browser token cannot create vacation for another employee/);
  assert.match(smoke, /Manager browser token cannot approve vacation outside team/);

  assert.match(smoke, /api\/dev-auth/);
  assert.match(smoke, /Employee app API cannot create employee/);
  assert.match(smoke, /Employee app API cannot import approved expenses/);
  assert.match(smoke, /Employee app API cannot run probation workflow/);
  assert.match(smoke, /Employee app API cannot approve vacation/);

  assert.match(smoke, /cleanupPhase26Fixtures/);
  assert.match(smoke, /delete from public\.employees/);
  assert.match(smoke, /delete from public\.payroll_expenses/);
  assert.match(smoke, /delete from public\.employee_probation/);
  assert.match(smoke, /delete from public\.v2_vacation_requests/);
  assert.match(smoke, /readPhase26Residue/);
  assert.doesNotMatch(smoke, /raw_user_meta_data/);
}
