import assert from "node:assert/strict";

import {
  FIXED_EXPORT_HR_ID_ORDER,
  sortForExport,
  unlistedExportHrIds,
} from "../src/lib/automated-payroll/exports/export-order.ts";

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

  // ---- DRIFT HANDLING (2026-07-25): the fixed list is hand-maintained and was
  // already 123 IDs against 132 active employees. Unlisted people must land in
  // a DETERMINISTIC tail (line, then hire date) instead of arbitrary incoming
  // order, so finance's sheet stays readable as the list goes stale. ----------
  type Row = { hrId: string; line: string; hireDate: string };
  const drifted: Row[] = [
    { hrId: "Z-300", line: "Pedia", hireDate: "2026-03-01" },
    { hrId: "Z-100", line: "Anti Infective", hireDate: "2026-05-01" },
    { hrId: "A-1", line: "Head Office", hireDate: "2020-01-01" }, // listed
    { hrId: "Z-200", line: "Anti Infective", hireDate: "2026-01-01" },
  ];
  const fallbackKey = (row: Row) => `${row.line}|${row.hireDate}|${row.hrId}`;
  const sortedDrift = sortForExport(drifted, (row) => row.hrId, { fallbackKey });
  assert.deepEqual(
    sortedDrift.map((row) => row.hrId),
    // A-1 is listed so it leads; the rest group by line then hire date.
    ["A-1", "Z-200", "Z-100", "Z-300"],
    "unlisted employees must be grouped by line then hire date, not left in arrival order",
  );

  // ---- the drift itself is reportable, so it stops degrading silently -------
  assert.deepEqual(
    unlistedExportHrIds(drifted, (row) => row.hrId),
    ["Z-300", "Z-100", "Z-200"],
    "every employee missing from the fixed list must be reportable",
  );
  assert.deepEqual(
    unlistedExportHrIds([{ hrId: "A-1" }, { hrId: "A-2" }], (row) => row.hrId),
    [],
    "a fully-covered run reports no drift",
  );

  // ---- the fixed order still wins over the fallback for listed employees ----
  const listedStayFixed = sortForExport(
    [
      { hrId: "A-2", line: "ZZZ Last Alphabetically", hireDate: "2030-01-01" },
      { hrId: "A-1", line: "AAA First Alphabetically", hireDate: "2000-01-01" },
    ],
    (row) => row.hrId,
    { fallbackKey },
  );
  assert.deepEqual(
    listedStayFixed.map((row) => row.hrId),
    ["A-1", "A-2"],
    "the owner's fixed sequence must not be overridden by the fallback key",
  );
}
