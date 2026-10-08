/**
 * THE HR BUSINESS PARTNER SEAT IS RETIRED — and stays retired without anyone remembering to.
 *
 * The owner, 2026-10-08: first "move recruiting off the HR Business Partner", then the same evening
 * "no more HR business partner. This title, no more … everything regarding recruiting is for the
 * talent acquisition". Asked who takes the rest of the seat's work — engagement and retention, the
 * hiring paperwork, the workforce reports — he answered "Leave it for system administrator now".
 *
 * WHAT "RETIRED" MEANS HERE, AND WHY IT IS NOT A DELETION. The permission key "HR Advisory" stays in
 * `phoenixRoles` as a DORMANT label (`retiredPhoenixRoles`). Every RESTRICTION written against it —
 * the salary redaction for her own manager chain above all — keeps compiling and keeps applying to
 * any stray stored copy of the role. What is gone is every GRANT: the matrix entry is empty, the
 * bundle is gone, no seat set or navigation list names it, and nobody can be given it.
 *
 * WHY THIS FILE KEEPS ITS OLD NAME. It pinned the seat's 2026-09-01 module opening, and it is
 * registered in tests/run-tests.ts under that name. It now pins the opposite, which is what a reader
 * landing on the old name most needs to learn.
 *
 * The four failures it watches for are each silent:
 *   1. A grant creeping back onto the empty matrix entry — the role is in the type, so an edit
 *      that re-adds `"HR Advisory": hrBundleGrants(...)` compiles without a murmur.
 *   2. The picker offering the seat again — `phoenixRoles.map` is the natural way to list roles.
 *   3. The server accepting it even if the picker does not — a hidden option is not a boundary.
 *   4. A screen, a seat set or a role list naming it again, so a stray holder lands somewhere.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import {
  HR_FUNCTIONS,
  HR_ROLE_BUNDLES,
  HR_SEAT_JOB_TITLES,
  hrBundleGrants,
  UNASSIGNED_HR_FUNCTIONS,
} from "../src/lib/auth/hr-functions.ts";
import { canViewManagerCvEngagement } from "../src/lib/recruitment/manager-cv-engagement.ts";
import {
  adminShellEmployeeRoles,
  assignablePhoenixRoles,
  buildPermissionLookup,
  hrAuthorityRoles,
  hrNamespaceRoles,
  permissionMatrix,
  phoenixCompanyJobTitles,
  phoenixRoles,
  retiredPhoenixRoles,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { resolvePayslipCenterAudience } from "../src/lib/payroll/payslip-center.ts";

const RETIRED: PhoenixRole = "HR Advisory";

function viewer(role: PhoenixRole, hrId: string | null = "HR-010"): AccessContext {
  return { hrId, loginId: hrId, role, scope: "self", source: "session" };
}

/** Every row this seat is actually OFFERED, flattened out of the authored /hr catalogue. */
function hrRowsFor(role: PhoenixRole): { href: string; label: string; section: string }[] {
  const lookup = buildPermissionLookup(permissionMatrix, role);
  const rows: { href: string; label: string; section: string }[] = [];
  for (const section of getNavigationSections("hr")) {
    for (const item of section.items) {
      if (item.roles && !item.roles.includes(role)) continue;
      if (item.excludedRoles?.includes(role)) continue;
      const allowed = (item.permissions ?? []).every(
        (permission) => lookup[`${permission.resource}:${permission.action ?? "read"}`] === true,
      );
      if (!allowed) continue;
      rows.push({ href: item.href, label: item.label, section: section.label });
    }
  }
  return rows;
}

