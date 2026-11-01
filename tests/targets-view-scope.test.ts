import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PORTAL_REP_TARGETS_ROLES,
  PORTAL_TARGETS_ROLES,
  TARGETS_ADMIN_VIEW_ROLES,
  canViewTargetsAdminPage,
  filterAchievementForScope,
  isPortalRepTargetsRole,
  isPortalTargetsRole,
  salesLineCodeForOfficialLine,
  type TargetsScopeBound,
} from "../src/lib/sales/portal-targets.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

/**
 * Targets was gated end-to-end on `sales:import` (Super Admin + SFE Manager only), so there was no
 * view/edit split at all: the CEO could not open it, and DM/RM/NSM had no targets surface anywhere.
 * These guards pin the READ side that was opened up, and — more importantly — pin that the WRITE
 * side did not move with it.
 *
 * The pure-function tests are the real value here; the source-contract assertions at the end follow
 * the same readFileSync idiom crm-visits-self-scope.test.ts uses for paths that need a live DB.
 */

function row(over: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "pedia",
    regionCode: "D1",
    areaCode: "D16",
    areaState: "occupied",
    isOther: false,
    repSeatId: null,
    repHrId: null,
    dmSeatId: null,
    dmHrId: null,
    productCode: "P1",
    actualUnits: 10,
    actualValue: 1000,
    targetUnits: 12,
    targetValue: 1200,
    achievementValue: 0.83,
    achievementUnits: 0.83,
    hasTarget: true,
    hasActual: true,
    ...over,
  };
}

const companyBound: TargetsScopeBound = { canViewAllTargets: true, areaCodes: null, lineCodes: null };

