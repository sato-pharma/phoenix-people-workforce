import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { createSecurityPreflightResult, type SecurityPreflightResult } from "../src/lib/security/access-registry.ts";

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
const migrationText = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => readFileSync(path.join(migrationsDir, file), "utf8"))
  .join("\n");

const checks: Array<[RegExp, string]> = [
  [/security_invoker = true/i, "security-invoker view hardening"],
  [/revoke all on .* from anon, authenticated/i, "anon/authenticated revocation"],
  [/to service_role/i, "service role explicit policies/grants"],
  [/user_access_profiles_active_auth_user_uidx/i, "access identity active auth uniqueness"],
  [/v_access_identity_health/i, "access identity health view"],
];

export function runSecurityRlsStaticCheck(): SecurityPreflightResult {
  const failures = checks
    .filter(([pattern]) => !pattern.test(migrationText))
    .map(([, label]) => `Missing RLS/static hardening evidence: ${label}`);

  return createSecurityPreflightResult({
    environment: "local",
    failures,
    warnings: ["Static migration scan only; it does not prove live Supabase RLS behavior."],
  });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/security-rls-static.ts")) {
  const result = runSecurityRlsStaticCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
