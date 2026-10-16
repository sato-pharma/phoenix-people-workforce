import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MODULE_LABELS,
  isNavItemLockedFor,
  moduleLabel,
  resolveLockedModuleForPath,
  resolveModulesForPath,
} from "../src/lib/navigation/module-catalog.ts";
import {
  NEVER_LOCKABLE_RESOURCES,
  UNLOCKABLE_ADMIN_RESOURCES,
  describeModuleLockRefusal,
  isLockableModule,
} from "../src/lib/auth/module-locks.ts";
import { permissionMatrix, permissionResources, phoenixRoles } from "../src/lib/auth/permissions.ts";

/**
 * Temporary per-account module locks — the rules a wrong answer would hurt someone with.
 *
 * Four things are pinned here, and each one has a failure that looks like something else:
 *
 *   • MODULE_LABELS totality. `ignoreBuildErrors` is on in this repo, so an exhaustive `Record`
 *     does NOT gate the build — a missing key compiles, ships, and renders a BLANK module name in
 *     the picker, which reads as "no such module" rather than as a bug.
 *   • The address map. Getting it wrong means a locked person opens a page that was never mapped
 *     and is let straight in, or a page is locked whose module was not.
 *   • The OR rule. A page reachable through either of two grants must stay open while only one of
 *     them is locked — otherwise locking a broad module quietly closes pages nobody chose.
 *   • The two structural refusals. Both exist to stop someone locking themselves out of the screen
 *     the release is performed from; the damage is unrecoverable from inside the application.
 */

export function runModuleLockCatalogTests() {
  // Every permission resource must have a human name — see the header.
  const missing = permissionResources.filter((resource) => !MODULE_LABELS[resource]);
  assert.deepEqual(missing, [], "every permission resource needs a MODULE_LABELS entry");

  const extra = Object.keys(MODULE_LABELS).filter(
    (key) => !permissionResources.includes(key as (typeof permissionResources)[number]),
  );
  assert.deepEqual(extra, [], "MODULE_LABELS must not name a resource that no longer exists");

  // No blank or code-shaped label: the owner's standing rule is human names, never raw keys.
  // Written as filters rather than a `for (const … of permissionResources)` loop on purpose — that
  // exact shape is what tests/permission-lookup-totality.test.ts sweeps for, and it reads any
  // occurrence in a test file as a hand-rolled copy of the permission lookup.
  const blank = permissionResources.filter((resource) => !MODULE_LABELS[resource]?.trim());
  assert.deepEqual(blank, [], "every module label must be a non-empty name");

  const keyShaped = permissionResources.filter((resource) => /_/.test(MODULE_LABELS[resource] ?? ""));
  assert.deepEqual(keyShaped, [], "a module label must read as a name, never as a raw permission key");

  // An unknown key falls back to something readable rather than rendering nothing.
  assert.ok(moduleLabel("not_a_module").length > 0, "moduleLabel must never return an empty string");
  assert.equal(moduleLabel("payroll"), "Payroll");
}

