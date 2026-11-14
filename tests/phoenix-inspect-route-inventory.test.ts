import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRouteInventory,
  evaluateCondition,
  nestedRoutesOf,
  pageFileForPath,
  pagePathFor,
  parsePortalRail,
  permissionLookupFor,
  shellFor,
} from "../scripts/phoenix-inspect/lib/route-inventory.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { assignablePhoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { canSeeDoctorCoverage } from "../src/lib/crm/doctor-coverage-roles.ts";
import { KPI_TABS, PORTAL_KPI_SUMMARY_TABS } from "../src/lib/crm/kpis-tabs.ts";
import { EMPLOYEE_PORTAL_SIDEBAR_ROWS } from "../src/lib/employee-portal/sidebar-rows.ts";

/**
 * Phoenix Visual Intelligence, phase B: the route inventory is DERIVED from the code the sidebars
 * run, never typed. These pin that derivation — the admin and HR halves are exactly getSections'
 * answer, the portal half is the layout's own rows, and the KPIs board (the first module the
 * explorer covers) is offered to exactly the roles canSeeDoctorCoverage lets in.
 */

const PORTAL_KPI_ROUTES = [
  "/employee-portals/kpis",
  "/employee-portals/kpis/frequency",
  "/employee-portals/kpis/coverage",
  "/employee-portals/kpis/call-rate",
];

