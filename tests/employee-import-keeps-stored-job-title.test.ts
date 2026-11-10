import { strict as assert } from "node:assert";

import { JOB_TITLE_KEPT_CODE, validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";
import { createOrgCode } from "../src/lib/imports/org-rule-engine.ts";

// AN IMPORT NEVER CHANGES THE TITLE AN EMPLOYEE ALREADY HOLDS (owner, 2026-11-10). Dr. Sahar Khalil's
// title moved from "R&D Manager" to "Toll Manufacturing Manager (TMM)" on her record; a master sheet
// saved before that still says "R&D Manager", and re-importing it used to write the old title back
// AND, through the Position fallback, move her seat onto the old position. The row must still import,
// keep both, and warn by name.

const canonicalAreas = [{ code: "AB1", name: "Cairo" }];
const NEW_TITLE = "Toll Manufacturing Manager (TMM)";
const NEW_POSITION_CODE = createOrgCode(NEW_TITLE);

function employeeRow(overrides: Record<string, unknown> = {}, withPositionCell = false) {
  const row: Record<string, unknown> = {
    Area: "Cairo",
    "Full Name": "Test Employee",
    HR_ID: "T-001",
    "Job Title": "R&D Manager",
    Line: "Pedia",
    Region: "Cairo",
    ...overrides,
  };
  if (withPositionCell) row.Position = row.Position ?? row["Job Title"];
  return row;
}

function stateWith(seats: Array<{ hrId: string; jobTitle: string | null; positionCode: string | null }>) {
  return {
    canonicalAreas,
    employeeHrIds: new Set(seats.map((seat) => seat.hrId)),
    employeeOrgSeats: seats.map((seat) => ({
      areaCode: "AB1",
      hrId: seat.hrId,
      jobTitle: seat.jobTitle,
      lineCode: createOrgCode("Pedia"),
      positionCode: seat.positionCode,
      regionName: "Cairo",
    })),
  };
}

function recordFor(result: ReturnType<typeof validateEmployeeImportRows>, hrId: string) {
  return [...result.rowsToInsert, ...result.rowsToUpdate].find((record) => record.hrId === hrId);
}

export function runEmployeeImportKeepsStoredJobTitleTests() {
  // ── 1. The old sheet: the title and the seat it implies are both kept, the row still imports. ──
  const reverted = validateEmployeeImportRows([employeeRow()], {
    existingState: stateWith([{ hrId: "T-001", jobTitle: NEW_TITLE, positionCode: NEW_POSITION_CODE }]),
  });
  const kept = recordFor(reverted, "T-001");
  assert.ok(kept, "the row still imports — only the title is held back");
  assert.equal(reverted.rowsToUpdate.length, 1, "an existing employee is an update");
  assert.equal(kept.jobTitle, null, "a null title is omitted from the upsert, so the stored title stands");
  assert.equal(kept.codes.positionCode, NEW_POSITION_CODE, "the seat stays on the position she holds");
  assert.equal(kept.positionTitle, null);
  assert.equal(
    reverted.organizationEntitiesToCreate.positions.some((position) => position.code === createOrgCode("R&D Manager")),
    false,
    "the old title must not be minted back as a position",
  );
  const warning = reverted.validationWarnings.find((issue) => issue.code === JOB_TITLE_KEPT_CODE);
  assert.ok(warning, "the kept title is said on the row");
  assert.equal(warning.rowNumber, kept.rowNumber);
  assert.match(warning.message, /Title kept as "Toll Manufacturing Manager \(TMM\)"/);
  assert.match(warning.message, /Employee Master/);
  assert.equal(reverted.failedRows, 0, "a kept title never fails the row");

  // ── 2. An explicit Position cell is the file's own word about the seat — only the title is kept. ──
  const explicitPosition = validateEmployeeImportRows([employeeRow({ Position: "Product Manager" }, true)], {
    existingState: stateWith([{ hrId: "T-001", jobTitle: NEW_TITLE, positionCode: NEW_POSITION_CODE }]),
  });
  const explicit = recordFor(explicitPosition, "T-001");
  assert.equal(explicit?.jobTitle, null);
  assert.equal(explicit?.codes.positionCode, createOrgCode("Product Manager"));

  // ── 3. A casing-only difference is not a change: the import's casing repair still writes. ──
  const casing = validateEmployeeImportRows([employeeRow({ "Job Title": "R&D Manager" })], {
    existingState: stateWith([{ hrId: "T-001", jobTitle: "R And D Manager", positionCode: createOrgCode("R&D Manager") }]),
  });
  assert.equal(recordFor(casing, "T-001")?.jobTitle, "R&D Manager");
  assert.equal(casing.validationWarnings.some((issue) => issue.code === JOB_TITLE_KEPT_CODE), false);

  // ── 4. The same title is not a change either, and says nothing. ──
  const same = validateEmployeeImportRows([employeeRow({ "Job Title": NEW_TITLE })], {
    existingState: stateWith([{ hrId: "T-001", jobTitle: NEW_TITLE, positionCode: NEW_POSITION_CODE }]),
  });
  assert.equal(recordFor(same, "T-001")?.jobTitle, NEW_TITLE);
  assert.equal(same.validationWarnings.some((issue) => issue.code === JOB_TITLE_KEPT_CODE), false);

  // ── 5. A record with no title yet takes the file's. ──
  const blankStored = validateEmployeeImportRows([employeeRow()], {
    existingState: stateWith([{ hrId: "T-001", jobTitle: null, positionCode: null }]),
  });
  assert.equal(recordFor(blankStored, "T-001")?.jobTitle, "R&D Manager");

  // ── 6. A new hire takes the file's title. ──
  const newHire = validateEmployeeImportRows([employeeRow({ HR_ID: "T-002" })], {
    existingState: stateWith([{ hrId: "T-001", jobTitle: NEW_TITLE, positionCode: NEW_POSITION_CODE }]),
  });
  assert.equal(newHire.rowsToInsert.length, 1);
  assert.equal(recordFor(newHire, "T-002")?.jobTitle, "R&D Manager");
}
