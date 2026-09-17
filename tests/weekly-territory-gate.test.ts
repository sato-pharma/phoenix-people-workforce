import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { permissionMatrix, phoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { PORTAL_WEEKLY_ROLES } from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import {
  WEEKLY_TERRITORY_VIEWER_ROLES,
  assertWeeklyTerritoryViewer,
  isWeeklyTerritoryViewerRole,
} from "../src/lib/sales/weekly/territory-gate.ts";

// The weekly TERRITORY views refuse a Medical Rep (owner, 2026-09-16).
//
// The matrix grants Medical Rep `weekly_sales:read`, and four admin routes and three portal Sales
// Analytics pages gated on that grant alone. A rep's weekly scope is his whole line across his whole
// region, so each of them handed him his line's numbers for the whole region, depot branch by branch
// and distributor by distributor; the pages and the two management workbooks also named the region's
// other areas with their figures, and the workbooks named his managers. His own screen
// (/employee-portals/weekly-sales) is the only weekly view meant for him. The grant stays; the role
// gate is what refuses him, so this pins the gate at every door AND pins that no manager lost the door
// with him.
//
// The three portal Sales Analytics weekly pages, and the hub whose Weekly tile this also pinned, were
// deleted when the owner retired that module on 2026-09-17; their addresses now redirect to his own
// screen (tests/sales-analytics-retired.test.ts), so the four admin routes are every door left.

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const MANAGER_ROLES = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
] as const satisfies readonly PhoenixRole[];

const ADMIN_ROUTES = [
  { path: "../app/api/sales/weekly/dashboard/route.ts", label: "the admin weekly dashboard API" },
  { path: "../app/api/sales/weekly/export/route.ts", label: "the weekly BI workbook export" },
  { path: "../app/api/sales/weekly/summary-export/route.ts", label: "the weekly Summarized Report export" },
  { path: "../app/api/sales/weekly/nsm-dsm-export/route.ts", label: "the weekly NSM/DSM workbook export" },
] as const;

// Everything a route does after the gate that costs a rate-limit slot or reads weekly data.
const WORK_AFTER_THE_GATE = [
  "assertExportRateLimit(",
  "resolveWeeklyAccessScope(",
  "loadWeeklyDashboard(",
  "listWeeklyBatches(",
  "loadWeeklyManagerIndex(",
  "loadWeeklyAreaSplitIndex(",
  "listMasterAreas(",
  "loadMonthlyTargets(",
] as const;

export function runWeeklyTerritoryGateTests() {
  // ── 1. the role decision ────────────────────────────────────────────────────────────────────
  assert.equal(isWeeklyTerritoryViewerRole("Medical Rep"), false, "a Medical Rep is not a weekly territory viewer");
  assert.throws(
    () => assertWeeklyTerritoryViewer({ role: "Medical Rep" }),
    // isForbiddenError (src/lib/auth/server.ts) keys on this prefix; it is what makes the routes answer 403.
    (error: unknown) => error instanceof Error && /^Forbidden:/.test(error.message),
    "a Medical Rep is refused with the 'Forbidden:' error the weekly routes turn into a 403",
  );

  for (const role of MANAGER_ROLES) {
    assert.equal(isWeeklyTerritoryViewerRole(role), true, `${role} still reads the weekly territory views`);
    assert.doesNotThrow(() => assertWeeklyTerritoryViewer({ role }), `${role} passes the territory gate`);
  }
  for (const role of PORTAL_WEEKLY_ROLES) {
    assert.ok(WEEKLY_TERRITORY_VIEWER_ROLES.includes(role), `${role} reads the managers' portal dashboard, so it keeps the admin views too`);
  }

  // The grant is not what refuses him, so it must still be there for the refusal to mean anything.
  const readers = phoenixRoles.filter((role) => permissionMatrix[role].weekly_sales?.includes("read"));
  assert.ok(readers.includes("Medical Rep"), "Medical Rep still holds weekly_sales:read; the gate, not the grant, refuses him");
  for (const role of readers) {
    if (role === "Medical Rep") continue;
    assert.equal(isWeeklyTerritoryViewerRole(role), true, `${role} holds weekly_sales:read and keeps the weekly territory views`);
  }

  // Fail closed: a role outside the managers' posture gets nothing, even if it is granted the read later.
  for (const role of ["Employee", "Manager", "Training Manager", "Finance Manager", "HR Operations"] as const) {
    assert.equal(isWeeklyTerritoryViewerRole(role), false, `${role} is not a weekly territory viewer by default`);
  }

  // ── 2. the four admin routes ────────────────────────────────────────────────────────────────
  for (const route of ADMIN_ROUTES) {
    const source = readSource(route.path);
    assert.match(
      source,
      /import \{ assertWeeklyTerritoryViewer \} from "@\/lib\/sales\/weekly\/territory-gate";/,
      `${route.label} imports the territory gate`,
    );
    const handler = source.slice(source.indexOf("export async function GET("));
    const permission = handler.indexOf('await assertPermission(access, "weekly_sales", "read");');
    const gate = handler.indexOf("assertWeeklyTerritoryViewer(access);");
    assert.ok(permission > 0, `${route.label} still checks weekly_sales:read`);
    assert.ok(gate > permission, `${route.label} refuses a Medical Rep right after the permission check`);
    const work = WORK_AFTER_THE_GATE.map((call) => handler.indexOf(call)).filter((index) => index >= 0);
    assert.ok(work.length > 0, `${route.label} still loads weekly data`);
    assert.ok(
      gate < Math.min(...work),
      `${route.label} refuses a Medical Rep before any rate-limit slot or weekly data read`,
    );
    assert.match(
      handler,
      /if \(isForbiddenError\(error\)\) \{[\s\S]{0,160}status: 403/,
      `${route.label} answers the refusal with 403`,
    );
  }

  // (3 pinned the same refusal on the three portal Sales Analytics weekly pages, retired 2026-09-17.)

  // ── 4. his own screen is untouched ──────────────────────────────────────────────────────────
  const ownScreen = readSource("../app/employee-portals/weekly-sales/page.tsx");
  assert.doesNotMatch(
    ownScreen,
    /territory-gate|isWeeklyTerritoryViewerRole|"weekly_sales"/,
    "the rep's own Weekly Sales screen does not ride on weekly_sales or the territory gate",
  );
}
