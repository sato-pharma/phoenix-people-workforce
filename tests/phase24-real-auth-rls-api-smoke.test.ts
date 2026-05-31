import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase24RealAuthRlsApiSmokeTests() {
  const smoke = readFileSync("scripts/phase24-real-auth-rls-api-smoke.ts", "utf8");
  const loginRoute = readFileSync("app/api/auth/login/route.ts", "utf8");
  const rlsServer = readFileSync("src/lib/supabase/rls-server.ts", "utf8");

  assert.match(smoke, /signInWithPassword/);
  assert.match(smoke, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  assert.match(smoke, /approvedSandboxRef = "oaifhavixhdtwmseshff"/);
  assert.match(smoke, /blockedProductionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(smoke, /PHOENIX_RLS_TEST_USERS_JSON/);
  assert.match(smoke, /current_phoenix_role/);
  assert.match(smoke, /current_access_scope/);
  assert.match(smoke, /current_access_can_manage_employees/);
  assert.match(smoke, /current_access_can_manage_payroll/);

  for (const role of [
    "Super Admin",
    "HR Specialist",
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
  assert.match(smoke, /payroll_expenses/);
  assert.match(smoke, /sales_records/);
  assert.match(smoke, /employee_probation/);
  assert.match(smoke, /v2_vacation_requests/);
  assert.match(smoke, /schema cache[\s\S]*coverage skipped/);

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
