import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTIVE_EMPLOYMENT_STATUSES,
  ACTIVE_EMPLOYMENT_STATUSES_IN_LIST,
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
  const documents = codeOnly(readFileSync("src/lib/hiring-documents/service.ts", "utf8"));
  assert.ok(
    /isTerminalEmploymentStatus/.test(documents),
    "hiring-documents must scope employees with the shared predicate",
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
    /ACTIVE_EMPLOYMENT_STATUSES_IN_LIST/.test(pack),
    "hiring-pack must scope its roster query with the shared literal",
  );
  assert.ok(
    !/\.neq\("employment_status"/.test(pack),
    'hiring-pack went back to excluding a single status with .neq("employment_status", ...)',
  );
}