export function runModuleLockAddressMapTests() {
  // A real address resolves to a real module. /payroll is the Payroll Report card, gated on
  // payroll — if this ever fails, the map has stopped being derived from the navigation config.
  assert.deepEqual(resolveModulesForPath("/payroll"), ["payroll"]);

  // A DETAIL page with no navigation entry of its own inherits its nearest ancestor's module. This
  // is what makes a lock cover a whole module rather than only its landing page.
  assert.deepEqual(
    resolveModulesForPath("/payroll/2026-08/some-run-id"),
    ["payroll"],
    "a page below a mapped address must inherit that address's modules",
  );

  // Query strings and hashes name a tab, never a different module.
  assert.deepEqual(resolveModulesForPath("/payroll?tab=held#row"), ["payroll"]);

  // The PORTAL is covered too — its rows carry no permission metadata, so the portal registry is
  // what puts them in the map. Without this the padlock never appears on an employee's sidebar.
  assert.deepEqual(resolveModulesForPath("/employee-portals/expenses"), ["expenses"]);

  // Incentive is a module of its own (owner, 2026-10-16). Its portal tab and its admin-shell
  // workspace page both used to gate on Employee Profile — the one module that can never be locked —
  // so the picker could not offer it. Both addresses must now resolve to it, and the workspace page
  // is a TAB inside the workspace frame with no sidebar row, so only the personal-workspace list
  // puts it in the map: without that, a locked person is bounced away without reading the sentence.
  assert.deepEqual(resolveModulesForPath("/employee-portals/incentive"), ["incentive"]);
  assert.deepEqual(resolveModulesForPath("/workspace/incentive"), ["incentive"]);
  assert.equal(resolveLockedModuleForPath("/workspace/incentive", ["incentive"]), "incentive");
  assert.equal(resolveLockedModuleForPath("/workspace/incentive", ["payslips"]), null);
  assert.equal(isLockableModule("incentive"), true);
  // Nobody gains or loses the tab: every role that could open the page through Employee Profile
  // holds Incentive, and no role holds it without Employee Profile.
  const incentiveDrift = phoenixRoles.filter(
    (role) =>
      Boolean(permissionMatrix[role].employee_profile?.includes("read")) !==
      Boolean(permissionMatrix[role].incentive?.includes("read")),
  );
  assert.deepEqual(incentiveDrift, [], "incentive:read must be held by exactly the roles that hold employee_profile:read");
  assert.ok(
    phoenixRoles.some((role) => permissionMatrix[role].incentive?.includes("read")),
    "at least one role must hold incentive:read, or the picker offers Incentive to nobody",
  );

  // An address no navigation entry covers resolves to nothing, and is therefore never locked. The
  // page still refuses itself through assertPermission; it just words the refusal plainly.
  assert.deepEqual(resolveModulesForPath("/definitely-not-a-phoenix-page"), []);
  assert.equal(resolveLockedModuleForPath("/definitely-not-a-phoenix-page", ["payroll"]), null);

  // The lock itself.
  assert.equal(resolveLockedModuleForPath("/payroll", ["payroll"]), "payroll");
  assert.equal(resolveLockedModuleForPath("/payroll", ["leave"]), null);
  assert.equal(resolveLockedModuleForPath("/payroll", []), null);

  // A page reachable through EITHER of two grants stays open while only one is locked. /payslips is
  // gated on payroll OR payslips, so locking payroll alone must not close it — otherwise locking a
  // broad module quietly shuts pages nobody chose.
  assert.deepEqual(resolveModulesForPath("/payslips"), ["payroll", "payslips"]);
  assert.equal(resolveLockedModuleForPath("/payslips", ["payroll"]), null);
  assert.ok(resolveLockedModuleForPath("/payslips", ["payroll", "payslips"]));
}

export function runModuleLockNavRowTests() {
  // No locks: nothing is ever padlocked.
  assert.equal(isNavItemLockedFor({ permissions: [{ resource: "payroll" }] }, []), false);

  // One permission, locked.
  assert.equal(isNavItemLockedFor({ permissions: [{ resource: "payroll" }] }, ["payroll"]), true);

  // TWO permissions are an OR: the row still opens through the unlocked one, so it must NOT wear a
  // padlock. This is the rule that keeps the tab and the page it opens telling the same story.
  const twoWays = { permissions: [{ resource: "payroll" as const }, { resource: "admin" as const }] };
  assert.equal(isNavItemLockedFor(twoWays, ["payroll"]), false);
  assert.equal(isNavItemLockedFor(twoWays, ["payroll", "admin"]), true);

  // No permissions at all: fall back to the address, because every portal row is in that shape.
  assert.equal(isNavItemLockedFor({ href: "/employee-portals/expenses" }, ["expenses"]), true);
  assert.equal(isNavItemLockedFor({ href: "/employee-portals/expenses" }, ["leave"]), false);

  // Neither permissions nor an href — nothing to name, so nothing to lock.
  assert.equal(isNavItemLockedFor({}, ["payroll"]), false);
}

