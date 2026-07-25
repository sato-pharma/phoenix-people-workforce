import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Employee 360's employee-portal surface only ever showed the viewer's OWN
// record. A company-wide viewer whose own record isn't field-force (Talent
// Acquisition today) always hit "Not covered by Employee 360" — the
// COMPANY_360_ROLES grant existed but had no reachable UI path. This locks the
// fix (owner-requested 2026-07-25): a browse-all-field-force fallback on the
// portal index page, backed by a new per-employee portal detail route, reusing
// EmployeeSearchList with a portal-scoped basePath (the admin route it links to
// by default redirects portal-mode roles away, per app/(admin)/layout.tsx).
export function runEmployee360PortalBrowseTests() {
  const indexSource = readFileSync("app/employee-portals/employee-360/page.tsx", "utf8");
  const detailSource = readFileSync("app/employee-portals/employee-360/[hrId]/page.tsx", "utf8");
  const searchListSource = readFileSync("src/components/employee-360/employee-search-list.tsx", "utf8");
  const accessSource = readFileSync("src/lib/employee-360/access.ts", "utf8");

  // access.ts exports the standalone predicate the portal page needs.
  assert.match(accessSource, /export function isCompany360Viewer/);

  // Portal index page: the fallback branch fires for a company-wide viewer
  // whose own record is missing or not field-force, BEFORE the self-only empty
  // states, and reuses resolveEmployee360VisibleRows (the same door the admin
  // index page uses) rather than inventing a parallel scoping path.
  assert.match(indexSource, /isCompany360Viewer\(access\)/);
  assert.match(indexSource, /resolveEmployee360VisibleRows\(activeRows, access\)/);
  assert.match(indexSource, /<EmployeeSearchList employees=\{employees\} basePath=\{PORTAL_BASE_PATH\}/);
  const fallbackIdx = indexSource.indexOf("isCompany360Viewer(access)");
  const profileUnavailableIdx = indexSource.indexOf("Profile unavailable");
  const notCoveredIdx = indexSource.indexOf("Not covered by Employee 360");
  assert.ok(fallbackIdx > -1 && fallbackIdx < profileUnavailableIdx, "the company-wide fallback must be checked before the self-only 'Profile unavailable' state");
  assert.ok(fallbackIdx > -1 && fallbackIdx < notCoveredIdx, "the company-wide fallback must be checked before the self-only 'Not covered' state");
  // includeInactive:false for the browse list — matches the admin index page's
  // convention of never listing resigned/inactive employees in the directory.
  assert.match(indexSource, /getEmployeeDirectoryRows\(\{ includeInactive: false \}\)/);

  // New portal detail route: same guards as every other employee-portal page
  // (portal-mode-only, redirect to the portal index on scope denial — never the
  // admin route, which would bounce a portal-mode role right back out).
  assert.match(detailSource, /resolveNavigationMode\(access\) !== "employee-portal"/);
  assert.match(detailSource, /redirect\("\/overview"\)/);
  assert.match(detailSource, /canViewEmployee360Subject\(access, target, await buildEmployee360Scope\(rows, access\)\)/);
  assert.match(detailSource, /redirect\(PORTAL_BASE_PATH\)/);
  assert.doesNotMatch(detailSource, /redirect\("\/employee-360"\)/, "the portal detail page must never redirect into the admin surface");

  // EmployeeSearchList: basePath is additive (admin index page's existing calls
  // pass no basePath, so they must keep linking to /employee-360/[hrId]).
  assert.match(searchListSource, /basePath = "\/employee-360"/);
  assert.match(searchListSource, /href=\{`\$\{basePath\}\/\$\{encodeURIComponent\(e\.hrId\)\}`\}/);
  const adminIndexSource = readFileSync("app/(admin)/employee-360/page.tsx", "utf8");
  assert.match(adminIndexSource, /<EmployeeSearchList employees=\{employees\} \/>/);
}
