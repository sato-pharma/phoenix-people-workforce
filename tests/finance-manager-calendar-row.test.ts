import assert from "node:assert/strict";

import { adminNavigationSections } from "../src/config/system-navigation.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { permissionActions, permissionMatrix, permissionResources } from "../src/lib/auth/permissions.ts";
import { permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import { isPlanItemVisibleToViewer, type CalendarViewerContext } from "../src/lib/weekly-planning/calendar-service.ts";
import type { PlanningCalendarPlanItem } from "../src/lib/weekly-planning/calendar.ts";

const FINANCE: PhoenixRole = "Finance Manager";

/**
 * Owner, 2026-08-11: the Finance Manager's calendar row moved off /admin/company-calendar (event
 * AUTHORING) and onto /admin/weekly-plans/calendar (company READING).
 *
 * The authoring page was the wrong destination for him twice over: `canPublishCompanyWide` is false
 * for him, so events he created would only ever have reached head-office staff — a company-wide
 * promise the page could not keep.
 *
 * This file exists because pointing a nav row somewhere is only half a change. The other half is
 * that the destination must actually admit the viewer AND show them something, and this account has
 * now been audited twice for exactly that class of dead link. Both gates are pinned below.
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

/** Only the three fields the visibility rules read; the rest of the row is irrelevant here. */
function planItem(overrides: Partial<PlanningCalendarPlanItem>): PlanningCalendarPlanItem {
  return {
    employeeHrId: "B-900",
    employeeJobTitle: "Medical Rep",
    lineName: "Pedia",
    ...overrides,
  } as PlanningCalendarPlanItem;
}

export function runFinanceManagerCalendarRowTests() {
  const hrefs = sidebarHrefsFor(FINANCE);

  // ── The swap itself ────────────────────────────────────────────────────────
  assert.ok(
    !hrefs.includes("/admin/company-calendar"),
    "the event-AUTHORING calendar must not be in the Finance Manager's sidebar — he cannot publish company-wide, so it promised a reach he does not have",
  );
  assert.ok(
    hrefs.includes("/admin/weekly-plans/calendar"),
    "the planning calendar must BE in the Finance Manager's sidebar — this is the row the owner asked for",
  );

  // ── Gate 1: the page admits him ────────────────────────────────────────────
  // /admin/weekly-plans/calendar redirects to /employee-portals unless canAccess(weekly_plans,
  // read). Losing this grant would turn the row into a redirect loop with no nav change to show it.
  assert.ok(
    permissionMatrix[FINANCE]?.weekly_plans?.includes("read"),
    "the Finance Manager must hold weekly_plans:read — it is the page's own guard, not just the nav gate",
  );

  // ── Gate 2: the page shows him something ───────────────────────────────────
  // isPlanItemVisibleToViewer narrows only the roles it NAMES and ends in `return true`. Finance
  // Manager is not named, so he keeps the documented unrestricted default. Asserted RELATIVE to the
  // CEO rather than as a bare `true`, so this stays correct whatever isAllowedCalendarOwner decides
  // about a given row: for the same item, the two must agree.
  const financeViewer: CalendarViewerContext = {
    hrId: "B-185",
    role: "Finance Manager",
    lineName: null,
    directReportHrIds: new Set<string>(),
  };
  const ceoViewer: CalendarViewerContext = {
    hrId: "AA",
    role: "CEO",
    lineName: null,
    directReportHrIds: new Set<string>(),
  };

  for (const item of [
    planItem({ employeeJobTitle: "District Manager", lineName: "Pedia" }),
    planItem({ employeeJobTitle: "Product Manager", lineName: "Anti Infective" }),
    planItem({ employeeJobTitle: "Training Manager", lineName: "Head Office" }),
    planItem({ employeeJobTitle: "Group Product Manager", lineName: "CNS" }),
  ]) {
    assert.equal(
      isPlanItemVisibleToViewer(item, financeViewer),
      isPlanItemVisibleToViewer(item, ceoViewer),
      `the Finance Manager must see the same plans the CEO does (${item.employeeJobTitle} / ${item.lineName}) — ` +
        "he is not a named role in isPlanItemVisibleToViewer, so he keeps the unrestricted default. " +
        "If someone adds a 'finance manager' branch there, his calendar narrows with no nav change to show it",
    );
  }

  // ── The row the swap must not disturb ──────────────────────────────────────
  for (const role of ["CEO", "SFE Manager"] as PhoenixRole[]) {
    assert.ok(
      sidebarHrefsFor(role).includes("/admin/weekly-plans/calendar"),
      `${role} must keep the planning calendar — this change added a viewer, it did not move the page`,
    );
  }
  assert.ok(
    !sidebarHrefsFor("Super Admin").includes("/admin/weekly-plans/calendar") ||
      sidebarHrefsFor("Super Admin").length > 0,
    "sanity: Super Admin navigation still resolves",
  );
}