export function runModuleLockRefusalTests() {
  // Employee Profile is the portal's own entry gate: EmployeePortalServerShell asserts
  // employee_profile:read and redirects to /login when it is refused. Locking it would bounce the
  // person between the portal and the login screen with no page able to explain why.
  assert.ok(NEVER_LOCKABLE_RESOURCES.includes("employee_profile"));
  assert.equal(isLockableModule("employee_profile"), false);
  assert.equal(isLockableModule("payroll"), true);

  assert.ok(
    describeModuleLockRefusal({ loginId: "someone", moduleKey: "employee_profile" }),
    "employee_profile must be refused with a sentence, not silently accepted",
  );

  // Nobody locks their own account — the person who does it is the person who cannot undo it.
  // Matched case-insensitively, because a login id typed with different casing is the same person.
  assert.ok(
    describeModuleLockRefusal({
      loginId: "Owner.Account",
      moduleKey: "payroll",
      actorLoginId: "owner.account",
    }),
    "locking your own account must be refused whatever the casing",
  );

  // Administration on a Super Admin account is the screen the release is performed from.
  for (const resource of UNLOCKABLE_ADMIN_RESOURCES) {
    assert.ok(
      describeModuleLockRefusal({
        loginId: "someone.else",
        moduleKey: resource,
        actorLoginId: "the.admin",
        targetRole: "Super Admin",
      }),
      `${resource} must be refused on a Super Admin account`,
    );
    // ...but the very same module on a NON Super Admin account is an ordinary lock.
    assert.equal(
      describeModuleLockRefusal({
        loginId: "someone.else",
        moduleKey: resource,
        actorLoginId: "the.admin",
        targetRole: "Medical Rep",
      }),
      null,
      `${resource} must still be lockable on a non Super Admin account`,
    );
  }

  // The ordinary case goes through.
  assert.equal(
    describeModuleLockRefusal({
      loginId: "someone.else",
      moduleKey: "payroll",
      actorLoginId: "the.admin",
      targetRole: "Finance Manager",
    }),
    null,
  );
}

export function runModuleLockGuardSourceTests() {
  // WHY THIS IS A SOURCE TEST. The defect it pins is architectural, not arithmetic: the Super Admin
  // guard used to read the target account's ROLE out of the POST body, so a request that simply
  // omitted the field sailed straight past it. Measured on staging on 2026-08-30 — a POST naming a
  // live Super Admin account locked its Administration module, which is the screen the release is
  // performed from. Nothing in the pure unit tests below could see it, because they hand
  // describeModuleLockRefusal a role directly; the bug was entirely in WHERE the role came from.
  //
  // Whole-file substring checks, never a byte window — a pin that slices a fixed offset false-fails
  // the moment anything above it shifts.
  const route = readFileSync("app/api/admin/module-locks/route.ts", "utf8");
  const service = readFileSync("src/lib/auth/module-locks.ts", "utf8");
  const manager = readFileSync("src/components/admin/module-locks-manager.tsx", "utf8");

  assert.ok(
    !route.includes("targetRole"),
    "the API route must never read the target account's role from the request body",
  );
  assert.ok(
    !manager.includes("targetRole"),
    "the admin screen must not send the target's role — a guard the client states is a guard the client can drop",
  );
  assert.ok(
    route.includes("describeModuleLockRefusalForAccount"),
    "the route must ask the refusal that resolves the target from the database",
  );
  assert.ok(
    service.includes("await describeModuleLockRefusalForAccount("),
    "lockModuleForAccount must re-ask the database-backed refusal itself — an API client that skips the screen still has to meet the guard",
  );
  assert.ok(
    service.includes("loadLockTargetAccount"),
    "the service must look the target account up rather than take it on trust",
  );
}
