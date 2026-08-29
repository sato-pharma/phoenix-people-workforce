import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { buildPermissionLookup, permissionMatrix, phoenixRoles } from "../src/lib/auth/permissions.ts";
import {
  SYSTEM_ADMINISTRATOR_ROLE,
  getSections,
  navigationItemVisible,
} from "../src/lib/navigation/active-path.ts";
import type { NavigationMode, PhoenixRole } from "../src/lib/auth/permissions.ts";

// ─────────────────────────────────────────────────────────────────────────────
// One navigation gate, and it cannot grow a second one.
//
// Before this, "what may this role see?" was answered in three places at once: getSections'
// isSystemAdministratorWorkspace branch, a ternary copied into 20 hub pages, and a third variant
// in the command palette. They did not agree — the hub ternary returned the untouched list and so
// skipped `excludedRoles`, which getSections honoured. Nothing could see the disagreement, because
// each copy was locally correct.
//
// The rule now lives only in navigationItemVisible. These tests pin the two things that would let
// it come apart again: a route or component restating the rule inline, and the waiver quietly
// widening past the `roles` gate it is scoped to.
// ─────────────────────────────────────────────────────────────────────────────

const GATE_MODULE = "src/lib/navigation/active-path.ts";
const MODES: readonly NavigationMode[] = ["admin", "employee-portal", "hr"];

// Anti-vacuity floors. Measured when this landed: 2,917 files, 22 importers, 5 getSections
// callers. A rename that empties the sweep must fail here rather than pass on zero files.
const MIN_SCANNED_FILES = 1_000;
const MIN_GATE_IMPORTERS = 15;

/** The flag every hub page used to declare for itself, 21 byte-identical times. */
const INLINE_BYPASS_FLAG = /const isSystemAdministratorWorkspace\s*=/;

/** The three-predicate chain that was copied into 20 hub pages and the palette. */
const INLINE_THREE_GATE = /permissionAllowed\([^)]*\)\s*&&\s*\n?\s*roleAllowed\(/;

function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "src", "app"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\.(ts|tsx)$/.test(line));
}

