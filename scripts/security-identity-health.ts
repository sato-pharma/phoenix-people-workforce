import { readFileSync } from "node:fs";

import { createSecurityPreflightResult, type SecurityPreflightResult } from "../src/lib/security/access-registry.ts";

const migration = readFileSync("supabase/migrations/20260601221112_access_identity_integrity_hardening.sql", "utf8");
const requiredPatterns = [
  /user_access_profiles_active_auth_user_uidx/i,
  /user_access_profiles_active_login_id_uidx/i,
  /user_access_profiles_active_hr_id_uidx/i,
  /app_auth_users_role_check/i,
  /user_access_profiles_phoenix_role_check/i,
  /user_access_profiles_scope_type_check/i,
  /v_access_identity_health/i,
  /active_employee_without_auth_user/i,
  /auth_user_without_employee/i,
  /auth_user_missing_role/i,
  /security_invoker = true/i,
];

export function runSecurityIdentityHealthCheck(): SecurityPreflightResult {
  const failures = requiredPatterns
    .filter((pattern) => !pattern.test(migration))
    .map((pattern) => `Identity hardening migration missing ${pattern}`);

  return createSecurityPreflightResult({
    environment: "local",
    failures,
    warnings: ["Static local check only; live duplicate/orphan counts require staging or production preflight approval."],
  });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/security-identity-health.ts")) {
  const result = runSecurityIdentityHealthCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
