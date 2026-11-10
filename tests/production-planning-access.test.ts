import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { isPortalShellRole } from "../src/lib/auth/portal-shell-roles.ts";
import {
  assertProductionPlanningWrite,
  canReadProductionPlanning,
  canWriteProductionPlanning,
  PRODUCTION_PLANNING_FULL_CONTROL_HR_IDS,
  PRODUCTION_PLANNING_READ_ONLY_HR_IDS,
  productionPlanningLevel,
  ProductionPlanningForbiddenError,
} from "../src/lib/production-planning/access.ts";

/**
 * Production Planner — the access gate, which is the one edit in this module that can leak.
 *
 * The owner named five people on 2026-10-05: Dr. Sahar Khalil (then R&D Manager, the Toll Manufacturing Manager since 2026-11-10) and the CEO as the main
 * controllers, the Super Admin as usual, and Mr. Ahmed Al Maraghi and Reham Elwiy read-only.
 *
 * 🔴 TWO of those five hold app roles that are shared with people he did NOT name, and the figures
 * are read from production on 2026-10-06:
 *
 *   · `Manager` has THREE holders — Sahar Khalil (AB), Samaa Mosaad the QPPV (A-3, active) and
 *     Marina Azzab (A-14, inactive). Granting the role would open the planner to the QPPV.
 *   · `Employee` is the entire company. Granting the role to reach Reham (OF-0004) would publish
 *     every raw-material price and order cost to everybody.
 *
 * So the matrix grants those two roles NOTHING and the door is a named list. What this file pins:
 *
 *  · `production_planning` is in BOTH the union and the RUNTIME resource array — a name in the
 *    union but missing from the array is treated as permitted for every role;
 *  · exactly three roles hold it, and `Manager`/`Employee` hold nothing;
 *  · each of the five named people resolves to the level the owner gave them;
 *  · the other Manager and a plain Employee resolve to `none` — the denial paths matter as much as
 *    the grants;
 *  · HR ids match in any case and through the login id, because `===` on a mixed-case id matches
 *    nobody with no error, which presents exactly as the change never having shipped;
 *  · a stored grant can ADD a person and can never demote one the owner named;
 *  · the module is DUAL-SURFACE because two of the five are portal-shell viewers.
 */

const ACCESS_FILE = "src/lib/production-planning/access.ts";
const GRANTS_MIGRATION = "supabase/migrations/20261005215545_production_planning_access_grants.sql";

function level(hrId: string | null, role: PhoenixRole, loginId: string | null = null) {
  return productionPlanningLevel(
    { hrId, loginId, role },
    { roleActions: permissionMatrix[role]?.production_planning ?? null },
  );
}