export function runNavSingleGateNoBypassTests() {
  // ── 1. Nobody restates the rule ────────────────────────────────────────────
  const files = repoFiles();
  assert.ok(
    files.length > MIN_SCANNED_FILES,
    `sweep must see a real tree, found ${files.length} files (floor ${MIN_SCANNED_FILES})`,
  );

  const flagOffenders: string[] = [];
  const gateOffenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (INLINE_BYPASS_FLAG.test(source)) flagOffenders.push(file);
    // active-path.ts is where the three predicates legitimately compose.
    if (file !== GATE_MODULE && INLINE_THREE_GATE.test(source)) gateOffenders.push(file);
  }

  assert.deepEqual(
    flagOffenders,
    [],
    `these files declare their own system-administrator bypass instead of calling navigationItemVisible:\n  ${flagOffenders.join("\n  ")}`,
  );
  assert.deepEqual(
    gateOffenders,
    [],
    `these files re-compose the navigation gate inline instead of calling navigationItemVisible:\n  ${gateOffenders.join("\n  ")}`,
  );

  // Detector self-check: the patterns must actually match the shapes they describe, or the two
  // empty results above mean nothing.
  assert.ok(
    INLINE_BYPASS_FLAG.test('const isSystemAdministratorWorkspace = access.scope === "system";'),
    "INLINE_BYPASS_FLAG stopped matching the flag it exists to find",
  );
  assert.ok(
    INLINE_THREE_GATE.test(
      "permissionAllowed(lookup, item.permissions) &&\n          roleAllowed(access.role, item.roles)",
    ),
    "INLINE_THREE_GATE stopped matching the chain it exists to find",
  );

  const importers = files.filter((file) => readFileSync(file, "utf8").includes("navigationItemVisible"));
  assert.ok(
    importers.length >= MIN_GATE_IMPORTERS,
    `only ${importers.length} files reach the shared gate (floor ${MIN_GATE_IMPORTERS}) — the sweep above is passing because nothing uses it`,
  );

  // ── 2. getSections carries no bypass parameter ─────────────────────────────
  const gateSource = readFileSync(GATE_MODULE, "utf8");
  assert.equal(
    /isSystemAdministratorWorkspace\s*[=:,)]/.test(gateSource),
    false,
    "getSections must not regrow a caller-supplied bypass parameter — the waiver belongs inside navigationItemVisible, where every caller gets it whether they remember it or not",
  );

  // ── 3. The waiver is scoped to `roles`, and nothing else ───────────────────
  const superAdmin = SYSTEM_ADMINISTRATOR_ROLE;
  const otherRole: PhoenixRole = "HR Advisory";

  // roles: waived for the system administrator, enforced for everyone else.
  const rolesOnly = { roles: ["CEO"] as const };
  assert.equal(navigationItemVisible(rolesOnly, {}, superAdmin), true, "the roles gate must be waived for the system administrator");
  assert.equal(navigationItemVisible(rolesOnly, {}, otherRole), false, "the roles gate must still bind every other role");

  // excludedRoles: never waived. This is the one that silently regressed before.
  const excluded = { roles: ["CEO"] as const, excludedRoles: [superAdmin] };
  assert.equal(
    navigationItemVisible(excluded, {}, superAdmin),
    false,
    "excludedRoles must outrank the waiver, or a role-personal page reappears on the owner's own sidebar",
  );

  // permissions: never waived. The old bypass skipped this, so a Super Admin row could outlive
  // the grant behind it and the rail could contradict the server.
  const permissioned = { permissions: [{ resource: "sales" as const, action: "read" as const }] };
  assert.equal(
    navigationItemVisible(permissioned, { "sales:read": false }, superAdmin),
    false,
    "a revoked permission must remove the row for the system administrator too — the nav must not outlive the grant",
  );
  assert.equal(navigationItemVisible(permissioned, { "sales:read": true }, superAdmin), true);

  // `roles: []` means NOBODY, and the waiver must not resurrect it. This is the exact shape of the
  // delisted portal Sales Analytics entry, which pairs it with excludedRoles for that reason.
  assert.equal(
    navigationItemVisible({ roles: [], excludedRoles: [superAdmin] }, {}, superAdmin),
    false,
    "the delisted-page pattern (roles: [] + excludedRoles) must keep hiding the page from the system administrator",
  );
  assert.equal(navigationItemVisible({ roles: [] }, {}, otherRole), false, "roles: [] must mean nobody");

  // ── 4. The delisted page is offered to NO role, in any mode ────────────────
  // Measured before and after this change: zero. It is the one entry relying on the pairing above.
  for (const role of phoenixRoles) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    for (const mode of MODES) {
      const offered = getSections(getNavigationSections(mode), mode, lookup, role)
        .flatMap((section) => section.items)
        .map((item) => item.href);
      assert.equal(
        offered.includes("/employee-portals/sales-analytics"),
        false,
        `${role} / ${mode}: the delisted Sales Analytics page must be offered to nobody (owner request 2026-08-08)`,
      );
    }
  }

  // ── 5. No role is offered the same href twice ──────────────────────────────
  // The dedupe used to run only on the bypass branch. It now runs for everyone, which is only
  // safe because no other role renders a duplicate — assert that rather than assume it.
  let combinationsChecked = 0;
  for (const role of phoenixRoles) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    for (const mode of MODES) {
      const hrefs = getSections(getNavigationSections(mode), mode, lookup, role)
        .flatMap((section) => section.items)
        .map((item) => item.href);
      combinationsChecked += 1;
      assert.equal(
        hrefs.length,
        new Set(hrefs).size,
        `${role} / ${mode}: the same href is offered twice — dedupeSectionsByHref is no longer covering every path`,
      );
    }
  }
  assert.equal(
    combinationsChecked,
    phoenixRoles.length * MODES.length,
    "every role x mode combination must be checked",
  );
  assert.ok(phoenixRoles.length >= 15, `expected the full role list, got ${phoenixRoles.length}`);
}
