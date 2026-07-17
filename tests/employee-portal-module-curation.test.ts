import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildModuleCatalog,
  validateModuleAssignmentList,
  type ModuleControlPerson,
} from "../src/lib/admin/modules-control.ts";
import { isEmployeePortalHrefCurated } from "../src/lib/employee-portal/module-curation.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { visiblePortalNavEntries } from "../src/components/employee-portal/employee-portal-nav-registry.ts";

/**
 * Coverage for wiring the "Employee Portal Sidebar" Modules Control curation mode
 * (previously built but inert — see admin/modules-control.ts) into the actual
 * portal nav surfaces (desktop sidebar/top nav in employee-portal-layout.tsx, and
 * the mobile bottom nav / profile quick-nav grid in employee-portal-nav-registry.ts).
 */
export function runEmployeePortalModuleCurationTests() {
  const catalog = buildModuleCatalog().filter((navModule) => navModule.navigationMode === "employee-portal");
  const findModule = (href: string, label: string) => {
    const found = catalog.find((navModule) => navModule.href === href && navModule.label === label);
    assert.ok(found, `catalog module ${href} / "${label}" exists`);
    return found!;
  };

  const deductions = findModule("/employee-portals/deductions", "Deductions");
  const myCoaching = findModule("/employee-portals/coaching", "My Coaching Reports");
  const teamCoaching = findModule("/employee-portals/coaching", "Team Coaching Reports");
  assert.notEqual(
    myCoaching.moduleId,
    teamCoaching.moduleId,
    "role-variant labels sharing an href must resolve to distinct moduleIds",
  );

  // (a) effectiveModuleIds === null (no override configured) — every destination stays
  // visible, whether or not it even exists in the Modules Control catalog.
  assert.equal(isEmployeePortalHrefCurated("/employee-portals/deductions", null), true);
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/incentive", null),
    true,
    "hrefs the catalog has no entry for are unaffected when no override is configured",
  );

  // (b) A configured restriction actually removes a matched destination, and keeps an
  // explicitly-allowed one.
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/deductions", [deductions.moduleId]),
    true,
    "href stays visible when its moduleId is in the effective set",
  );
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/deductions", ["some.other.module"]),
    false,
    "href is hidden when the effective set does not include its moduleId",
  );
  // Legacy portal tabs (Incentive, Team Calendar, Team Performance, MRs/DSMs Performance, …)
  // were never added to the Modules Control catalog, so an admin never had a way to select
  // them — a restriction must not accidentally hide them.
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/incentive", [deductions.moduleId]),
    true,
    "hrefs absent from the catalog stay visible even under an active restriction",
  );

  // (c) Role-variant edge case: /employee-portals/coaching carries two catalog labels
  // ("My Coaching Reports" for Medical Rep, "Team Coaching Reports" for District/National
  // Sales Manager). getEffectiveSidebarModuleIds already strips the wrong-role variant's
  // moduleId before returning (validateModuleForPerson), so matching by "any candidate
  // moduleId for this href" is safe — it can never let the wrong role's variant slip in.
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/coaching", [myCoaching.moduleId]),
    true,
    "coaching href visible when only the Medical Rep variant's moduleId is in the effective set",
  );
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/coaching", [teamCoaching.moduleId]),
    true,
    "coaching href visible when only the manager variant's moduleId is in the effective set",
  );
  assert.equal(
    isEmployeePortalHrefCurated("/employee-portals/coaching", ["some.other.module"]),
    false,
    "coaching href hidden when neither role variant's moduleId is present",
  );

  // End-to-end through the actual bottom-nav/profile-grid registry (same helper the mobile
  // surfaces call): restricting a Medical Rep to Deductions only removes Coaching.
  const medicalRepVisibility = resolveEmployeePortalNavVisibility("Medical Rep");
  const restrictedEntries = visiblePortalNavEntries(medicalRepVisibility, [deductions.moduleId]);
  assert.ok(
    restrictedEntries.every((entry) => entry.href !== "/employee-portals/coaching"),
    "restricting to Deductions only removes My Coaching Reports from the bottom-nav registry",
  );
  assert.ok(
    restrictedEntries.some((entry) => entry.href === "/employee-portals/deductions"),
    "the explicitly allowed module stays visible in the bottom-nav registry",
  );

  const unrestrictedEntries = visiblePortalNavEntries(medicalRepVisibility, null);
  assert.ok(
    unrestrictedEntries.some((entry) => entry.href === "/employee-portals/coaching"),
    "with no override configured (null), My Coaching Reports still shows for a Medical Rep",
  );
  assert.ok(
    unrestrictedEntries.some((entry) => entry.href === "/employee-portals/incentive"),
    "with no override configured (null), a non-catalog tab like Incentive is unaffected",
  );

  // The "any candidate moduleId for this href" check in isEmployeePortalHrefCurated is only
  // safe because getEffectiveSidebarModuleIds can never hand back the wrong-role variant in
  // the first place — it runs the exact same validateModuleForPerson role check that Modules
  // Control uses to BLOCK an admin from assigning it. Prove that upstream guarantee directly:
  // a District Manager can never end up with the Medical Rep coaching variant in their
  // effective set, and vice versa.
  const districtManager: ModuleControlPerson = {
    hrId: "B-1",
    isActive: true,
    line: "CNS",
    loginId: "B-1",
    name: "B-1",
    positionTitle: "District Manager",
    role: "District Manager",
  };
  assert.throws(
    () => validateModuleAssignmentList({
      catalog,
      matrix: permissionMatrix,
      moduleIds: [myCoaching.moduleId],
      navigationMode: "employee-portal",
      people: [districtManager],
      targetKey: "b-1",
      targetType: "user",
    }),
    /Blocked: B-1 is District Manager\. My Coaching Reports is limited to Medical Rep\./,
    "Modules Control blocks assigning the Medical Rep coaching variant to a District Manager — the same role check that keeps getEffectiveSidebarModuleIds from ever returning it for that role",
  );
  assert.doesNotThrow(
    () => validateModuleAssignmentList({
      catalog,
      matrix: permissionMatrix,
      moduleIds: [teamCoaching.moduleId],
      navigationMode: "employee-portal",
      people: [districtManager],
      targetKey: "b-1",
      targetType: "user",
    }),
    "the manager coaching variant is assignable to a District Manager",
  );
  const medicalRepPerson: ModuleControlPerson = {
    hrId: "A-9",
    isActive: true,
    line: "CNS",
    loginId: "A-9",
    name: "A-9",
    positionTitle: "Medical Representative",
    role: "Medical Rep",
  };
  assert.throws(
    () => validateModuleAssignmentList({
      catalog,
      matrix: permissionMatrix,
      moduleIds: [teamCoaching.moduleId],
      navigationMode: "employee-portal",
      people: [medicalRepPerson],
      targetKey: "a-9",
      targetType: "user",
    }),
    /Blocked: A-9 is Medical Rep\. Team Coaching Reports is limited to District Manager, National Sales Manager\./,
    "Modules Control blocks assigning the manager coaching variant to a Medical Rep",
  );

  // With the real (role-scoped) effective set a District Manager would actually receive,
  // the sidebar/bottom-nav curation correctly keeps their own coaching variant visible.
  const districtManagerVisibility = resolveEmployeePortalNavVisibility("District Manager");
  const dmEntries = visiblePortalNavEntries(districtManagerVisibility, [teamCoaching.moduleId]);
  assert.ok(
    dmEntries.some((entry) => entry.href === "/employee-portals/coaching"),
    "restricting to the manager coaching variant keeps Team Coaching Reports visible for a District Manager",
  );

  // Structural check: the sidebar/top-nav (desktop) must apply the same curation helper.
  // (Can't execute employee-portal-layout.tsx directly under the Node harness — it imports
  // next/navigation at module scope — so this mirrors the existing convention in
  // employee-portal-navigation.test.ts of asserting on source text for that file.)
  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(
    layoutSource,
    /isEmployeePortalHrefCurated/,
    "the sidebar/top-nav layout must import the shared curation helper",
  );
  assert.match(
    layoutSource,
    /applyModuleCuration\(buildEmployeePortalSections\(visibility\), effectiveModuleIds\)/,
    "EmployeePortalTopNav must apply Modules Control curation to its menu sections",
  );
  assert.match(
    layoutSource,
    /const sections = applyModuleCuration\(buildEmployeePortalSections\(visibility\), effectiveModuleIds\);/,
    "EmployeePortalSidebar must apply Modules Control curation to its rendered sections",
  );
  assert.match(
    layoutSource,
    /effectiveModuleIds\?: string\[\] \| null;/,
    "EmployeePortalChrome props must accept an optional effectiveModuleIds override",
  );

  const serverShellSource = readFileSync("src/components/employee-portal/employee-portal-server-shell.tsx", "utf8");
  assert.match(
    serverShellSource,
    /getEffectiveSidebarModuleIds\(access, "employee-portal"\)/,
    "the portal server shell must resolve the Modules Control override for this person",
  );
}
