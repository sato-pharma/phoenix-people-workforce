import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adminNavigationSections, hubPageItemGroups } from "../src/config/system-navigation.ts";
import { canViewAdminCoreAnalytics } from "../src/lib/analytics/portal-access.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { permissionActions, permissionMatrix, permissionResources } from "../src/lib/auth/permissions.ts";
import { permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

const FINANCE: PhoenixRole = "Finance Manager";
const CLOSING_HREF = "/admin/analytics/monthly-closing/details";

/**
 * Owner, 2026-08-11: the Finance Manager needs a Monthly Closing tab that exports the full workbook
 * for CNS, Pedia or Anti Infective.
 *
 * He named /sales/monthly-closing. This row points elsewhere ON PURPOSE, and that decision is what
 * this file protects, because it looks like a mistake until you check the two gates:
 *   - /sales/monthly-closing admits only Super Admin, system scope and SFE Manager, and even past
 *     that it loads its matrix behind assertPermission(sales, "import").
 *   - `sales:import` is the one action he must never hold: it gates the whole upload/publish
 *     workspace and ten other pages. Granting it to reach an export would let him PRODUCE the
 *     closing he is only meant to CONSUME.
 * So the export-only surface is the correct destination, and the assertions below pin both the row
 * and the three things that make it work.
 */
function lookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      lookup[key] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function sidebarHrefsFor(role: PhoenixRole): string[] {
  const lookup = lookupFor(role);
  const hrefs: string[] = [];
  for (const section of adminNavigationSections) {
    for (const item of section.items) {
      if (
        permissionAllowed(lookup, item.permissions) &&
        roleAllowed(role, item.roles) &&
        roleNotExcluded(role, item.excludedRoles)
      ) {
        hrefs.push(item.href);
      }
    }
  }
  return hrefs;
}

/**
 * Hub CARDS, not sidebar rows. command-palette.tsx folds these back into Cmd+K for every viewer
 * whose role allows them, regardless of whether the parent hub row is visible — so sidebarHrefsFor
 * cannot see them, and a card that is hidden only by hiding its hub is not hidden at all.
 */
function hubCardHrefsFor(role: PhoenixRole): string[] {
  const lookup = lookupFor(role);
  return hubPageItemGroups.flatMap((group) =>
    group.items
      .filter(
        (item) =>
          permissionAllowed(lookup, item.permissions) &&
          roleAllowed(role, item.roles) &&
          roleNotExcluded(role, item.excludedRoles),
      )
      .map((item) => item.href),
  );
}

export function runFinanceManagerMonthlyClosingRowTests() {
  const hrefs = sidebarHrefsFor(FINANCE);

  // ── The row ────────────────────────────────────────────────────────────────
  assert.ok(
    hrefs.includes(CLOSING_HREF),
    "the Finance Manager must have a Monthly Closing row — his grant survived a nav change that removed his only door, leaving an export he could not click",
  );
  assert.ok(
    !hrefs.includes("/sales/monthly-closing"),
    "the upload/publish workspace must NOT be in his sidebar — its page redirects him, and reaching its matrix would need sales:import",
  );

  // ── Gate 1: the page's own assertPermission(sales, "read") ─────────────────
  assert.ok(
    permissionMatrix[FINANCE]?.sales?.includes("read"),
    "the closing details page asserts sales:read — without it the row 403s instead of rendering",
  );

  // ── Gate 2: canViewAdminCoreAnalytics, or the page redirects to /admin/analytics ──
  assert.equal(
    canViewAdminCoreAnalytics(FINANCE),
    true,
    "the closing details page redirects anyone outside ADMIN_CORE_ANALYTICS_ROLES — dropping him there turns this row into a bounce",
  );

  // ── The boundary that makes the destination choice correct ─────────────────
  // If he ever holds sales:import, someone has "simplified" this by pointing him at the upload
  // workspace — which hands him publish-adjacent surfaces he was deliberately kept out of.
  assert.equal(
    permissionMatrix[FINANCE]?.sales?.includes("import") ?? false,
    false,
    "the Finance Manager must NEVER hold sales:import — he consumes the closing, he does not produce it",
  );

  // ── The full-sheet guarantee ───────────────────────────────────────────────
  // Branch A of the export route is what makes his workbook the COMPLETE sheet set for any line,
  // published or not. The scoped branch silently degrades to a Data+Total-only workbook on HTTP 200,
  // so losing this naming is a quiet downgrade, not an error he would ever see.
  const exportSource = readFileSync(
    new URL("../app/api/sales/monthly-closing/export/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    exportSource,
    /access\.role === "Finance Manager"/,
    "the monthly-closing export route must still name Finance Manager in its full-workbook branch — " +
      "without it he silently gets a Data+Total-only sheet on HTTP 200 instead of CNS/Pedia/Anti Infective in full",
  );

  // ── Achievement Dash is not his (owner, 2026-08-11) ───────────────────────
  // Asserted against the CARD list, not the sidebar: this is a hub card, and Cmd+K re-admits cards
  // by role whatever the parent hub does. His bare `sales` grant satisfies its
  // { resource: "sales" } permission, so excludedRoles is the only thing keeping it shut.
  const cards = hubCardHrefsFor(FINANCE);
  assert.ok(
    !cards.includes("/sales/monthly-dashboard"),
    "Achievement Dash must NOT be reachable by the Finance Manager — it reads sales performance against target, " +
      "which is sales-management reporting, not a finance duty. Hiding its hub would not close it; only excludedRoles does",
  );
  // The card must survive for the roles the owner did not remove, so "exclude one" never becomes
  // "delete the card".
  assert.ok(
    hubCardHrefsFor("SFE Manager").includes("/sales/monthly-dashboard"),
    "SFE Manager must keep Achievement Dash — this change excluded one role, not the card",
  );

  // ── Roles this row must not leak to ────────────────────────────────────────
  for (const role of ["Super Admin", "CEO"] as PhoenixRole[]) {
    assert.ok(
      !sidebarHrefsFor(role).includes(CLOSING_HREF),
      `${role} must not pick up this dedicated Finance row — they reach closing through their own surfaces`,
    );
  }
}
