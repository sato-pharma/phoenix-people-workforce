import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { phoenixCrmDayPath } from "../src/lib/phoenix-crm/modules.ts";
import { resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";
import { dayRouteVisitOf, loadDayRoute } from "../src/lib/phoenix-crm/server/day-route.ts";
import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the admin calendar opens the ADMIN day, with a route map (owner, 2026-10-24).
 *
 * He pressed a square on the admin team calendar and landed on
 * `/employee-portals/field-crm/manager-day/SEAT-PED-DM-D1/2026-10-13` — out of the admin shell — while Workforce
 * Compliance's Team Calendar opens its day in a new admin tab with a route map. Asked, he chose "Admin tab plus a
 * map". So:
 *
 *   1. a square opens the day in the shell its calendar was read in (`phoenixCrmDayPath`);
 *   2. a portal-mode viewer handed an admin day address lands on the same day in the portal, test mode kept;
 *   3. the map's points go to the Super Admin and the SFE Manager alone — anyone else gets NO route, never an
 *      empty one — and only the admin pages ask for it, so the portal day page is unchanged.
 */

const ADMIN_DAY = "app/(admin)/admin/field-crm/day/[seatId]/[date]/page.tsx";
const ADMIN_MANAGER_DAY = "app/(admin)/admin/field-crm/manager-day/[seatId]/[date]/page.tsx";
const PORTAL_DAY = "app/employee-portals/field-crm/day/[seatId]/[date]/page.tsx";
const PORTAL_MANAGER_DAY = "app/employee-portals/field-crm/manager-day/[seatId]/[date]/page.tsx";

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

export async function runPhoenixCrmAdminDayPageTests(): Promise<void> {
  // ── 1. The square opens the day in its own shell ──────────────────────────────────────────────
  assert.equal(
    phoenixCrmDayPath("admin", "manager", "SEAT-PED-DM-D1", "2026-10-13", false),
    "/admin/field-crm/manager-day/SEAT-PED-DM-D1/2026-10-13",
    "the admin calendar's manager square opens the admin manager day — the address he reported landing in the portal",
  );
  assert.equal(phoenixCrmDayPath("admin", "rep", "S 1", "2026-10-13", true), "/admin/field-crm/day/S%201/2026-10-13?test=1", "a rep square, encoded, test mode kept");
  assert.equal(phoenixCrmDayPath("portal", "rep", "S", "2026-10-13", false), "/employee-portals/field-crm/day/S/2026-10-13", "the portal calendar is unchanged");
  const tab = source("src/components/phoenix-crm/calendar-tab.tsx");
  assert.match(tab, /const surface = useCrmSurface\(\);/, "the calendar reads which shell it is drawn in");
  assert.ok(!tab.includes("PHOENIX_CRM_PORTAL_BASE"), "the calendar no longer hard-wires the portal address");

  // ── 2. A portal-mode viewer handed an admin day lands on the portal day ──────────────────────────
  assert.equal(
    resolvePortalTwin("/admin/field-crm/manager-day/SEAT-PED-DM-D1/2026-10-13?test=1", "District Manager"),
    "/employee-portals/field-crm/manager-day/SEAT-PED-DM-D1/2026-10-13?test=1",
  );
  assert.equal(resolvePortalTwin("/admin/field-crm/day/SEAT-1/2026-10-13", "Medical Rep"), "/employee-portals/field-crm/day/SEAT-1/2026-10-13");

  // ── 3. The points are the Super Admin's and the SFE Manager's alone ────────────────────────────
  const visits = [{ table: "visits" as const, rowId: "00000000-0000-4000-8000-000000000000", customerName: "x", address: null }];
  const blind = { isSuperAdmin: false, isSfeManager: false } as unknown as PhoenixCrmViewer;
  assert.equal(await loadDayRoute(blind, visits), null, "a reader below the Super Admin and the SFE Manager gets no route — not an empty one");

  assert.deepEqual(dayRouteVisitOf("own:abc"), { table: "manager_visits", rowId: "abc" }, "a manager's own single visit lives in his own table");
  assert.deepEqual(dayRouteVisitOf("rep:abc"), { table: "visits", rowId: "abc" });
  assert.deepEqual(dayRouteVisitOf("ride:abc:B-10"), { table: "visits", rowId: "abc" }, "a ride-along is the rep's visit row");
  assert.equal(dayRouteVisitOf("abc"), null, "an id the loader never minted is no row");

  for (const page of [ADMIN_DAY, ADMIN_MANAGER_DAY]) {
    const text = source(page);
    assert.match(text, /\{ withRoute: true \}/, `${page} asks for the route`);
    assert.match(text, /<CrmSurfaceProvider surface="admin">/, `${page} draws the day under the admin surface`);
    assert.match(text, /<DayRouteMap route=\{load\.route\} routeUnread=\{load\.routeUnread\} \/>/, `${page} draws the map`);
  }
  for (const page of [PORTAL_DAY, PORTAL_MANAGER_DAY]) {
    assert.ok(!source(page).includes("withRoute"), `${page} never asks for the route: the portal day is unchanged`);
  }
}