export function runPhoenixInspectRouteInventoryTests() {
  const inventory = buildRouteInventory(process.cwd());
  const roles = [...assignablePhoenixRoles] as PhoenixRole[];

  assert.deepEqual(inventory.roles, roles, "every assignable role is inventoried, in the permissions file's order");
  assert.equal(inventory.unevaluated.length, 0, "every portal row condition is evaluated, none guessed");
  for (const role of roles) {
    assert.ok(inventory.entries.some((entry) => entry.role === role), `${role} must have at least one sidebar row`);
  }

  // Admin and HR rails: exactly what the sidebar computes, row for row.
  for (const role of roles.filter((r) => shellFor(r) !== "employee-portal")) {
    const mode = shellFor(role) === "hr" ? "hr" : "admin";
    const expected = getSections(getNavigationSections(mode), mode, permissionLookupFor(role), role).flatMap((section) =>
      section.items.map((item) => `${section.label} › ${item.label} › ${item.href}`),
    );
    const actual = inventory.entries
      .filter((entry) => entry.role === role)
      .map((entry) => `${entry.section} › ${entry.sidebarLabel} › ${entry.route}`);
    assert.deepEqual(actual, expected, `${role}'s inventory rows must be getSections' rows`);
  }

  // Every row names the page that serves it — no row points at nothing.
  const orphans = inventory.entries.filter((entry) => !entry.pageFile).map((entry) => `${entry.role} ${entry.route}`);
  assert.deepEqual(orphans, [], "every inventoried row resolves to a page file");

  // The portal rail parse agrees with the server-side mirror of the same rail.
  const rail = parsePortalRail(readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8"));
  assert.ok(rail.length >= 40, `the portal rail parse must find the rail's rows (found ${rail.length})`);
  assert.deepEqual(
    rail.map((row) => `${row.section} › ${row.label} › ${row.href}`),
    EMPLOYEE_PORTAL_SIDEBAR_ROWS.map((row) => `${row.section} › ${row.label} › ${row.href}`),
    "the inventory reads the same portal rows, in the same order, as sidebar-rows.ts mirrors",
  );
  assert.equal(rail.find((row) => row.href === "/employee-portals/kpis")?.condition, "showKpisTab");
  assert.equal(rail.find((row) => row.href === "/employee-portals/payslips")?.condition, null, "a bare row has no condition");

  // KPIs: offered to exactly the roles the page's own gate admits, and to nobody else.
  for (const role of roles) {
    const kpiRows = inventory.entries.filter((entry) => entry.role === role && entry.pagePath.includes("/kpis"));
    if (!canSeeDoctorCoverage(role)) {
      assert.deepEqual(kpiRows.map((entry) => entry.route), [], `${role} cannot see doctor coverage, so no KPIs row`);
      continue;
    }
    if (shellFor(role) === "employee-portal") {
      assert.deepEqual(kpiRows.map((entry) => entry.route), PORTAL_KPI_ROUTES, `${role} gets the four portal KPIs rows`);
      const summary = kpiRows[0];
      assert.deepEqual(summary.visibleTabs, [...PORTAL_KPI_SUMMARY_TABS]);
      assert.equal(summary.section, "KPIs");
      assert.equal(summary.authRequirements.portalCondition, "showKpisTab");
      assert.deepEqual(summary.authRequirements.pagePermissionGates, ["crm_visits:read"]);
    } else {
      assert.equal(kpiRows.length, 1, `${role} gets one KPIs row`);
      assert.equal(kpiRows[0].pagePath, "/admin/kpis");
      assert.equal(kpiRows[0].sidebarLabel, "KPIs");
      assert.deepEqual(kpiRows[0].visibleTabs, [...KPI_TABS]);
      assert.equal(kpiRows[0].entryState.defaultTab, "summary");
      assert.ok(kpiRows[0].nestedRoutes.includes("/admin/kpis/call-rate/[rep]"), "the rep drill-down is nested under it");
      if (shellFor(role) === "hr") assert.equal(kpiRows[0].route, "/hr/admin/kpis", "the HR rail links through /hr");
    }
  }
  assert.ok(!(roles as string[]).includes("M2"), "'M2' is not a Phoenix role (the kickoff named it; the source has none)");

  // The helpers, on their own.
  assert.equal(pagePathFor("/hr/admin/kpis?tab=call-rate"), "/admin/kpis");
  assert.equal(pagePathFor("/hr"), "/");
  assert.equal(pagePathFor("/admin/kpis#top"), "/admin/kpis");
  assert.equal(pagePathFor("/hrx/page"), "/hrx/page", "only the /hr/ namespace is rewritten");

  assert.equal(evaluateCondition("a && !b", { a: true, b: false }), true);
  assert.equal(evaluateCondition("a || b", { a: false, b: false }), false);
  assert.equal(evaluateCondition("(a || b) && c", { a: false, b: true, c: true }), true);
  assert.equal(evaluateCondition("a && missing", { a: true }), null, "an unknown flag is unevaluated, never false");
  assert.equal(evaluateCondition("a.b", { a: true }), null, "a property read is not evaluated");
  assert.equal(evaluateCondition("f()", { f: true }), null, "a call is not evaluated");
  assert.equal(evaluateCondition("a ? b : c", { a: true, b: true, c: false }), null, "a ternary is not evaluated");

  const pages = [
    { route: "/employee-portals", file: "app/employee-portals/page.tsx" },
    { route: "/employee-portals/field-crm", file: "app/employee-portals/field-crm/page.tsx" },
    { route: "/employee-portals/field-crm/[module]", file: "app/employee-portals/field-crm/[module]/page.tsx" },
    { route: "/docs/[...slug]", file: "app/docs/[...slug]/page.tsx" },
  ];
  assert.equal(pageFileForPath(pages, "/employee-portals/field-crm"), "app/employee-portals/field-crm/page.tsx");
  assert.equal(pageFileForPath(pages, "/employee-portals/field-crm/plan"), "app/employee-portals/field-crm/[module]/page.tsx");
  assert.equal(pageFileForPath(pages, "/employee-portals/field-crm/plan/extra"), null, "[module] matches one segment only");
  assert.equal(pageFileForPath(pages, "/docs/a/b/c"), "app/docs/[...slug]/page.tsx");
  assert.equal(pageFileForPath(pages, "/nowhere"), null);

  const routes = ["/a", "/a/b", "/a/b/c", "/a/d", "/ab"];
  assert.deepEqual(nestedRoutesOf("/a", routes), ["/a/b", "/a/b/c", "/a/d"], "/ab is not under /a");
  assert.deepEqual(nestedRoutesOf("/a", routes, ["/a", "/a/b"]), ["/a/d"], "a deeper row of the same role keeps its own routes");
  assert.deepEqual(nestedRoutesOf("/", routes), [], "the root claims nothing");
}
