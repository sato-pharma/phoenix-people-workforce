import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  DEDUCTION_EXEMPT_EMPLOYEES,
  dropDeductionExemptDrafts,
  isDeductionExemptEmployee,
} from "../src/lib/deductions/exempt-employees.ts";

/**
 * Owner, 2026-10-12: "remove sama mossaad and reham from any deduction type". Pins the two
 * people, the spellings an HR id arrives in, and that every writer path actually calls the filter
 * (a filter nobody calls is the failure that reads as green).
 */
export async function runDeductionsExemptEmployeesTests(): Promise<void> {
  assert.deepEqual(
    DEDUCTION_EXEMPT_EMPLOYEES.map((entry) => entry.hrId).sort(),
    ["A-3", "OF-0004"],
    "exactly Samaa Mosaad (A-3) and Reham Mahmoud (OF-0004) are exempt",
  );

  for (const spelling of ["A-3", "a-3", "A3", " A-3 ", "OF-0004", "of-0004", "OF0004"]) {
    assert.equal(isDeductionExemptEmployee(spelling), true, `${spelling} must resolve to an exempt person`);
  }
  for (const other of ["A-30", "A-10", "OF-0005", "B-155", "", null, undefined]) {
    assert.equal(isDeductionExemptEmployee(other), false, `${String(other)} must NOT be exempt`);
  }

  const { kept, droppedCount } = dropDeductionExemptDrafts([
    { employeeHrId: "A-3" },
    { employeeHrId: "A-10" },
    { employeeHrId: "OF-0004" },
    { employeeHrId: "B-155" },
  ]);
  assert.deepEqual(kept.map((draft) => draft.employeeHrId), ["A-10", "B-155"]);
  assert.equal(droppedCount, 2);

  // Every automated writer path calls the filter; the manual-entry path is deliberately spared.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../src/lib/deductions/collect.ts"), /dropDeductionExemptDrafts\(parts\.drafts\)/, "collect.ts filters before reconciling");
  assert.match(
    read("../src/lib/deductions/service.ts"),
    /input\.autoDecideStatus \? input\.drafts : dropDeductionExemptDrafts\(input\.drafts\)\.kept/,
    "insertCandidateDrafts filters automated writers and spares a manual HR entry",
  );
  assert.match(read("../src/lib/daily-deductions/service.ts"), /dropDeductionExemptDrafts\(drafts\)\.kept/, "the daily module filters every connector");
}
