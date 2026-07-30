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

  // Owner rule (2026-07-30): every role sees THEMSELVES plus everyone reporting to them, at any
  // depth — e.g. a Regional Manager reaches their District Managers AND the Medical Reps under
  // those DSMs. The per-subject gate already allowed this; only a navigation path was missing, so
  // the self report now also renders a "My Team" roster built from the SAME subtree-aware door.
  assert.match(
    indexSource,
    /async function buildEmployee360Picker\(/,
    "the picker roster must live in one shared builder used by both the self-report and no-self-report paths",
  );
  assert.match(
    indexSource,
    /<EmployeeSearchList employees=\{teamRoster\} basePath=\{PORTAL_BASE_PATH\} defaultTab=\{roleCategory\}/,
    "the picker must open on the VIEWER's own role tab, not whichever family sorts first",
  );
  // Owner-requested: the viewer is a selectable option too, listed on their own role-family tab
  // beside the Medical Reps / District Mgrs tabs. So the roster must NOT filter self out — an
  // owner-excluded person is dropped by canViewEmployee360Subject instead, never by a local filter.
  assert.doesNotMatch(
    indexSource,
    /!hrIdsMatch\(row\.hrId, target\.hrId\)/,
    "the viewer must remain a selectable option in the picker (do not exclude self locally)",
  );
  // A leaf viewer (Medical Rep, whose subtree is only themselves) must not get a pointless
  // one-option picker — the section only renders when there is somebody else to pick.
  assert.match(
    indexSource,
    /teamRoster\.length > 1 \?/,
    "the picker must be hidden when the viewer is the only visible subject",
  );
  // The roster must never invent its own scoping: it reuses resolveEmployee360VisibleRows, so it can
  // only ever list people the viewer could already open by direct URL (navigation, not access).
  const builderIdx = indexSource.indexOf("async function buildEmployee360Picker(");
  assert.ok(
    indexSource.indexOf("resolveEmployee360VisibleRows", builderIdx) > builderIdx,
    "the picker roster must be scoped by resolveEmployee360VisibleRows, not a parallel rule",
  );

  // Owner-requested per-person exclusion: an excluded HR_ID is removed from Employee 360 for EVERY
  // viewer, including themselves and the whole-company roles. The guard must sit above the
  // system/CEO short-circuit and above the self check, or those branches would re-admit them.
  assert.match(accessSource, /export function isEmployee360ExcludedSubject/);
  assert.match(accessSource, /EMPLOYEE_360_EXCLUDED_HR_IDS/);
  const gateIdx = accessSource.indexOf("export function canViewEmployee360Subject");
  const excludeIdx = accessSource.indexOf("isEmployee360ExcludedSubject(subject.hrId)", gateIdx);
  const systemShortCircuitIdx = accessSource.indexOf("COMPANY_360_ROLES.has(context.role)) return true", gateIdx);
  const selfCheckIdx = accessSource.indexOf("hrIdsMatch(context.hrId, subject.hrId)", gateIdx);
  assert.ok(excludeIdx > gateIdx, "canViewEmployee360Subject must consult the exclusion list");
  assert.ok(
    excludeIdx < systemShortCircuitIdx,
    "the exclusion must be checked BEFORE the system/CEO short-circuit, or a company-wide role would still see an excluded person",
  );
  assert.ok(
    excludeIdx < selfCheckIdx,
    "the exclusion must be checked BEFORE the self check, or an excluded person would still see their own report",
  );
  // The self report is not the only thing behind that gate, so an excluded viewer must still get
  // their team picker rather than being bounced out of the module.
  assert.doesNotMatch(
    indexSource,
    /redirect\("\/employee-portals"\);\n\s*\}\n\n\s*\/\/ Employee 360 covers only/,
    "an excluded/out-of-scope self view must render the team picker, not redirect out of Employee 360",
  );

  // District Manager / Manager walk the chain like the RM branch, so "people reporting to him" is
  // true at any depth rather than stopping at direct reports.
  assert.doesNotMatch(
    accessSource,
    /reportsToManagerSeat/,
    "Employee 360 must not fall back to one-level direct-report checks for any hierarchy role",
  );
  const dmBranchIdx = accessSource.indexOf('role === "District Manager"');
  assert.ok(dmBranchIdx > -1, "the District Manager branch must still exist");
  assert.ok(
    accessSource.indexOf("isWithinManagerHierarchy", dmBranchIdx) > dmBranchIdx,
    "the District Manager branch must use isWithinManagerHierarchy (full subtree)",
  );
}
