import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getSalesScope, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { shouldRenderSalesPanels } from "../src/lib/employee-portal/sales-scope.ts";

/**
 * A non-selling viewer must never be shown a sales panel.
 *
 * The admin shell's `/workspace` (and `/hr/workspace`, which is the same page behind the HR
 * namespace rewrite) renders the medical rep's operational dashboard for EVERY role that lands on
 * it — the surface decides, not the person. That was deliberate, so no panel is orphaned, and it
 * was harmless for as long as only sales-facing roles used the shell.
 *
 * It stopped being harmless the day the two HR seats went live on it. `getSalesScope` has no arm
 * for a role that does not sell, so HR Operations, HR Advisory and Financial Advisor all fall to
 * its NONE default and are fail-closed to empty line/region/area sets. Every figure on the page is
 * then a zero that measures nothing — and the panels do not say so. The first thing on the HR
 * Operations Coordinator's home page was a strip reading Sales EGP 0 · Target EGP 0 · Achievement
 * Rate 0.0% · Gap to Target, under the words "Needs attention".
 *
 * Three of the panels (Territory Performance, Product Family Contribution, Line Performance)
 * already hide themselves on an empty array. The rest render a heading and a zero regardless, so
 * the gate has to live above them.
 */
export function runWorkspaceSalesPanelsScopeTests() {
  // ── The roles on the admin shell that do not sell ────────────────────────────
  // These three reach the workspace dashboard and have no sales scope. Listing them by name is the
  // point: if someone later gives one of them a scope arm in getSalesScope, this test says so
  // rather than silently letting the panels back in.
  const nonSellingAdminShellRoles = ["HR Operations", "HR Advisory", "Financial Advisor"] as const;
  for (const role of nonSellingAdminShellRoles) {
    const scope = getSalesScope({ role: role as PhoenixRole });
    assert.equal(scope, "NONE", `${role} must resolve to a NONE sales scope`);
    assert.equal(
      shouldRenderSalesPanels(scope),
      false,
      `${role} must not be shown the sales panels — every figure they would carry is a zero`,
    );
  }

  // ── The roles on the same shell that legitimately keep them ──────────────────
  // SFE Manager and Finance Manager have company-wide commercial oversight by an explicit switch
  // arm. The fix must not touch them, or it trades one wrong page for another.
  for (const role of ["SFE Manager", "Finance Manager"] as const) {
    const scope = getSalesScope({ role: role as PhoenixRole });
    assert.equal(scope, "COMPANY", `${role} must keep company-wide sales scope`);
    assert.equal(shouldRenderSalesPanels(scope), true, `${role} must still see the sales panels`);
  }

  // ── Every selling tier keeps its dashboard ───────────────────────────────────
  for (const scope of ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY"] as const) {
    assert.equal(shouldRenderSalesPanels(scope), true, `${scope} is a selling scope and must keep its panels`);
  }

  // ── The gate is fail-closed ──────────────────────────────────────────────────
  // A missing or unrecognised scope hides the panels. The alternative (`!== "NONE"`) would show a
  // zeroed dashboard to anyone whose payload predates the field, which is the exact bug this fixes.
  assert.equal(shouldRenderSalesPanels(null), false, "a null scope must hide the panels");
  assert.equal(shouldRenderSalesPanels(undefined), false, "an absent scope must hide the panels");

  // ── The payload must actually carry the viewer's scope ───────────────────────
  // getMedicalRepPortalData resolves salesScope at the top of the function from the viewer's own
  // auth row (so an explicit sales_scope_override is honoured) and used to throw it away.
  {
    const serviceSource = readFileSync(new URL("../src/lib/employee-portal/service.ts", import.meta.url), "utf8");
    assert.match(
      serviceSource,
      /viewerSalesScope: BusinessScope;/,
      "MedicalRepPortalData.sales must declare the viewer's sales scope",
    );
    assert.match(
      serviceSource,
      /viewerSalesScope: salesScope,/,
      "getMedicalRepPortalData must put the resolved sales scope on the payload",
    );
    // THE PAYSLIPS PAYLOAD IS A SECOND PRODUCER, and it was missed on the first pass: this suite
    // strips types, so a green run here carries no type signal at all and only CI's typecheck saw
    // it. Pinning it means the next producer added to this file is caught by the suite instead.
    assert.match(
      serviceSource,
      /viewerSalesScope: "NONE",\s+achievementPercent: 0,/,
      "the payslips payload carries no sales data, so it must declare a NONE scope",
    );
  }

  // ── The dashboard must consult it, above the panels ──────────────────────────
  // Without this the three assertions above describe a rule nothing applies.
  {
    const dashboardSource = readFileSync(
      new URL("../src/components/employee-portal/employee-portal-dashboard.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      dashboardSource,
      /const showSalesPanels = shouldRenderSalesPanels\(data\.sales\.viewerSalesScope\);/,
      "the dashboard must derive its gate from the shared rule, not re-implement it",
    );
    assert.match(
      dashboardSource,
      /\{showSalesPanels \? <ExecutiveCommandStrip data=\{data\} \/> : null\}/,
      "the Sales/Target/Achievement/Gap strip must sit behind the gate",
    );
    for (const panel of [
      "TeamRankComparisonWidget",
      "OverviewInsightsAlerts",
      "OverviewPerformanceChart",
      "TerritoryComparisonChart",
      "LinePerformanceBreakdown",
      "ToReachTargetWidget",
      "ProductFamilyBreakdown",
      "OverviewTopProducts",
    ]) {
      assert.ok(
        dashboardSource.includes(`<${panel} data={data} />`),
        `${panel} must still be rendered for a selling viewer`,
      );
    }
    // My Actions and Quick Actions are not sales panels — a non-selling viewer keeps them, which is
    // what stops this fix from replacing a wrong page with an empty one.
    assert.ok(
      dashboardSource.includes("<MyActionsPanel data={data} surface={surface} />"),
      "My Actions must stay outside the gate",
    );
    assert.ok(
      dashboardSource.includes("<QuickActionsPanel data={data} surface={surface} />"),
      "Quick Actions must stay outside the gate",
    );
  }
}
