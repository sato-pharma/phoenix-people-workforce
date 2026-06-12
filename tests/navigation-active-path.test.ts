import assert from "node:assert/strict";

import {
  getActiveHref,
  getSections,
  isActivePath,
  permissionAllowed,
  roleAllowed,
  roleNotExcluded,
} from "../src/lib/navigation/active-path.ts";
import type { NavigationSection, NavigationSectionItem } from "../src/config/system-navigation.ts";

// Minimal typed fixture builders — the matcher functions only read href/exact/
// activeTab/permissions/roles/excludedRoles, so we synthesise items without real
// lucide icons while keeping role/permission fields type-checked.
function item(href: string, extra: Partial<NavigationSectionItem> = {}): NavigationSectionItem {
  return { href, label: href, ...extra } as unknown as NavigationSectionItem;
}
function section(id: string, items: NavigationSectionItem[]): NavigationSection {
  return { id, label: id, items } as unknown as NavigationSection;
}

export function runNavigationActivePathTests() {
  // ── isActivePath: default prefix matching ──────────────────────────────────
  assert.equal(isActivePath("/employees", item("/employees"), null), true);
  assert.equal(isActivePath("/employees/123", item("/employees"), null), true);
  assert.equal(isActivePath("/employees-archive", item("/employees"), null), false);
  assert.equal(isActivePath("/other", item("/employees"), null), false);

  // ── isActivePath: exact blocks child routes ────────────────────────────────
  assert.equal(isActivePath("/sales", item("/sales", { exact: true }), null), true);
  assert.equal(isActivePath("/sales/import", item("/sales", { exact: true }), null), false);
  assert.equal(isActivePath("/payroll/expenses", item("/payroll", { exact: true }), null), false);

  // ── isActivePath: activeTab gating (two items share a path, differ by tab) ──
  const manualExpense = item("/admin/outstation/requests?action=create-manager-expense", {
    activeTab: "create-manager-expense",
  });
  assert.equal(isActivePath("/admin/outstation/requests", manualExpense, "create-manager-expense"), true);
  assert.equal(isActivePath("/admin/outstation/requests", manualExpense, null), false);
  assert.equal(isActivePath("/admin/outstation/requests", manualExpense, "other"), false);

  // ── getActiveHref: longest exact base wins; prefix bleed is prevented ───────
  const navSections = [
    section("payroll", [
      item("/payroll", { exact: true }),
      item("/payroll/expenses", { exact: true }),
      item("/payroll/expenses/dashboard"),
    ]),
  ];
  assert.equal(getActiveHref("/payroll", navSections, null), "/payroll");
  assert.equal(getActiveHref("/payroll/expenses", navSections, null), "/payroll/expenses");
  assert.equal(getActiveHref("/payroll/expenses/dashboard", navSections, null), "/payroll/expenses/dashboard");
  assert.equal(getActiveHref("/unknown", navSections, null), null);

  // ── permissionAllowed: undefined permission / lookup defaults to allow ──────
  assert.equal(permissionAllowed(undefined, undefined), true);
  assert.equal(permissionAllowed({}, [{ resource: "sales" }]), true); // key absent → allow
  assert.equal(permissionAllowed({ "sales:read": false }, [{ resource: "sales" }]), false);
  assert.equal(permissionAllowed({ "sales:read": true }, [{ resource: "sales" }]), true);
  assert.equal(permissionAllowed({ "sales:update": false }, [{ resource: "sales", action: "update" }]), false);
  // "some" semantics: any allowed permission grants visibility.
  assert.equal(
    permissionAllowed({ "sales:read": false, "payroll:read": true }, [{ resource: "sales" }, { resource: "payroll" }]),
    true,
  );

  // ── roleAllowed ────────────────────────────────────────────────────────────
  assert.equal(roleAllowed("Super Admin", undefined), true);
  assert.equal(roleAllowed("Super Admin", ["Super Admin"]), true);
  assert.equal(roleAllowed("Talent Acquisition", ["Super Admin"]), false);
  assert.equal(roleAllowed(undefined, ["Super Admin"]), false);

  // ── roleNotExcluded ────────────────────────────────────────────────────────
  assert.equal(roleNotExcluded("Medical Rep", undefined), true);
  assert.equal(roleNotExcluded("Training Manager", ["Training Manager"]), false);
  assert.equal(roleNotExcluded("Medical Rep", ["Training Manager"]), true);
  assert.equal(roleNotExcluded(undefined, ["Training Manager"]), true);

  // ── getSections: permission/role/excludedRole filtering + empty-section drop ─
  const sections = [
    section("a", [
      item("/sales", { permissions: [{ resource: "sales" }] }),
      item("/admin/access", { roles: ["Super Admin"] }),
    ]),
    section("b", [item("/employee-portals/sales", { excludedRoles: ["Training Manager"] })]),
  ];

  // Super Admin with sales blocked: sales item filtered, access item kept.
  const superAdminAdmin = getSections(sections, "admin", { "sales:read": false }, "Super Admin");
  assert.equal(superAdminAdmin.length, 2);
  assert.deepEqual(
    superAdminAdmin[0].items.map((i) => i.href),
    ["/admin/access"],
  );

  // Talent Acquisition: access item (Super Admin only) filtered out of section a.
  const talentAcquisition = getSections(sections, "admin", {}, "Talent Acquisition");
  assert.deepEqual(
    talentAcquisition[0].items.map((i) => i.href),
    ["/sales"],
  );

  // excludedRoles only applies in employee-portal mode.
  const tmPortal = getSections(sections, "employee-portal", {}, "Training Manager");
  assert.equal(
    tmPortal.find((s) => s.id === "b"),
    undefined,
    "employee-portal: excluded role drops the item, emptying section b",
  );
  const tmAdmin = getSections(sections, "admin", {}, "Training Manager");
  assert.equal(
    tmAdmin.find((s) => s.id === "b")?.items.length,
    1,
    "admin mode: excludedRoles ignored, item retained",
  );
}
