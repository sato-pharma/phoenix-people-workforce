import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createSecurityPreflightResult,
  findAccessRegistryEntry,
  normalizeRoutePattern,
  type SecurityPreflightResult,
  type HttpMethod,
} from "../src/lib/security/access-registry.ts";

const apiRoot = path.join(process.cwd(), "app", "api");

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}

function methods(source: string): HttpMethod[] {
  return Array.from(source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g))
    .map((match) => match[1] as HttpMethod);
}

export function runSecurityAccessRegistryCheck(): SecurityPreflightResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const file of walk(apiRoot)) {
    const route = normalizeRoutePattern(path.relative(process.cwd(), file));
    const source = readFileSync(file, "utf8");
    for (const method of methods(source)) {
      const entry = findAccessRegistryEntry(route, method);
      if (!entry) {
        failures.push(`Unregistered route: ${method} ${route}`);
        continue;
      }
      if (entry.authMode === "session" && !/resolveAccessContext|requireWorkflowControlAdmin|requireCoaching/.test(source)) {
        failures.push(`Missing session guard: ${method} ${route}`);
      }
      if (method !== "GET" && entry.csrf.required && !/assertSameOriginMutation\(request\)/.test(source)) {
        failures.push(`Missing CSRF guard: ${method} ${route}`);
      }
      if (method !== "GET" && !entry.csrf.required && !entry.csrf.exemptReason) {
        warnings.push(`Mutation has no CSRF exemption reason: ${method} ${route}`);
      }
    }
  }

  return createSecurityPreflightResult({
    environment: "local",
    failures,
    warnings,
  });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/security-access-registry.ts")) {
  const result = runSecurityAccessRegistryCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
