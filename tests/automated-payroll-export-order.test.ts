import assert from "node:assert/strict";

import { FIXED_EXPORT_HR_ID_ORDER, sortForExport } from "../src/lib/automated-payroll/exports/export-order.ts";

export function runAutomatedPayrollExportOrderTests() {
  // ---- the owner-provided list has no accidental duplicates ------------------
  const seen = new Set<string>();
  for (const hrId of FIXED_EXPORT_HR_ID_ORDER) {
    assert.equal(seen.has(hrId), false, `duplicate HR_ID in fixed export order: ${hrId}`);
    seen.add(hrId);
  }
  assert.equal(FIXED_EXPORT_HR_ID_ORDER.length, 123);

  // ---- listed employees come out in the exact fixed order, regardless of
  // their incoming order ------------------------------------------------------
  const shuffled = ["B-3", "A-2", "PD-0001", "A-1", "OF-0001", "A-9"].map((hrId) => ({ hrId }));
  const sorted = sortForExport(shuffled, (row) => row.hrId);
  assert.deepEqual(
    sorted.map((row) => row.hrId),
    ["A-1", "A-2", "A-9", "OF-0001", "PD-0001", "B-3"],
  );

  // ---- an HR_ID not in the list is appended after every listed employee,
  // keeping its relative order against other unlisted employees (stable) -----
  const withUnlisted = [{ hrId: "Z-999" }, { hrId: "A-1" }, { hrId: "Z-001" }, { hrId: "A-2" }];
  const sortedWithUnlisted = sortForExport(withUnlisted, (row) => row.hrId);
  assert.deepEqual(
    sortedWithUnlisted.map((row) => row.hrId),
    ["A-1", "A-2", "Z-999", "Z-001"],
  );

  // ---- matching is case/dash/space-insensitive (compactHrKey normalization) -
  const messyCase = [{ hrId: "a-9" }, { hrId: " A1 " }];
  const sortedMessy = sortForExport(messyCase, (row) => row.hrId);
  assert.deepEqual(
    sortedMessy.map((row) => row.hrId),
    [" A1 ", "a-9"],
  );
}