/** The body of one top-level function in a source file, from its signature to the next one. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must still exist`);
  const next = source.indexOf("\nexport ", start + signature.length);
  const nextPrivate = source.indexOf("\nasync function ", start + signature.length);
  const ends = [next, nextPrivate].filter((index) => index > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

export async function runHrAdvisoryModuleAccessTests() {
  // ── 1. It is retired, and it is the only retired key ───────────────────────
  assert.deepEqual([...retiredPhoenixRoles], [RETIRED], "the HR Business Partner seat is the one retired key");
  assert.ok(phoenixRoles.includes(RETIRED), "the key stays in the type so its restrictions keep compiling");
  assert.equal(assignablePhoenixRoles.includes(RETIRED), false, "🔴 nobody may be given the retired seat");
  assert.deepEqual(
    [...assignablePhoenixRoles],
    phoenixRoles.filter((role) => role !== RETIRED),
    "every other role stays assignable — retiring one seat must not hide a live one",
  );
  for (const live of ["HR Operations", "HR Resourcing", "Super Admin"] as const) {
    assert.ok(assignablePhoenixRoles.includes(live), `${live} must still be offered in User Access`);
  }

  // ── 2. It holds nothing an ordinary employee does not ──────────────────────
  // Its own entry is empty. The hard boundaries then give EVERY role the self-service floor (open a
  // support request, ask for a business card), so the honest bound is "nothing beyond Employee".
  const granted = (role: PhoenixRole) =>
    Object.entries(buildPermissionLookup(permissionMatrix, role))
      .filter(([, allowed]) => allowed === true)
      .map(([key]) => key);
  const employeeFloor = new Set(granted("Employee"));
  const beyondFloor = granted(RETIRED).filter((key) => !employeeFloor.has(key));
  assert.deepEqual(beyondFloor, [], "🔴 the retired seat may hold nothing an ordinary Employee does not");
  for (const key of ["recruitment:read", "employees:read", "retention:read", "payslips:read", "organogram:read"]) {
    assert.equal(granted(RETIRED).includes(key), false, `${key} was hers and must stay gone`);
  }
  assert.equal(RETIRED in HR_ROLE_BUNDLES, false, "its bundle is gone from hr-functions.ts");
  assert.equal(RETIRED in HR_SEAT_JOB_TITLES, false, "its title left the seat-title map");
  assert.equal(
    (phoenixCompanyJobTitles as readonly string[]).includes("HR Business Partner"),
    false,
    'the owner: "This title, no more" — it left the company job-title list',
  );
  assert.equal(resolvePayslipCenterAudience(viewer(RETIRED)), null, "the Payslips Center audience it had is gone");

  // ── 3. The work it held is the Super Admin's, NAMED rather than dropped ────
  // "Leave it for system administrator now": the four functions only she held stay in the catalogue
  // as UNASSIGNED_HR_FUNCTIONS, so handing them to a seat later is a move, not a rebuild.
  const held = new Set<string>(Object.values(HR_ROLE_BUNDLES).flatMap((bundle) => [...bundle]));
  for (const key of UNASSIGNED_HR_FUNCTIONS) {
    assert.equal(held.has(key), false, `${key} is listed as unassigned but a seat holds it — take it off the list`);
    assert.ok(HR_FUNCTIONS.some((fn) => fn.key === key), `${key} must still be in the catalogue`);
  }
  assert.ok(
    (HR_ROLE_BUNDLES["HR Resourcing"] as readonly string[]).includes("recruiting"),
    "recruiting is the Talent Acquisition seat's — the owner: everything regarding recruiting is hers",
  );
  assert.equal(
    (HR_ROLE_BUNDLES["HR Operations"] as readonly string[]).includes("recruiting"),
    false,
    "and it did not land on HR Operations by accident",
  );

  // ── 4. No seat set, role list or screen names it ───────────────────────────
  assert.equal(hrNamespaceRoles.has(RETIRED), false, "not an /hr namespace seat");
  assert.equal((adminShellEmployeeRoles as readonly string[]).includes(RETIRED), false, "not an admin-shell seat");
  assert.equal((hrAuthorityRoles as readonly string[]).includes(RETIRED), false, "not an HR authority");
  // The /hr rail renders only for hrNamespaceRoles (asserted just above), so its open rows — Report
  // It, Excuses, the command centre — never reach her. What must hold on top of that is that no row
  // NAMES her or opens on a grant she holds, so re-adding her to the namespace alone lands nowhere.
  const namedOrGranted = hrRowsFor(RETIRED).filter((row) => {
    const item = getNavigationSections("hr").flatMap((section) => section.items).find((i) => i.href === row.href);
    return Boolean(item?.roles?.length) || Boolean(item?.permissions?.length);
  });
  assert.deepEqual(namedOrGranted, [], "🔴 no /hr row names the retired seat or opens on a grant it holds");
  assert.equal(canViewManagerCvEngagement(viewer(RETIRED)), false, "Manager CV Engagement left with recruiting");
  assert.equal(canViewManagerCvEngagement(viewer("HR Resourcing")), true, "the Talent Acquisition seat opens it");
  assert.equal(
    canViewManagerCvEngagement(viewer("HR Operations", "HR-011")),
    false,
    "it went to Talent Acquisition, not to 'HR' — HR Operations runs no pipeline",
  );
  assert.equal(canViewManagerCvEngagement(viewer("SFE Manager", "A-12")), false, "still NOT SFE");

  // ── 5. The SERVER refuses it, not only the picker ──────────────────────────
  const accessControl = readFileSync("src/lib/admin/access-control.ts", "utf8");
  const core = functionBody(accessControl, "async function upsertAccessUserCore(");
  // The whole guard, not a fragment of it: "false && retiredPhoenixRoles.has(role)" contains the
  // fragment and refuses nobody — proven by breaking it that way while this test was written.
  const refusal = core.search(/\n\s*if \(retiredPhoenixRoles\.has\(role\)\) \{\s*throw new Error\(/);
  const firstWrite = core.indexOf(".from(");
  assert.ok(refusal > 0, "🔴 upsertAccessUserCore must refuse a retired role — every account write passes through it");
  assert.ok(firstWrite < 0 || refusal < firstWrite, "and it must refuse BEFORE it writes anything");
  const override = functionBody(accessControl, "export async function upsertRolePermissionOverride(");
  assert.ok(
    /\n\s*if \(retiredPhoenixRoles\.has\(permissionRole\)\) \{\s*throw new Error\(/.test(override),
    "a permission override on the retired seat must be refused — it would re-grant the empty entry",
  );
  assert.match(accessControl, /roles:\s*assignablePhoenixRoles/, "the dashboard hands the screen the assignable list");
  const manager = readFileSync("src/components/admin/access-control-manager.tsx", "utf8");
  assert.equal(/\bphoenixRoles\.map\(/.test(manager), false, "User Access must never list roles from phoenixRoles again");
  assert.ok(manager.includes("assignablePhoenixRoles.map("), "User Access lists assignablePhoenixRoles");

  // ── 6. What HR Operations keeps — the live seat beside it ──────────────────
  const operationsRows = new Set(hrRowsFor("HR Operations").map((row) => row.href));
  assert.equal(
    operationsRows.has("/hr/recruitment/manager-engagement"),
    false,
    "Manager Engagement must not appear for HR Operations",
  );
  assert.ok(
    operationsRows.has("/hr/admin/weekly-plans/calendar"),
    "the Planning Calendar must render for HR Operations — owner instruction, 2026-09-01",
  );
  const operationsPlanActions = hrBundleGrants("HR Operations").weekly_plans ?? [];
  assert.deepEqual(
    [...operationsPlanActions].sort(),
    ["read"],
    "HR Operations may READ the field force's plans and nothing else — approving one belongs to "
      + "the sales ladder, and no HR seat holds a weekly_plans write action of any kind",
  );
  assert.ok(
    operationsRows.has("/hr/admin/payslips-center"),
    "the Payslips Center row must render for HR Operations — she is the company-wide viewer",
  );
  assert.equal(
    operationsRows.has("/hr/admin/field-workforce-compliance"),
    false,
    "Workforce Compliance was removed from the HR rail on 2026-09-01 — field-force compliance is not an HR seat's work",
  );
  for (const href of ["/hr/admin/distribution-lists", "/hr/admin/sato-email", "/hr/sales/territory-management"]) {
    assert.equal(operationsRows.has(href), false, `${href} existed for the retired seat alone and must not reappear`);
  }
}
