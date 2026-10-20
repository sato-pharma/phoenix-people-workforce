import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildEmployee360ListItems } from "../src/lib/employee-360/list-items.ts";
import {
  buildEmployee360ManagerChain,
  employee360ManagerOptions,
  matchesEmployee360Manager,
} from "../src/lib/employee-360/list-manager-filter.ts";
import { stripComments } from "./support/comment-strip.ts";

function directoryRow(
  hrId: string,
  name: string,
  jobTitle: string,
  manager: { hrId: string; name: string } | null,
): EmployeeDirectoryRow {
  return {
    hrId,
    displayName: name,
    fullName: name,
    jobTitle,
    positionTitle: jobTitle,
    managerHrId: manager?.hrId ?? null,
    managerName: manager?.name ?? null,
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    employmentStatus: "active",
  } as EmployeeDirectoryRow;
}

/**
 * Owner, 2026-10-20: "when you filter by manager you find no manager … every single role that is
 * applicable to appear in a module — find it and show it." The Employee 360 list offered only the
 * direct managers of the open tab's cards and matched `managerName === selected`, so a Regional or
 * National Sales Manager was never offered on the Medical Reps tab, and nothing beneath a manager's
 * own reports ever matched him.
 */
function runEmployee360ListManagerFilterTests() {
  // CEO → National SM → Regional SM → District SM → two reps. The Regional SM's card is NOT visible
  // to this viewer (left out of `visible`), which is the case the server-side chain exists for.
  const ceo = directoryRow("AA", "Anwar CEO", "Chief Executive Officer", null);
  const nsm = directoryRow("N-1", "Nadia National", "National Sales Manager", { hrId: "AA", name: "Anwar CEO" });
  const rsm = directoryRow("R-1", "Rami Regional", "Regional Manager", { hrId: "N-1", name: "Nadia National" });
  const dsm = directoryRow("D-1", "Dina District", "District Manager", { hrId: "R-1", name: "Rami Regional" });
  const rep1 = directoryRow("M-1", "Mona Rep", "Medical Representative", { hrId: "D-1", name: "Dina District" });
  const rep2 = directoryRow("M-2", "Maged Rep", "Medical Representative", { hrId: "D-1", name: "Dina District" });
  const otherDsm = directoryRow("D-2", "Dalia District", "District Manager", { hrId: "N-1", name: "Nadia National" });
  const otherRep = directoryRow("M-3", "Mostafa Rep", "Medical Representative", { hrId: "D-2", name: "Dalia District" });
  const directory = [ceo, nsm, rsm, dsm, rep1, rep2, otherDsm, otherRep];
  const visible = [nsm, dsm, rep1, rep2, otherDsm, otherRep];

  const items = buildEmployee360ListItems(visible, directory);
  const byId = new Map(items.map((item) => [item.hrId, item]));
  assert.deepEqual(
    byId.get("M-1")?.managersAbove,
    ["Rami Regional", "Nadia National", "Anwar CEO"],
    "a card carries every manager above its direct manager, walked over the WHOLE directory — through the Regional SM this viewer cannot open",
  );
  assert.equal(byId.has("R-1"), false, "the cards are still exactly the visible rows — only names travel");

  const chain = buildEmployee360ManagerChain(items);
  const reps = items.filter((item) => item.category === "medical-rep");
  const repOptions = employee360ManagerOptions(reps, chain);
  for (const manager of ["Dina District", "Rami Regional", "Nadia National", "Dalia District"]) {
    assert.ok(
      repOptions.includes(manager),
      `${manager} must be offered on the Medical Reps tab — the options carry every manager on the chain, not only the reps' direct managers`,
    );
  }

  const repsUnder = (manager: string) =>
    reps.filter((item) => matchesEmployee360Manager(item, manager, chain)).map((item) => item.hrId).sort();
  assert.deepEqual(repsUnder("Dina District"), ["M-1", "M-2"], "a District SM keeps his own reps");
  assert.deepEqual(
    repsUnder("Rami Regional"),
    ["M-1", "M-2"],
    "a Regional SM keeps the reps two levels beneath him — the match walks the chain, it is not managerName === selected",
  );
  assert.deepEqual(
    repsUnder("Nadia National"),
    ["M-1", "M-2", "M-3"],
    "a National SM keeps every rep of his line, through both district managers",
  );
  assert.deepEqual(repsUnder("Dalia District"), ["M-3"], "…and a sibling district manager keeps only hers");

  const managers = items.filter((item) => item.category === "district-manager");
  assert.deepEqual(
    managers.filter((item) => matchesEmployee360Manager(item, "Dina District", chain)).map((item) => item.hrId),
    ["D-1"],
    "choosing a manager keeps his OWN card on the tab that holds it",
  );

  // The list uses the shared rule — never a hand-rolled `managerName ===` again.
  const listSource = stripComments(readFileSync("src/components/employee-360/employee-search-list.tsx", "utf8"));
  assert.doesNotMatch(
    listSource,
    /e\.managerName !== filters\.managerName/,
    "the Manager filter must not compare the direct manager's name only",
  );
  assert.match(listSource, /matchesEmployee360Manager\(e, filters\.managerName, managerChain\)/);
  assert.match(listSource, /managerName: employee360ManagerOptions\(inTab, managerChain\)/);
  assert.match(listSource, /buildEmployee360ManagerChain\(employees\)/, "the chain is built from every tab's cards, not one tab");
  for (const page of ["app/(admin)/employee-360/page.tsx", "app/employee-portals/employee-360/page.tsx"]) {
    const pageSource = stripComments(readFileSync(page, "utf8"));
    assert.match(pageSource, /buildEmployee360ListItems\(visibleRows, /, `${page} builds its cards through the shared builder`);
  }
}

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
  // the portal index renders a "My Team" roster built from the SAME subtree-aware door.
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
  // one-option picker — the browse list only renders when there is somebody else to pick.
  const pickerBranchIdx = indexSource.indexOf("if (teamRoster.length > 1)");
  assert.ok(pickerBranchIdx > -1, "the picker must be hidden when the viewer is the only visible subject");

  // Owner rule (2026-08-05): the picker and the viewer's OWN report must never share the screen.
  // A District Manager used to see their own card under "District Mgrs" sitting directly above
  // their own rendered report — the same person drawn twice — and pressing that card opened a
  // THIRD copy on the detail route. The browse branch must therefore RETURN, not render a report
  // underneath the cards.
  assert.equal(
    indexSource.split("<Employee360View").length - 1,
    1,
    "the portal index must render Employee360View at most once — only the leaf viewer's own report",
  );
  assert.ok(
    indexSource.indexOf("<Employee360View") > pickerBranchIdx,
    "the picker branch must return before the report renders — a manager must never see the picker and their own report at once",
  );
  // The period chips control the report, so on a browse list with no report they are a dead
  // control. They belong only to the leaf viewer's self-report branch, below the picker return.
  assert.ok(
    indexSource.indexOf("<PeriodFilter") > pickerBranchIdx,
    "the period filter must not sit on the browse list, where it would control nothing",
  );
  // The expensive load sits behind that return too: every 360 call is its own cross-region round
  // trip (Railway `europe-west4` → Supabase `eu-central-1`), so a browse list that still loads a
  // full profile is a slow page rendering data it immediately throws away.
  assert.ok(
    indexSource.indexOf("getEmployee360Profile(") > pickerBranchIdx,
    "the Employee 360 profile load must happen only after the browse branch has returned",
  );
  // The browse branch sits ABOVE the field-force check on purpose: a manager whose own job title
  // is outside the six covered families still owns their team's reports, and with no self report
  // left to fall back on, "Not covered" would otherwise strand them with nothing.
  // Anchored to the JSX attribute, not the bare copy — the branch above quotes that same string in
  // a comment, and a bare indexOf would match the comment and silently invert this check.
  const notCoveredJsxIdx = indexSource.indexOf('title="Not covered by Employee 360"');
  assert.ok(notCoveredJsxIdx > -1, "the out-of-scope state must still exist for a leaf viewer");
  assert.ok(
    pickerBranchIdx < notCoveredJsxIdx,
    "a manager outside the six field-force families must still reach their team, not a 'Not covered' dead end",
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

  runEmployee360ListManagerFilterTests();
}
