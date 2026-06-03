import { createSecurityPreflightResult } from "../src/lib/security/access-registry.ts";
import { runSecurityAccessRegistryCheck } from "./security-access-registry.ts";
import { runSecurityIdentityHealthCheck } from "./security-identity-health.ts";
import { runSecurityRlsStaticCheck } from "./security-rls-static.ts";

const checks = [
  ["security:access-registry", runSecurityAccessRegistryCheck],
  ["security:identity-health", runSecurityIdentityHealthCheck],
  ["security:rls-static", runSecurityRlsStaticCheck],
] as const;

const failures: string[] = [];
const warnings: string[] = [];

for (const [name, check] of checks) {
  const result = check();
  console.log(JSON.stringify({ name, ...result }, null, 2));
  failures.push(...result.failures.map((failure) => `${name}: ${failure}`));
  warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`));
}

warnings.push("Local preflight does not replace staging/prod Supabase Auth and RLS verification.");

const result = createSecurityPreflightResult({
  environment: "local",
  failures,
  warnings,
});

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
