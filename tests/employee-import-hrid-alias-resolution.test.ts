import { strict as assert } from "node:assert";

import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";

function employeeRow(overrides: Record<string, unknown> = {}) {
  return {
    Area: "Cairo",
    "Full Name": "Test Employee",
    HR_ID: "T-001",
    "Job Title": "Medical Representative",
    Line: "Pedia",
    Position: "Medical Representative",
    Region: "Cairo",
    ...overrides,
  };
}

const canonicalAreas = [{ code: "AB1", name: "Cairo" }];

// Regression test for the C13 audit's Critical finding: re-uploading the legacy "AAA" HR_ID
// alias for an employee already stored as "AA" was correctly ROUTED to rowsToUpdate, but the
// record's hrId field still carried the raw "AAA" forward. app/api/imports/employees/confirm's
// upsert(..., { onConflict: "hr_id" }) then found no row with hr_id="AAA" and inserted a
// duplicate employee instead of updating the real one. The fix rewrites record.hrId (and
// managerHrId) to the exact stored value in employee-validator.ts, before any routing decision
// or downstream write -- these tests exercise that through the real validator, not just the
// underlying hr-id.ts helper in isolation.
export function runEmployeeImportHrIdAliasResolutionTests() {
  const existingState = {
    canonicalAreas,
    employeeHrIds: new Set(["AA"]),
    employeeHrIdByCanonicalKey: new Map([["aa", { hrId: "AA" }]]),
  };

  const aliasReupload = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "AAA", "Full Name": "Dr Anwar" })],
    { existingState },
  );

  assert.equal(aliasReupload.rowsToInsert.length, 0);
  assert.equal(aliasReupload.rowsToUpdate.length, 1);
  assert.equal(
    aliasReupload.rowsToUpdate[0]?.hrId,
    "AA",
    'record.hrId must resolve to the stored "AA", not the raw uploaded "AAA" alias, or the confirm route\'s upsert onConflict:"hr_id" misses and duplicates the employee',
  );

  const managerAliasUpload = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "T-050", "Full Name": "Direct Report", "Manager HR ID": "AAA" })],
    {
      existingState: {
        ...existingState,
        employeeOrgSeats: [],
        managerHrIds: new Set(["AA"]),
      },
    },
  );

  assert.equal(managerAliasUpload.rowsToInsert.length, 1);
  assert.equal(
    managerAliasUpload.rowsToInsert[0]?.managerHrId,
    "AA",
    "managerHrId must resolve through the same alias table so manager-linking targets the real stored row",
  );

  // A genuinely new employee (no existing match) is unaffected: normalized/uppercased as
  // before, routed as an insert, nothing rewritten to some other value.
  const freshInsert = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "zz-900", "Full Name": "Brand New Rep" })],
    { existingState },
  );

  assert.equal(freshInsert.rowsToInsert.length, 1);
  assert.equal(freshInsert.rowsToUpdate.length, 0);
  assert.equal(freshInsert.rowsToInsert[0]?.hrId, "ZZ-900");
}
