import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTIVE_EMPLOYMENT_STATUSES,
  ACTIVE_EMPLOYMENT_STATUSES_IN_LIST,
  DEPARTED_EMPLOYMENT_STATUSES,
  DEPARTED_EMPLOYMENT_STATUSES_IN_LIST,
  hasDepartedEmployment,
  isTerminalEmploymentStatus,
} from "../src/lib/auth/session-lifecycle.ts";

/**
 * Pins who the two hiring screens are about: the people Phoenix currently employs.
 *
 * They disagreed by 46 people. Counted on production 2026-08-24 over 175 employee rows —
 * 112 active, 44 resigned, 15 historical_payroll_record, 2 terminated, 2 system_placeholder:
 *
 *   - Hiring Documents carried its own list, {active, on_leave, resigned, terminated, inactive},
 *     and showed 158 — the 112 plus 44 resigned and 2 terminated.
 *   - Hiring Pack excluded only "resigned" and showed 131 — the 112 plus 2 terminated, 15
 *     historical payroll records and 2 system placeholders, in a list whose purpose is printing an
 *     employment contract.
 *
 * Owner decision 2026-08-24: both mean current staff. Neither file may own a status list again.
 *
 * WIDENED 2026-08-30, for one screen only and without reopening that decision. The hiring pack
 * became HR Forms and now prints the LEAVING documents too — social insurance Form 6 and the two
 * Ministry of Labour exit templates — which are filed after somebody has gone and after
 * `employment_status` has already flipped. Current staff only meant the one screen that prints a
 * Form 6 could not find a single one of the 57 people it exists for (production, 2026-08-30: 55
 * resigned, 2 terminated). So its roster is now current staff PLUS the departed set, and the 17
 * rows that caused the original bug — 15 historical payroll records, 2 system placeholders — are
 * still excluded, because they are ledger artefacts rather than people with a last working day.
 *
 * The hiring-documents checklist is UNCHANGED: it tracks documents a current employee owes.
 */

/**
 * Comments are stripped before the source guards below run: both files now DOCUMENT the statuses
 * they used to hand-write, and a guard that reads its own explanation as a regression is a guard
 * that fails the moment somebody explains themselves.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

export function runHiringEmployeeScopeTests() {
  // ---------------------------------------------------------------------------
  // The shared vocabulary both screens now defer to.
  // ---------------------------------------------------------------------------
  assert.deepEqual(
    Array.from(ACTIVE_EMPLOYMENT_STATUSES).sort(),
    ["active", "on_leave"],
    "current staff is active + on_leave, and nothing else",
  );
  assert.equal(
    ACTIVE_EMPLOYMENT_STATUSES_IN_LIST,
    "(active,on_leave)",
    "the PostgREST literal must stay derived from the same set",
  );

  // ---------------------------------------------------------------------------
  // The exact production vocabulary, statuses that were wrongly included named individually.
  // ---------------------------------------------------------------------------
  const productionStatuses: Array<[string, boolean]> = [
    ["active", false],
    ["on_leave", false],
    ["resigned", true],
    ["terminated", true],
    ["historical_payroll_record", true],
    ["system_placeholder", true],
    ["inactive", true],
    ["not_renewed", true],
  ];
  for (const [status, terminal] of productionStatuses) {
    assert.equal(
      isTerminalEmploymentStatus(status),
      terminal,
      `${status} must ${terminal ? "NOT" : ""} count as current staff`,
    );
  }

  // A legacy row with no status is not evidence that someone left — it must not vanish from a
  // compliance checklist.
  assert.equal(isTerminalEmploymentStatus(null), false, "an unset status counts as current");
  assert.equal(isTerminalEmploymentStatus(""), false, "a blank status counts as current");
  assert.equal(isTerminalEmploymentStatus("  ACTIVE  "), false, "status matching is trimmed and case-insensitive");

  // ---------------------------------------------------------------------------
  // Neither service may hand-write a status list again. Both regressions were exactly that.
  // ---------------------------------------------------------------------------
  // These match the CALL, not the import. An earlier cut tested for the bare identifier, which the
  // import line satisfies on its own — so replacing the predicate body with a hand-rolled status
  // comparison left the test green, which is the exact regression it exists to catch.
  const documents = codeOnly(readFileSync("src/lib/hiring-documents/service.ts", "utf8"));
  assert.ok(
    /!isTerminalEmploymentStatus\(row\.employment_status\)/.test(documents),
    "hiring-documents must scope employees with the shared predicate — importing it is not using it",
  );
  assert.ok(
    !/visibleEmployeeStatuses/.test(documents),
    "hiring-documents reintroduced its own employment-status list",
  );
  assert.ok(
    !/"resigned"/.test(documents),
    "hiring-documents must not name an individual employment status",
  );

  const pack = codeOnly(readFileSync("src/lib/hiring-pack/service.ts", "utf8"));
  assert.ok(
    /employment_status\.is\.null,employment_status\.in\.\$\{ACTIVE_EMPLOYMENT_STATUSES_IN_LIST\}/.test(pack),
    "hiring-pack must scope its roster query with the shared literal — importing it is not using it",
  );
  // The leaving half of the module, pinned the same way: by the CALL, not the import. Dropping this
  // clause is silent — the screen keeps working for new hires and simply stops being able to print
  // a Form 6 for anybody, which is the whole population that form is for.
  assert.ok(
    /employment_status\.in\.\$\{DEPARTED_EMPLOYMENT_STATUSES_IN_LIST\}/.test(pack),
    "hiring-pack must also carry people who have left — Form 6 is filed after they go",
  );
  assert.ok(
    !/\.neq\("employment_status"/.test(pack),
    'hiring-pack went back to excluding a single status with .neq("employment_status", ...)',
  );
  assert.ok(
    !/"historical_payroll_record"|"system_placeholder"/.test(pack),
    "hiring-pack must not name an individual employment status — that is what the shared sets are for",
  );

  // ---------------------------------------------------------------------------
  // "Has left" is not "may not hold a session", and conflating them is what would put a payroll
  // placeholder in front of somebody printing a government form.
  // ---------------------------------------------------------------------------
  assert.deepEqual(
    Array.from(DEPARTED_EMPLOYMENT_STATUSES).sort(),
    ["not_renewed", "resigned", "terminated"],
    "the departed set is the three ways employment actually ends",
  );
  assert.equal(
    DEPARTED_EMPLOYMENT_STATUSES_IN_LIST,
    "(resigned,terminated,not_renewed)",
    "the PostgREST literal must stay derived from the same set",
  );
  for (const status of ["historical_payroll_record", "system_placeholder"]) {
    assert.equal(
      isTerminalEmploymentStatus(status),
      true,
      `${status} must still be terminal for session purposes`,
    );
    assert.equal(
      hasDepartedEmployment(status),
      false,
      `${status} is a ledger row, not a person who left — it must never reach an exit form`,
    );
  }
  for (const status of ["active", "on_leave", null, ""]) {
    assert.equal(hasDepartedEmployment(status), false, `${String(status)} has not left`);
  }
  assert.equal(hasDepartedEmployment("  RESIGNED  "), true, "departed matching is trimmed and case-insensitive");
}
