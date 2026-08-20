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

  // These two write to the alias tables the moment the permission check clears — neither handler has
  // an input to bail on — so their classification is the one thing standing between a full rebuild
  // of the source-of-sales crosswalks and no record that it happened. Pin them by name.
  for (const route of ["/api/sales/normalizer/mappings/learn-from-history", "/api/sales/normalizer/brick-centroids"]) {
    const entry = findAccessRegistryEntry(route, "POST");
    assert.equal(entry?.pattern, route, `${route} POST must resolve to its own entry, not a blanket`);
    assert.equal(entry?.audit.classification, "mutation", `${route} POST writes on every call and must be classified as a mutation`);
  }
  // ...and the GET half of that split pair must still resolve to the read entry, not the POST one.
  assert.equal(
    findAccessRegistryEntry("/api/sales/normalizer/brick-centroids", "GET")?.audit.classification,
    "access-read",
    "brick-centroids GET only reports coverage and must stay classified as a read",
  );

  const files = walkRouteFiles(apiRoot);
  assert.ok(files.length > 0, "route file scan must find app/api route handlers");

  const unregistered: string[] = [];
  const missingSessionGuard: string[] = [];
  const missingPermissionGuard: string[] = [];
  const missingCsrf: string[] = [];
  const missingExportAudit: string[] = [];
  const missingPublicClassification: string[] = [];
  const normalizerFellThrough: string[] = [];
  const normalizerMissingAudit: string[] = [];

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

      // Both Source Normalizers — the monthly one at /api/sales/normalizer/** and the weekly one at
      // /api/sales/weekly/normalizer/** — hold the alias crosswalks the whole sales pipeline codes
      // against. Five monthly routes reached production with no entry of their own, inheriting
      // sales:read and no audit classification from the /api/sales/** blanket; four of those five
      // write. Pinning the module as a whole (rather than route by route, as `mappings/save` was)
      // is what stops the next one added here from falling through the same way.
      if (/^\/api\/sales\/(weekly\/)?normalizer(\/|$)/.test(route)) {
        if (entry.pattern.includes("**")) normalizerFellThrough.push(`${method} ${route} -> ${entry.pattern}`);
        if (!entry.audit.required || !entry.audit.classification) normalizerMissingAudit.push(`${method} ${route}`);
      }
    }
  }

  assert.deepEqual(unregistered, [], "all app/api routes must be present in the access registry");
  assert.deepEqual(missingPublicClassification, [], "all non-session routes must be explicitly classified");
  assert.deepEqual(missingSessionGuard, [], "session routes must use an approved session guard");
  assert.deepEqual(missingPermissionGuard, [], "session routes must use assertPermission/canAccess or an approved domain guard");
  assert.deepEqual(missingCsrf, [], "CSRF-required mutation routes must call assertSameOriginMutation(request)");
  assert.deepEqual(missingExportAudit, [], "export/template/download routes must require audit classification in the registry");
  assert.deepEqual(normalizerFellThrough, [], "every Source Normalizer route must have its own registry entry, not a wildcard blanket");
  assert.deepEqual(normalizerMissingAudit, [], "every Source Normalizer route must declare an audit classification");
}