export function runProductionPlanningAccessTests() {
  // ── The resource exists in BOTH lists ─────────────────────────────────────────────────────────
  assert.ok(
    permissionResources.includes("production_planning"),
    "production_planning must be in the RUNTIME permissionResources array: a name in the union but missing here is treated as permitted for every role",
  );

  // ── Exactly three roles hold it, and the two shared roles hold nothing ────────────────────────
  const holders = (Object.keys(permissionMatrix) as PhoenixRole[])
    .filter((role) => (permissionMatrix[role].production_planning ?? []).length > 0)
    .sort();
  assert.deepEqual(
    holders,
    ["CEO", "Finance Manager", "Super Admin"],
    "only the three admin-shell seats hold production_planning in the matrix",
  );
  assert.equal(
    permissionMatrix.Manager?.production_planning,
    undefined,
    "🔴 `Manager` must hold NOTHING: its three holders include Samaa Mosaad the QPPV, whom the owner did not name",
  );
  assert.equal(
    permissionMatrix.Employee?.production_planning,
    undefined,
    "🔴 `Employee` must hold NOTHING: it is the whole company, and this screen carries prices and costs",
  );
  assert.deepEqual(
    [...(permissionMatrix["Finance Manager"].production_planning ?? [])].sort(),
    ["export", "read"],
    'the owner twice said "read only, read only" about the finance manager',
  );
  for (const role of holders) {
    assert.ok(
      !(permissionMatrix[role].production_planning ?? []).includes("delete"),
      `${role} must not hold delete: a stock report and a recorded run are append-only facts about a date`,
    );
  }

  assert.deepEqual(
    [...(permissionMatrix.CEO.production_planning ?? [])].sort(),
    ["create", "export", "read", "update"],
    'the CEO is a main controller here: "the main controller is the R&D manager Dr. Sahar Khalil and the CEO Dr. Anwar"',
  );
  assert.deepEqual(
    [...(permissionMatrix["Super Admin"].production_planning ?? [])].sort(),
    ["create", "export", "read", "update"],
    "and the system administrator as usual",
  );

  // ── The five people the owner named ───────────────────────────────────────────────────────────
  assert.equal(level("B-10", "Super Admin"), "full", "Omar Gawish — the owner");
  assert.equal(level("AA", "CEO"), "full", "Anwar Gaweesh — the CEO");
  assert.equal(level("AB", "Manager"), "full", "Dr. Sahar Khalil — the Toll Manufacturing Manager, the module's main user");
  assert.equal(level("B-185", "Finance Manager"), "read", "Ahmed Al Maraghi — read only");
  assert.equal(level("OF-0004", "Employee"), "read", "Reham Elwiy — read only, for now");

  // ── The denial paths, which matter as much as the grants ──────────────────────────────────────
  assert.equal(
    level("A-3", "Manager"),
    "none",
    "🔴 Samaa Mosaad the QPPV holds the SAME app role as Dr. Sahar and must be refused",
  );
  assert.equal(level("A-14", "Manager"), "none", "and so must the other Manager");
  assert.equal(level("B-999", "Employee"), "none", "a plain employee gets nothing");
  assert.equal(level(null, "Employee"), "none", "and a session with no HR id gets nothing");
  // Deliberately role-INDEPENDENT: the owner named a PERSON, so Dr. Sahar keeps her own module if
  // somebody changes her app role. Tying her access to `Manager` would mean a routine role edit
  // silently locking the main user out of the planner.
  assert.equal(level("AB", "Medical Rep"), "full", "a named person keeps her access whatever her app role says");

  // Every other role in the system is refused outright.
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    if (holders.includes(role)) continue;
    assert.equal(
      level("Z-000", role),
      "none",
      `${role} must not reach the Production Planner without being named`,
    );
  }

  // ── HR ids match in any case, and through the login id ────────────────────────────────────────
  assert.equal(level("ab", "Manager"), "full", "production stores HR ids in mixed case, so matching is case-insensitive");
  assert.equal(level("b-10", "Super Admin"), "full");
  assert.equal(level("B10", "Super Admin"), "full", "and through formatting drift in the separator");
  assert.equal(
    level(null, "Manager", "AB"),
    "full",
    "a dev-auth sweep and some login flows carry only the login id, and a gate that reads one identifier is open half the time",
  );
  assert.equal(level("aaa", "CEO"), "full", "the legacy alias aaa -> aa still reaches the CEO");

  // ── A stored grant adds a person, and can never demote one the owner named ────────────────────
  const withGrant = productionPlanningLevel(
    { hrId: "C-123", loginId: null, role: "Employee" },
    { roleActions: null, grants: [{ hrId: "C-123", level: "read" }] },
  );
  assert.equal(withGrant, "read", "a Settings row is how a sixth person is admitted, without a release");

  const upgraded = productionPlanningLevel(
    { hrId: "OF-0004", loginId: null, role: "Employee" },
    {
      roleActions: null,
      grants: [{ hrId: "OF-0004", level: "full" }],
    },
  );
  assert.equal(upgraded, "full", 'Reham\'s promised upgrade — "later on like I said authority on her" — is a row, not a deploy');

  const cannotDemote = productionPlanningLevel(
    { hrId: "AB", loginId: null, role: "Manager" },
    { roleActions: null, grants: [{ hrId: "AB", level: "read" }] },
  );
  assert.equal(
    cannotDemote,
    "full",
    "a stored row must NEVER be able to demote somebody the owner named: the named lists are checked first",
  );

  const rubbishGrant = productionPlanningLevel(
    { hrId: "C-123", loginId: null, role: "Employee" },
    { roleActions: null, grants: [] },
  );
  assert.equal(rubbishGrant, "none", "and an unreadable or empty grants table grants nobody anything");

  // ── The level helpers, and a 403 rather than a rendered page ──────────────────────────────────
  assert.equal(canReadProductionPlanning("read"), true);
  assert.equal(canWriteProductionPlanning("read"), false, "read-only is read-only");
  assert.equal(canReadProductionPlanning("none"), false);
  assert.throws(
    () => assertProductionPlanningWrite({ hrId: "B-185", loginId: null, role: "Finance Manager" }, "read"),
    (error: unknown) => error instanceof ProductionPlanningForbiddenError,
    "a write by a read-only viewer THROWS — it never renders a page returning 200 with 'Forbidden' as visible text",
  );

  // ── The module must be DUAL-SURFACE, because two of the five live in the portal ───────────────
  assert.ok(
    isPortalShellRole("Manager"),
    "🔴 Dr. Sahar's role is a PORTAL-SHELL role, so app/(admin)/layout.tsx would redirect the module's main user straight out of an admin-only page",
  );
  assert.ok(isPortalShellRole("Employee"), "and so is Reham's");
  assert.equal(isPortalShellRole("CEO"), false, "while the CEO, the Super Admin and the Finance Manager are admin-shell");
  assert.equal(isPortalShellRole("Super Admin"), false);
  assert.equal(isPortalShellRole("Finance Manager"), false);

  // ── The lists say what they are, and the table backs the upgrade path ─────────────────────────
  assert.deepEqual([...PRODUCTION_PLANNING_FULL_CONTROL_HR_IDS].sort(), ["AA", "AB", "B-10"]);
  assert.deepEqual([...PRODUCTION_PLANNING_READ_ONLY_HR_IDS].sort(), ["B-185", "OF-0004"]);
  assert.equal(
    new Set([...PRODUCTION_PLANNING_FULL_CONTROL_HR_IDS, ...PRODUCTION_PLANNING_READ_ONLY_HR_IDS]).size,
    5,
    "five people, each named once",
  );

  const accessSource = readFileSync(ACCESS_FILE, "utf8");
  assert.ok(
    !/from\s+"@\/lib\/supabase/.test(accessSource),
    `${ACCESS_FILE} must stay client-safe: the page shells and the workspace read it, so no Supabase import`,
  );
  assert.ok(
    accessSource.includes("hrIdsMatch"),
    "the gate must compare with hrIdsMatch, never with ===, which matches nobody on a mixed-case id",
  );

  const grantsMigration = readFileSync(GRANTS_MIGRATION, "utf8");
  assert.ok(
    grantsMigration.includes("prodplan_access_grants_level_check"),
    "the grants table must refuse a level it does not know, in the database and not only in the loader",
  );
  assert.ok(
    grantsMigration.includes("revoke all on table public.prodplan_access_grants from public, anon, authenticated"),
    "and no browser role may read who holds the planner",
  );
}
