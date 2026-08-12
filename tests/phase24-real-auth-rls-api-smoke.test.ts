import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase24RealAuthRlsApiSmokeTests() {
  const smoke = readFileSync("scripts/phase24-real-auth-rls-api-smoke.ts", "utf8");
  const loginRoute = readFileSync("app/api/auth/login/route.ts", "utf8");
  const rlsServer = readFileSync("src/lib/supabase/rls-server.ts", "utf8");

  assert.match(smoke, /signInWithPassword/);
  assert.match(smoke, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  // The approved staging target must come from the environment and fail closed when absent.
  // Pinning a literal ref here is what let the retired sandbox rot in place unnoticed.
  assert.match(smoke, /PHOENIX_APPROVED_STAGING_REF is required/);
  assert.doesNotMatch(smoke, /= "oaifhavixhdtwmseshff"/);
  assert.match(smoke, /blockedProductionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(smoke, /PHOENIX_RLS_TEST_USERS_JSON/);
  assert.match(smoke, /current_phoenix_role/);
  assert.match(smoke, /current_access_scope/);
  assert.match(smoke, /current_access_can_manage_employees/);
  assert.match(smoke, /current_access_can_manage_payroll/);

  for (const role of [
    "Super Admin",
    "Talent Acquisition",
    "Finance Manager",
    "CEO",
    "District Manager",
    "Medical Rep",
    "Employee",
  ]) {
    assert.match(smoke, new RegExp(role));
  }

  assert.match(smoke, /user_access_profiles/);
  assert.match(smoke, /employees/);
  assert.match(smoke, /salary_records/);
  assert.match(smoke, /"outstation_expenses"/);
  assert.match(smoke, /"outstation_expense_requests"/);
  assert.match(smoke, /"expense_claims"/);
  assert.match(smoke, /sales_records/);
  assert.match(smoke, /employee_probation/);
  assert.match(smoke, /v2_vacation_requests/);

  // payroll_expenses was renamed to outstation_expenses on 2026-07-13. This assertion used to pin
  // the retired name, so the smoke and the test agreed with each other and disagreed with the
  // database for a month. Prose may still explain the rename; naming it as a table must not return.
  assert.doesNotMatch(smoke, /"payroll_expenses"/);

  // A surface the smoke cannot reach must never be recorded as a pass. The old code returned a
  // "coverage skipped" string here and the caller pushed pass() on any non-throw, which is exactly
  // how a deleted table reported green for every role. Pin the throw, the distinct status, and the
  // non-zero exit — dropping any one of the three silently restores the false green.
  assert.doesNotMatch(smoke, /coverage skipped/);
  assert.match(smoke, /class SurfaceUnavailableError/);
  assert.match(smoke, /throw new SurfaceUnavailableError/);
  assert.match(smoke, /instanceof SurfaceUnavailableError/);
  assert.match(smoke, /status: "skipped"/);
  assert.match(smoke, /failed\.length > 0 \|\| skipped\.length > 0/);

  assert.match(smoke, /assertSourceContains\("app\/api\/payroll\/upload\/route\.ts"/);
  assert.match(smoke, /assertPermission\\\(access, "payroll", "import"\\\)/);
  assert.match(smoke, /assertPermission\\\(access, "sales", "import"\\\)/);
  assert.match(smoke, /assertPermission\\\(access, "user_admin", "update"\\\)/);
  assert.doesNotMatch(smoke, /\.insert\(/);
  assert.doesNotMatch(smoke, /\.update\(/);
  assert.doesNotMatch(smoke, /\.delete\(/);

  assert.match(loginRoute, /createSupabaseAuthSession/);
  assert.match(loginRoute, /phoenixSupabaseAccessTokenCookieName/);
  assert.match(loginRoute, /phoenixSupabaseRefreshTokenCookieName/);
  assert.match(loginRoute, /InvalidLoginPayloadError/);
  assert.match(loginRoute, /invalid_request/);
  assert.match(rlsServer, /supabase\.auth\.setSession/);
  assert.match(rlsServer, /phoenixSupabaseAccessTokenCookieName/);
}
