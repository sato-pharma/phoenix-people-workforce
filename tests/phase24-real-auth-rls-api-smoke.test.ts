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

  // payroll_expenses was renamed to outstation_expenses on 2026-07-13. This assertion used to pin
  // the retired name, so the smoke and the test agreed with each other and disagreed with the
  // database for a month. Prose may still explain the rename; naming it as a table must not return.
  assert.doesNotMatch(smoke, /"payroll_expenses"/);

  // The two per-role loops are the point of this smoke, so assert membership inside each loop's own
  // array rather than that a table name appears somewhere in the file — a bare match is how
  // `payroll_expenses` passed for a month after the table it named was gone (#2070) and how
  // `employee_probation`/`v2_vacation_requests` could sit in the wrong loop and still "pass" this
  // test. The two loops destructure differently ([surface, table, select] vs [surface, table]),
  // which is what tells them apart.
  const readableLoop = smoke.match(/for \(const \[surface, table, select\] of \[([\s\S]*?)\] as const\) \{/);
  const deniedLoop = smoke.match(/for \(const \[surface, table\] of \[([\s\S]*?)\] as const\) \{/);
  assert.ok(readableLoop, "authenticated-readable surfaces loop not found");
  assert.ok(deniedLoop, "service-role-only (denied) surfaces loop not found");
  const readableSurfaces = readableLoop[1];
  const deniedSurfaces = deniedLoop[1];

  for (const table of ["salary_records", "outstation_expenses", "outstation_expense_requests", "expense_claims", "sales_records"]) {
    assert.match(readableSurfaces, new RegExp(`"${table}"`));
  }

  // employee_probation and v2_vacation_requests are service-role only by design (verified
  // 2026-08-13: no authenticated SELECT grant in staging or production, every application read uses
  // getSupabaseAdmin()). PR #2070 found both throwing 42501 and explicitly left deciding which side
  // was wrong "worth resolving deliberately rather than inside this PR" — they must never return to
  // the readable loop, which would silently re-demand a read that must never succeed.
  for (const table of ["employee_probation", "v2_vacation_requests"]) {
    assert.match(deniedSurfaces, new RegExp(`"${table}"`));
    assert.doesNotMatch(readableSurfaces, new RegExp(`"${table}"`));
  }

  // The denial check must be a real inversion, not a copy-paste of the readable one: a clean read is
  // the failure, and only 42501 counts as proof the lockdown holds.
  assert.match(smoke, /async function verifyDeniedSurface/);
  assert.match(smoke, /await verifyDeniedSurface\(client, table\)/);
  assert.match(smoke, /is readable by authenticated — this table is meant to stay service-role only/);
  assert.match(smoke, /code !== "42501"/);

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

  // salary_records_select_access grants full visibility via TWO disjuncts —
  // phx_can_manage_payroll() OR phx_has_company_access() — not one. A company-reader role (CEO,
  // isCompanyReader:true, canManagePayroll:false) can legitimately see a payroll row for someone
  // with no live employees row (a resigned employee whose row was later removed — see
  // deleting-an-employee-needs-a-full-text-scan), and that is not a leak. Both flags must gate the
  // scoped-containment check, or a company-reader fails a test that can never legitimately pass.
  assert.match(smoke, /canManagePayroll \|\| expectedByRole\[role\]\.isCompanyReader\) return/);

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
