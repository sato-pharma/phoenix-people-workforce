import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  AREA_TABLES,
  applyAreaConsolidation,
  canRunAreaConsolidation,
  listAreaConsolidationCandidates,
  previewAreaConsolidation,
  revertAreaConsolidation,
} from "../src/lib/territory-management/area-consolidation.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Area consolidation — the Super Admin's own button for bulk territory moves.
//
// Owner, 2026-08-22: "I want you to shift any bulk from them. I want me to be able to, in the
// system itself, I check if confirmed, I press the button, and it goes. I don't want you to do any
// of this critical sensitive work."
//
// Three things are pinned here, and each of them would cost real damage if it broke:
//
//   1. THE GATE. Read, preview, apply and revert all refuse anyone who is not Super Admin. This
//      moves EMPLOYEES between territories. A hole is not a visibility bug, it is an unauthorized
//      bulk write to org data.
//   2. TABLE COVERAGE. Every table with an `area_id` must be classified. A table nobody classified
//      is a table the consolidation silently skips, leaving rows stranded on a dead area — the
//      exact failure this feature exists to end.
//   3. THE CURRENT/HISTORICAL SPLIT. History must never be rewritten. A coaching visit happened
//      where it happened.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_ROLES = [
  "Employee",
  "SFE Manager",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Finance Manager",
  "Training Manager",
  "Talent Acquisition",
  "Manager",
  "CEO",
] as const;

const SOME_AREA_ID = 29;
const SOME_TARGET_AREA_ID = 1101;
const SOME_CONSOLIDATION_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Every table carrying a foreign key to `public.areas`, read off production 2026-08-22 by walking
 * `pg_constraint` — NOT copied from the module under test, or this would assert nothing.
 */
const AREA_FK_TABLES_ON_PRODUCTION = [
  "coaching_reports",
  "employee_history",
  "employees",
  "marketing_customers",
  "marketing_pharmacies",
  "marketing_requests",
  "position_vacancies",
  "positions",
  "teams",
] as const;

async function testGatesRefuseEveryNonSuperAdmin() {
  for (const role of FORBIDDEN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });

    await assert.rejects(
      () => listAreaConsolidationCandidates(access),
      /Forbidden/i,
      `${role} must not be able to list consolidation candidates`,
    );
    await assert.rejects(
      () => previewAreaConsolidation(access, SOME_AREA_ID),
      /Forbidden/i,
      `${role} must not be able to preview a consolidation`,
    );
    await assert.rejects(
      () =>
        applyAreaConsolidation(access, {
          sourceAreaId: SOME_AREA_ID,
          targetAreaId: SOME_TARGET_AREA_ID,
        }),
      /Forbidden/i,
      `${role} must not be able to move employees between areas`,
    );
    await assert.rejects(
      () => revertAreaConsolidation(access, { consolidationId: SOME_CONSOLIDATION_ID }),
      /Forbidden/i,
      `${role} must not be able to revert a consolidation`,
    );
  }
}

function testOnlySuperAdminPassesThePredicate() {
  assert.equal(canRunAreaConsolidation({ role: "Super Admin", scope: "company" }), true);
  for (const role of FORBIDDEN_ROLES) {
    assert.equal(
      canRunAreaConsolidation({ role, scope: "company" }),
      false,
      `${role} must not pass the consolidation predicate`,
    );
  }
  // Server-internal scope, used by background jobs; it is itself a Super Admin constant.
  assert.equal(canRunAreaConsolidation({ role: "Employee", scope: "system" }), true);
}

function testEveryAreaTableIsClassified() {
  const classified = new Set(AREA_TABLES.map((spec) => spec.table));
  for (const table of AREA_FK_TABLES_ON_PRODUCTION) {
    assert.ok(
      classified.has(table),
      `${table} has an area_id in production but is not classified in AREA_TABLES — a consolidation would silently strand its rows on the dead area`,
    );
  }
  assert.equal(
    classified.size,
    AREA_FK_TABLES_ON_PRODUCTION.length,
    "AREA_TABLES must not classify a table that has no area_id foreign key",
  );
}

function testHistoryIsNeverMoved() {
  const historical = AREA_TABLES.filter((spec) => spec.role === "historical").map((s) => s.table);
  assert.deepEqual(
    historical.sort(),
    ["coaching_reports", "employee_history"],
    "history tables must stay historical — moving them would misattribute past field work to a territory it did not happen in",
  );

  for (const spec of AREA_TABLES) {
    if (spec.role !== "historical") continue;
    assert.ok(
      (spec.untouchedReason ?? "").length > 20,
      `${spec.table} is skipped, so the screen must explain WHY in words the owner can read`,
    );
  }
}

function testCurrentAssignmentTablesAreTheOnesThatMove() {
  const current = AREA_TABLES.filter((spec) => spec.role === "current").map((s) => s.table).sort();
  assert.deepEqual(current, [
    "employees",
    "marketing_customers",
    "marketing_pharmacies",
    "marketing_requests",
    "position_vacancies",
    "positions",
    "teams",
  ]);
}

function testEveryTableCarriesItsOwnPrimaryKey() {
  // The nine tables do not agree on a key: `employees` is keyed by hr_id (text), others by bigint
  // or uuid. Getting one wrong would make the undo buffer record a key that revert cannot match,
  // so the move would be silently irreversible.
  const expected: Record<string, string> = {
    coaching_reports: "id",
    employee_history: "id",
    employees: "hr_id",
    marketing_customers: "id",
    marketing_pharmacies: "id",
    marketing_requests: "id",
    position_vacancies: "id",
    positions: "id",
    teams: "id",
  };
  for (const spec of AREA_TABLES) {
    assert.equal(
      spec.primaryKey,
      expected[spec.table],
      `${spec.table} must record the primary key production actually uses`,
    );
  }
}

function testEveryTableHasAHumanLabel() {
  // Owner standing rule: human-readable names, never raw codes or IDs, in both UI and chat.
  for (const spec of AREA_TABLES) {
    assert.ok(spec.label.length > 0, `${spec.table} needs a human label`);
    assert.ok(
      !spec.label.includes("_"),
      `${spec.table} must not show its raw table name to the owner (got "${spec.label}")`,
    );
  }
}

export async function runAreaConsolidationTests() {
  await testGatesRefuseEveryNonSuperAdmin();
  testOnlySuperAdminPassesThePredicate();
  testEveryAreaTableIsClassified();
  testHistoryIsNeverMoved();
  testCurrentAssignmentTablesAreTheOnesThatMove();
  testEveryTableCarriesItsOwnPrimaryKey();
  testEveryTableHasAHumanLabel();
}
