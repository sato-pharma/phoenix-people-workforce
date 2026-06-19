import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildModuleCatalog,
  validateModuleAssignmentList,
  type ModuleControlPerson,
} from "../src/lib/admin/modules-control.ts";
import { adminNavigationSections, employeePortalNavigationSections } from "../src/config/system-navigation.ts";
import { permissionMatrix, permissionResources, phoenixRoles } from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import { accessRegistry } from "../src/lib/security/access-registry.ts";

function lookupForRole(role: (typeof phoenixRoles)[number]): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of ["read", "create", "update", "delete", "approve", "export", "import"] as const) {
      lookup[`${resource}:${action}`] = permissionMatrix[role][resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function person(overrides: Partial<ModuleControlPerson> = {}): ModuleControlPerson {
  return {
    hrId: "A-9",
    isActive: true,
    line: "CNS",
    loginId: "A-9",
    name: "A-9",
    positionTitle: "Medical Representative",
    role: "Medical Rep",
    ...overrides,
  };
}

export function runModulesControlTests() {
  const catalog = buildModuleCatalog();
  assert.ok(catalog.length > 0, "module catalog is populated");

  const moduleIds = catalog.map((module) => module.moduleId);
  assert.equal(new Set(moduleIds).size, moduleIds.length, "module IDs must be unique");
  assert.ok(moduleIds.every((moduleId) => moduleId.includes(".")), "module IDs must be stable namespaced strings");

  for (const section of [...adminNavigationSections, ...employeePortalNavigationSections]) {
    for (const item of section.items) {
      assert.ok(item.moduleId, `${item.label} must expose a moduleId`);
    }
  }

  const modulesControl = catalog.find((module) => module.href === "/admin/modules-control");
  assert.ok(modulesControl, "Modules Control sidebar item must exist");
  assert.deepEqual(modulesControl?.roles, ["Super Admin"]);
  assert.deepEqual(modulesControl?.permissions, [{ action: "read", resource: "module_control" }]);

  assert.equal(permissionResources.includes("module_control"), true, "module_control permission resource is registered");
  assert.ok(permissionMatrix["Super Admin"].module_control?.includes("read"), "Super Admin can read Modules Control");
  assert.ok(permissionMatrix["Super Admin"].module_control?.includes("update"), "Super Admin can update Modules Control");
  for (const role of phoenixRoles.filter((role) => role !== "Super Admin")) {
    assert.equal(permissionMatrix[role].module_control?.includes("read") ?? false, false, `${role} must not read Modules Control`);
    assert.equal(permissionMatrix[role].module_control?.includes("update") ?? false, false, `${role} must not update Modules Control`);
  }

  const salesUpload = catalog.find((module) => module.label === "Sales Upload" && module.navigationMode === "admin");
  assert.ok(salesUpload, "Sales Upload module exists");
  assert.throws(
    () => validateModuleAssignmentList({
      catalog,
      matrix: permissionMatrix,
      moduleIds: [salesUpload!.moduleId],
      navigationMode: "admin",
      people: [person()],
      targetKey: "a-9",
      targetType: "user",
    }),
    /Blocked: A-9 is Medical Rep\. Sales Upload requires sales:import\./,
    "invalid drag/drop is blocked before any database write can be attempted",
  );

  const portalSales = catalog.find((module) => module.label === "Sales" && module.navigationMode === "employee-portal");
  assert.ok(portalSales, "Employee portal Sales module exists");
  assert.doesNotThrow(() =>
    validateModuleAssignmentList({
      catalog,
      matrix: permissionMatrix,
      moduleIds: [portalSales!.moduleId],
      navigationMode: "employee-portal",
      people: [person()],
      targetKey: "a-9",
      targetType: "user",
    }),
  );

  assert.throws(
    () => validateModuleAssignmentList({
      catalog,
      matrix: permissionMatrix,
      moduleIds: [salesUpload!.moduleId],
      navigationMode: "admin",
      people: [
        person({ hrId: "SA-1", loginId: "SA-1", role: "Super Admin" }),
        person(),
      ],
      targetKey: "cns",
      targetType: "line",
    }),
    /Blocked: A-9 is Medical Rep/,
    "group assignment blocks atomically when one affected user fails validation",
  );

  const modulesControlOnly = getSections(
    adminNavigationSections,
    "admin",
    lookupForRole("Super Admin"),
    "Super Admin",
    [modulesControl!.moduleId],
  ).flatMap((section) => section.items.map((item) => item.href));
  assert.deepEqual(modulesControlOnly, ["/admin/modules-control"], "database module IDs change rendered sidebar items after reload");

  const defaultAdminHrefs = getSections(
    adminNavigationSections,
    "admin",
    lookupForRole("Super Admin"),
    "Super Admin",
    null,
  ).flatMap((section) => section.items.map((item) => item.href));
  assert.ok(defaultAdminHrefs.length > modulesControlOnly.length, "reset/no assignment returns to default sidebar behavior");

  assert.ok(
    accessRegistry.some((entry) => entry.pattern === "/api/admin/modules-control" && entry.methods.includes("PATCH")),
    "Modules Control mutation API is registered",
  );
  assert.ok(
    accessRegistry.some((entry) => entry.pattern === "/admin/modules-control" && entry.surface === "page"),
    "Modules Control page is registered",
  );

  const migration = readFileSync("supabase/migrations/20260619000713_modules_control_sidebar_assignments.sql", "utf8");
  assert.match(migration, /create table if not exists public\.sidebar_module_assignments/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.sidebar_module_assignments from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table public\.sidebar_module_assignments to service_role/);
  assert.match(migration, /sidebar_module_assignments_service_role_all/);
}
