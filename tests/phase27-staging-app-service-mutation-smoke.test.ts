import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase27StagingAppServiceMutationSmokeTests() {
  const smoke = readFileSync("scripts/phase27-staging-app-service-mutation-smoke.ts", "utf8");

  assert.match(smoke, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  // The approved staging target must come from the environment and fail closed when absent.
  // Pinning a literal ref here is what let the retired sandbox rot in place unnoticed.
  assert.match(smoke, /PHOENIX_APPROVED_STAGING_REF is required/);
  assert.doesNotMatch(smoke, /= "oaifhavixhdtwmseshff"/);
  assert.match(smoke, /blockedProductionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(smoke, /PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(smoke, /Refusing to use \.env\.local because it points at production/);
  assert.match(smoke, /Refusing to use the production SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(smoke, /auth\/v1\/admin\/users/);
  assert.match(smoke, /process\.env\.NEXT_PUBLIC_SUPABASE_URL = stagingUrl\(\)/);
  assert.match(smoke, /process\.env\.SUPABASE_SERVICE_ROLE_KEY = stagingServiceRoleKey\(\)/);
  assert.match(smoke, /importAppRoutes/);
  assert.match(smoke, /loaded production app API route handlers with staging Supabase configuration/);

  assert.match(smoke, /staging sessions created from app_auth_users/);
  assert.match(smoke, /phoenixSessionCookieName/);
  assert.match(smoke, /phoenixSupabaseAccessTokenCookieName/);
  assert.match(smoke, /phoenixSupabaseRefreshTokenCookieName/);
  assert.match(smoke, /Supabase bridge tokens available/);

  assert.match(smoke, /session_version/);
  assert.match(smoke, /create table if not exists public\.employee_probation/);
  assert.match(smoke, /create table if not exists public\.probation_evaluations/);
  assert.match(smoke, /create table if not exists public\.v2_vacation_requests/);
  assert.match(smoke, /create table if not exists public\.v2_vacation_request_events/);
  assert.match(smoke, /PHASE27-/);
  assert.match(smoke, /seedPhase27Fixtures/);
  assert.match(smoke, /cleanupPhase27Fixtures/);
  assert.match(smoke, /readPhase27Residue/);

  assert.match(smoke, /HR can update disposable employee through direct app route/);
  assert.match(smoke, /Employee cannot update employee governance through direct app route/);
  assert.match(smoke, /Super Admin can save approved disposable expense through direct app route/);
  assert.match(smoke, /Finance cannot save approved expense through owner-only direct app route/);
  assert.match(smoke, /Employee cannot save approved expense through direct app route/);
  // REC-010: the legacy probation workflow route was deleted, so the smoke no longer imports it.
  assert.doesNotMatch(smoke, /app\/api\/probation\/\[id\]\/workflow/);
  assert.match(smoke, /Manager can approve direct-team vacation through direct app route/);
  assert.match(smoke, /Employee cannot approve vacation through direct app route/);
  assert.match(smoke, /Command Center\/Data Health\/Monitoring remain fixture-safe through PHASE27 cleanup residue checks/);

  assert.match(smoke, /delete from public\.employees/);
  assert.match(smoke, /delete from public\.outstation_expenses/);
  assert.match(smoke, /delete from public\.outstation_expense_reports/);
  assert.match(smoke, /delete from public\.employee_probation/);
  assert.match(smoke, /delete from public\.probation_evaluations/);
  assert.match(smoke, /delete from public\.v2_vacation_requests/);
  assert.doesNotMatch(smoke, /next dev/);
  assert.doesNotMatch(smoke, /chromium\.launch/);
  assert.doesNotMatch(smoke, /raw_user_meta_data/);
}
