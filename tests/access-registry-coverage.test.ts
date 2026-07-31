import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  accessRegistry,
  findAccessRegistryEntry,
  normalizeRoutePattern,
  type HttpMethod,
} from "../src/lib/security/access-registry.ts";

const apiRoot = path.join(process.cwd(), "app", "api");
const mutationMethods = new Set<HttpMethod>(["POST", "PATCH", "PUT", "DELETE"]);

function walkRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkRouteFiles(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}

function methodsFromSource(source: string): HttpMethod[] {
  return Array.from(source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g))
    .map((match) => match[1] as HttpMethod);
}

function routeFromFile(filePath: string) {
  const relative = path.relative(process.cwd(), filePath);
  return normalizeRoutePattern(relative);
}

function hasSessionGuard(source: string) {
  return /resolveAccessContext|requireWorkflowControlAdmin|requireCoaching(?:Access|Permission|ManagementPermission)|requireRecruitmentAccess|handleSiRequest|resolveSiContext/.test(source);
}

function hasPermissionGuard(source: string) {
  return /assertPermission\(|assertSystemAdministratorWorkspaceAccess\(|canAccess\(|require[A-Za-z]*Permission|assertCanExportProbation|requireWorkflowControlAdmin|requireRecruitmentAccess|handleSiRequest|resolveSiContext/.test(source);
}

export function runAccessRegistryCoverageTests() {
  assert.ok(accessRegistry.length > 0, "access registry must not be empty");

  for (const entry of accessRegistry) {
    assert.ok(entry.pattern.startsWith("/"), `${entry.pattern} must use an absolute route pattern`);
    assert.ok(entry.methods.length > 0, `${entry.pattern} must declare methods`);
    if (entry.authMode !== "session") {
      assert.ok(entry.exceptionReason, `${entry.pattern} non-session routes must explain the exception`);
      assert.equal(entry.permission, null, `${entry.pattern} non-session routes must not fake a session permission`);
    }
    if (entry.surface === "api" && entry.methods.some((method) => mutationMethods.has(method)) && !entry.csrf.required) {
      assert.ok(entry.csrf.exemptReason, `${entry.pattern} mutation CSRF exemption must be explicit`);
    }
    if (entry.audit.required) {
      assert.ok(entry.audit.classification, `${entry.pattern} audit-required entries must classify the audit type`);
    }
  }

  const normalizerSaveEntry = findAccessRegistryEntry("/api/sales/normalizer/mappings/save", "POST");
  assert.equal(normalizerSaveEntry?.pattern, "/api/sales/normalizer/mappings/save", "normalizer mapping save must not fall through to /api/sales/**");
  assert.equal(normalizerSaveEntry?.audit.classification, "mutation", "normalizer mapping save must be classified as a mutation");
  assert.deepEqual(normalizerSaveEntry?.permission, { resource: "sales", action: "import" }, "normalizer mapping save must require sales import access");

  const files = walkRouteFiles(apiRoot);
  assert.ok(files.length > 0, "route file scan must find app/api route handlers");

  const unregistered: string[] = [];
  const missingSessionGuard: string[] = [];
  const missingPermissionGuard: string[] = [];
  const missingCsrf: string[] = [];
  const missingExportAudit: string[] = [];
  const missingPublicClassification: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const route = routeFromFile(file);
    for (const method of methodsFromSource(source)) {
      const entry = findAccessRegistryEntry(route, method);
      if (!entry) {
        unregistered.push(`${method} ${route}`);
        continue;
      }

      if (entry.authMode === "session") {
        if (!hasSessionGuard(source)) missingSessionGuard.push(`${method} ${route}`);
        if (entry.guard !== "domain-helper" && !hasPermissionGuard(source)) {
          missingPermissionGuard.push(`${method} ${route}`);
        }
      } else if (!entry.exceptionReason) {
        missingPublicClassification.push(`${method} ${route}`);
      }

      if (mutationMethods.has(method) && entry.csrf.required && !/assertSameOriginMutation\(request\)/.test(source)) {
        missingCsrf.push(`${method} ${route}`);
      }

      // The `export|download|template` alternation used to require a SLASH-delimited segment, so a
      // hyphenated route name slipped through entirely: `/api/admin/crm/master-export` and its
      // portal twin — the two most sensitive exports in the app — never matched, and this guard
      // silently never fired for them. Accept a `-` boundary as well as `/` or start-of-string.
      const exportLikeRoute = /(^|\/|-)(export|download|template)(\/|$)|events-csv$|payslips\/image$/.test(route);
      if (exportLikeRoute && !entry.audit.required) {
        missingExportAudit.push(`${method} ${route}`);
      }
    }
  }

  assert.deepEqual(unregistered, [], "all app/api routes must be present in the access registry");
  assert.deepEqual(missingPublicClassification, [], "all non-session routes must be explicitly classified");
  assert.deepEqual(missingSessionGuard, [], "session routes must use an approved session guard");
  assert.deepEqual(missingPermissionGuard, [], "session routes must use assertPermission/canAccess or an approved domain guard");
  assert.deepEqual(missingCsrf, [], "CSRF-required mutation routes must call assertSameOriginMutation(request)");
  assert.deepEqual(missingExportAudit, [], "export/template/download routes must require audit classification in the registry");
}