export function runTargetsViewScopeTests() {
  // ── Role sets ───────────────────────────────────────────────────────────────
  assert.equal(PORTAL_TARGETS_ROLES.length, 3, "owner scoped the portal Targets view to DM/RM/NSM");
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager"]) {
    assert.equal(isPortalTargetsRole(role), true, `${role} should reach the portal Targets view`);
  }
  // Medical Rep never gets the MANAGER view: its bound resolves a rep to their whole line. Reps have
  // their own, self-bounded view since 2026-09-16 (below). "Manager" is the Head-Office rung and owns
  // no areas, so it would resolve to an empty grid — a dead tab is worse than no tab.
  for (const role of ["Medical Rep", "Manager", "Employee", "Product Manager", "Group Product Manager", "Marketing Manager", "SFE Manager", "CEO", "Super Admin", "HR Advisory", "HR Operations"]) {
    assert.equal(isPortalTargetsRole(role), false, `${role} must NOT get the portal Targets view`);
  }

  // The rep's own view (owner, 2026-09-16).
  assert.deepEqual([...PORTAL_REP_TARGETS_ROLES], ["Medical Rep"], "only Medical Rep gets the self-bounded Targets view");
  assert.equal(isPortalRepTargetsRole("Medical Rep"), true);
  assert.equal(isPortalRepTargetsRole(" Medical Rep "), true);
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "Manager", "Employee", "CEO", "Super Admin", "SFE Manager", "", null, undefined]) {
    assert.equal(isPortalRepTargetsRole(role), false, `${String(role)} must NOT get the rep's own Targets view`);
  }
  for (const role of PORTAL_REP_TARGETS_ROLES) {
    assert.equal(
      isPortalTargetsRole(role),
      false,
      `${role} is in both Targets role lists — the manager bound would hand that role a whole line's numbers`,
    );
  }

  // The CEO lockout fix: holds sales:read, lands in the ADMIN shell (so the portal twin is
  // unreachable for them), and must therefore be admitted to the admin page read-only.
  assert.equal(canViewTargetsAdminPage({ role: "CEO", scope: "company" }), true, "the CEO must be able to VIEW /sales/targets");
  assert.equal(canViewTargetsAdminPage({ role: "Super Admin", scope: "system" }), true);
  assert.equal(canViewTargetsAdminPage({ role: "SFE Manager", scope: "company" }), true);
  // sales:read alone would also admit these two; the explicit list keeps them out.
  assert.equal(canViewTargetsAdminPage({ role: "Finance Manager", scope: "company" }), false, "Finance Manager was not asked for and must stay out");
  assert.equal(canViewTargetsAdminPage({ role: "Financial Advisor", scope: "company" }), false);
  assert.ok(TARGETS_ADMIN_VIEW_ROLES.includes("CEO"));

  // ── Line-name -> line-code mapping ──────────────────────────────────────────
  // A silent mismatch here blanks a manager's entire grid (fail-closed, but broken).
  assert.equal(salesLineCodeForOfficialLine("Anti Infective"), "anti_infective");
  assert.equal(salesLineCodeForOfficialLine("anti-infective"), "anti_infective");
  assert.equal(salesLineCodeForOfficialLine("CNS"), "cns");
  assert.equal(salesLineCodeForOfficialLine("Pedia"), "pedia");
  assert.equal(salesLineCodeForOfficialLine("Head Office"), null, "Head Office is not a field sales line");
  assert.equal(salesLineCodeForOfficialLine(null), null);
  assert.equal(salesLineCodeForOfficialLine(""), null);

  // ── The PR #1479 case: the bound is AREA codes, never region labels ─────────
  // Six areas exist whose operational owner differs from their geographic region label. A DM bounded
  // to area D16 must keep D16 even though its region (D1) is NOT the only region in play, and must
  // lose D17 even though a region-label filter might have let it through.
  const areaOnly: TargetsScopeBound = { canViewAllTargets: false, areaCodes: new Set(["D16"]), lineCodes: null };
  const kept = filterAchievementForScope(
    [row({ areaCode: "D16", regionCode: "D1" }), row({ areaCode: "D17", regionCode: "AB" })],
    areaOnly,
  );
  assert.equal(kept.length, 1, "only the owned AREA survives");
  assert.equal(kept[0].areaCode, "D16");

  // Case-insensitive / whitespace-tolerant area matching.
  assert.equal(filterAchievementForScope([row({ areaCode: " d16 " })], areaOnly).length, 1);

  // The `isOther` bucket has no area code, so it cannot be attributed to this viewer.
  assert.equal(
    filterAchievementForScope([row({ areaCode: null, isOther: true })], areaOnly).length,
    0,
    "an un-attributable row must not appear in a scoped view",
  );

  // ── Line-only bound (NSM) ───────────────────────────────────────────────────
  const lineOnly: TargetsScopeBound = { canViewAllTargets: false, areaCodes: null, lineCodes: new Set(["pedia"]) };
  const nsmRows = filterAchievementForScope(
    [row({ lineCode: "pedia", areaCode: "D16" }), row({ lineCode: "pedia", areaCode: "GZ1" }), row({ lineCode: "cns", areaCode: "D16" })],
    lineOnly,
  );
  assert.equal(nsmRows.length, 2, "an NSM sees every area on their own line");
  assert.ok(nsmRows.every((r) => r.lineCode === "pedia"), "and nothing from another line");

  // ── FAIL CLOSED ─────────────────────────────────────────────────────────────
  // A resolver that could not place the viewer must mean "nothing", never "the whole company".
  const unresolved: TargetsScopeBound = { canViewAllTargets: false, areaCodes: null, lineCodes: null };
  assert.deepEqual(filterAchievementForScope([row({}), row({ areaCode: "GZ1" })], unresolved), [], "no bound => no rows");
  // An empty (not null) line set also matches nothing.
  const emptyLines: TargetsScopeBound = { canViewAllTargets: false, areaCodes: null, lineCodes: new Set<string>() };
  assert.deepEqual(filterAchievementForScope([row({})], emptyLines), [], "an empty line set matches nothing");
  // Company scope passes everything through untouched.
  const all = [row({}), row({ areaCode: "GZ1", lineCode: "cns" })];
  assert.equal(filterAchievementForScope(all, companyBound).length, 2);

  // ── Rollup integrity ────────────────────────────────────────────────────────
  // The single most likely implementation bug: scoping the grid but rolling up the unfiltered rows,
  // which renders a correct table above whole-line summary cards. Assert the portal page scopes
  // BEFORE it derives lineRows (and therefore before every rollup call).
  const portalPage = readFileSync("app/employee-portals/targets/page.tsx", "utf8");
  const scopeAt = portalPage.indexOf("filterAchievementForScope(");
  const lineRowsAt = portalPage.indexOf("const lineRows");
  const firstRollupAt = Math.min(
    ...["rollupAchievementByLine(", "rollupAchievementByRegion(", "rollupAchievementByDm("]
      .map((needle) => portalPage.indexOf(needle))
      .filter((index) => index >= 0),
  );
  assert.ok(scopeAt > 0, "the portal Targets page must scope its rows");
  assert.ok(scopeAt < lineRowsAt, "scoping must happen BEFORE lineRows is derived");
  assert.ok(lineRowsAt < firstRollupAt, "and every rollup must run on the scoped rows");
  assert.match(portalPage, /canEdit=\{false\}/, "the portal Targets view must be read-only");
  assert.match(portalPage, /sourceFiles=\{\[\]\}/, "company-wide upload provenance must not be passed to the scoped view");
  assert.match(portalPage, /isPortalTargetsRole\(access\.role\)/, "the page must gate on the shared role predicate");
  assert.match(portalPage, /assertPermission\(access, "sales", "read"\)/);
  assert.doesNotMatch(portalPage, /"sales", "import"/, "the read-only view must never assert the write permission");

  // A Medical Rep is answered by their OWN branch, BEFORE the manager gate — and that branch must
  // not touch the manager bound, which resolves a rep to every rep on their line.
  const repBranchAt = portalPage.indexOf("if (isPortalRepTargetsRole(access.role))");
  const managerGateAt = portalPage.indexOf("if (!isPortalTargetsRole(access.role))");
  assert.ok(repBranchAt > 0, "the portal Targets page must branch a Medical Rep to their own view");
  assert.ok(repBranchAt < managerGateAt, "the rep branch must run BEFORE the manager gate, or a rep is bounced or worse");
  const repBranch = portalPage.slice(repBranchAt, managerGateAt);
  assert.match(repBranch, /assertPermission\(access, "sales", "read"\)/, "the rep branch must assert sales:read itself");
  assert.match(repBranch, /loadRepTargets\(access,/, "the rep branch must read through the self-bounded loader");
  assert.match(repBranch, /<RepTargetsView\b/);
  assert.match(repBranch, /return \(/, "the rep branch must RETURN, never fall through to the manager path");
  for (const managerOnly of ["resolvePortalTargetsBound", "filterAchievementForScope", "TargetsWorkspace", "loadMonthlyAchievement"]) {
    assert.ok(!repBranch.includes(managerOnly), `the rep branch must not use ${managerOnly} — that is the whole-line manager path`);
  }

  // ── The WRITE routes must NOT have moved to sales:read ──────────────────────
  for (const route of [
    "app/api/sales/targets/save/route.ts",
    "app/api/sales/targets/upload/route.ts",
    "app/api/sales/targets/template/route.ts",
    "app/api/sales/targets/breakdown/export/route.ts",
  ]) {
    const source = readFileSync(route, "utf8");
    assert.match(source, /assertPermission\(access, "sales", "import"\)/, `${route} must stay on sales:import`);
    assert.doesNotMatch(source, /assertPermission\(access, "sales", "read"\)/, `${route} must NOT be relaxed to sales:read`);
  }

  // The one relaxed READ route must pair sales:read with the area-scope check, or it becomes a
  // cross-territory enumeration hole via ?area=.
  const breakdown = readFileSync("app/api/sales/targets/breakdown/route.ts", "utf8");
  assert.match(breakdown, /assertPermission\(access, "sales", "read"\)/);
  assert.match(breakdown, /assertTargetsAreaInScope\(access, area, line, period\)/, "the relaxed breakdown read MUST enforce area AND line scope");

  // The admin page keeps the write permission only as the canEdit signal, not as the view gate.
  const adminPage = readFileSync("app/(admin)/sales/targets/page.tsx", "utf8");
  assert.match(adminPage, /assertPermission\(access, "sales", "read"\)/, "viewing the admin page is sales:read");
  assert.match(adminPage, /canAccess\(access, "sales", "import"\)/, "editing is still sales:import");
  assert.match(adminPage, /canViewTargetsAdminPage\(access\)/);

  // The nav flag and the page gate must not drift.
  const navSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.match(navSource, /showTargetsTab/, "the portal nav must expose a Targets flag");
  assert.match(
    navSource,
    /showTargetsTab:\s*isMedicalRep \|\|/,
    "a Medical Rep must get the Targets link — the page serves them their own targets (owner, 2026-09-16)",
  );
  const catalogSource = readFileSync("src/config/system-navigation.ts", "utf8");
  const targetsEntry = catalogSource.split("\n").find((line) => line.includes('href: "/employee-portals/targets"')) ?? "";
  assert.match(targetsEntry, /roles: \[[^\]]*"Medical Rep"/, "the navigation catalogue's Targets entry must list Medical Rep too");
  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(
    layoutSource,
    /href: "\/employee-portals\/targets"/,
    "a computed flag with no rendered link is invisible — the layout must render Targets",
  );
}
