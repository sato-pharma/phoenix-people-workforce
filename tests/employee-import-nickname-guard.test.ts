import { strict as assert } from "node:assert";

import {
  addFullNameHolder,
  buildPersonNameIndex,
  findNicknameOwners,
  personNameKey,
} from "../src/lib/imports/employee-name-collision.ts";
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

function issueCodesFor(
  result: ReturnType<typeof validateEmployeeImportRows>,
  rowNumber: number,
) {
  return result.validationErrors
    .filter((issue) => issue.rowNumber === rowNumber)
    .map((issue) => issue.code);
}

// Regression test for the 2026-08-05 incident: a master import whose Nickname column was shifted
// by a row wrote four NEW HIRES' names onto six existing employees. Because
// resolveEmployeeDisplayName returns nickname in preference to full_name, each of those six
// silently became a different person on every screen — Dina Fadel (B-12) rendered as "Magdy El
// Senosey" (AI-0008), so a District Manager's direct order showed the National Sales Manager as
// its requester. Nothing failed, nothing warned; it was found only by reading the row by hand.
//
// The guard refuses the WHOLE row, not just the nickname cell, because a shifted column is a
// property of the file: the same run also carried manager_hr_id and flattened the organogram.
export function runEmployeeImportNicknameGuardTests() {
  // ── The pure module, exercised directly. ────────────────────────────────────────────────────
  // The directory half of this guard runs inside a Supabase-backed loader that no unit test can
  // reach, so its name-keying was the uncovered half of the change. Testing the shared helper
  // covers BOTH sides and pins the property the whole guard rests on: the file side and the
  // directory side must agree on what "same name" means.
  assert.equal(personNameKey("  Magdy   El  Senosey "), "magdy el senosey");
  assert.equal(personNameKey("MAGDY EL SENOSEY"), "magdy el senosey");
  assert.equal(personNameKey("   "), null, "a blank name collides with nobody");
  assert.equal(personNameKey(null), null);

  const directoryIndex = new Map<string, string[]>();
  addFullNameHolder(directoryIndex, "Gannatallah  Amer", "PD-0008");
  addFullNameHolder(directoryIndex, "gannatallah amer", "B-165");
  addFullNameHolder(directoryIndex, "", "B-999");
  addFullNameHolder(directoryIndex, "Nobody", null);
  assert.deepEqual(
    directoryIndex.get("gannatallah amer"),
    ["PD-0008", "B-165"],
    "a shared full name must accumulate holders — collapsing them makes whichever row loaded second look like an impostor",
  );
  assert.equal(directoryIndex.size, 1, "a blank name or missing HR_ID must not create an entry");

  const index = buildPersonNameIndex({
    existingHrIdsByFullNameKey: directoryIndex,
    records: [
      { fullName: "Magdy El Senosey", hrId: "AI-0008", rowType: "employee" },
      // A vacancy placeholder is not a person and must not claim a name.
      { fullName: "Vacant Seat", hrId: "VAC-1", rowType: "vacant_position" },
    ],
  });
  assert.deepEqual(Array.from(index.get("magdy el senosey") ?? []), ["ai-0008"]);
  assert.equal(index.has("vacant seat"), false, "a vacant-position row must not register as a name holder");

  assert.deepEqual(
    findNicknameOwners({ hrId: "B-12", index, nickname: "magdy   EL senosey" }),
    ["AI-0008"],
    "the owner must be reported regardless of the uploaded casing or spacing",
  );
  assert.equal(
    findNicknameOwners({ hrId: "AI-0008", index, nickname: "Magdy El Senosey" }),
    null,
    "an employee's own name is not a rename",
  );
  assert.equal(
    findNicknameOwners({ hrId: "B-12", index, nickname: "Dina Fadel" }),
    null,
    "a short form nobody is named is not a rename",
  );
  assert.equal(findNicknameOwners({ hrId: "B-12", index, nickname: null }), null);
  assert.deepEqual(
    findNicknameOwners({ hrId: "B-141", index, nickname: "Gannatallah Amer" }),
    ["B-165", "PD-0008"],
    "every owner of a shared name is named in the error, sorted for a stable message",
  );

  // ── The same guard through the real validator. ──────────────────────────────────────────────
  const existingState = {
    canonicalAreas,
    employeeHrIds: new Set(["B-12", "AI-0008"]),
    employeeHrIdByCanonicalKey: new Map([
      ["b-12", { hrId: "B-12" }],
      ["ai-0008", { hrId: "AI-0008" }],
    ]),
  };

  // ── The incident itself: both people are rows in the same uploaded file. ────────────────────
  const shiftedColumn = validateEmployeeImportRows(
    [
      employeeRow({ HR_ID: "AI-0008", "Full Name": "Magdy El Senosey", Nickname: "Magdy El Senosey" }),
      employeeRow({
        HR_ID: "B-12",
        "Full Name": "Dina Hamdy Fadel Mohamed Bdair",
        Nickname: "Magdy El Senosey",
      }),
    ],
    { existingState },
  );

  assert.ok(
    issueCodesFor(shiftedColumn, 3).includes("nickname_is_another_employees_name"),
    "a nickname holding a DIFFERENT employee's full name must be refused — this is the exact shape that renamed six people in production",
  );
  assert.ok(
    !shiftedColumn.rowsToUpdate.some((record) => record.hrId === "B-12"),
    "the offending row must be excluded from rowsToUpdate entirely: the same shifted file also carries manager_hr_id, so importing 'the rest' of the row is what flattened the organogram",
  );
  // Magdy's own row is untouched — his nickname genuinely is his own name.
  assert.ok(
    shiftedColumn.rowsToUpdate.some((record) => record.hrId === "AI-0008"),
    "the row whose nickname matches its OWN full name must still import",
  );

  // ── The collision is against someone who is NOT in the file (partial upload). ───────────────
  const againstDirectoryOnly = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "B-12", "Full Name": "Dina Hamdy Fadel Mohamed Bdair", Nickname: "magdy  el senosey" })],
    {
      existingState: {
        ...existingState,
        employeeHrIdsByFullNameKey: new Map([["magdy el senosey", ["AI-0008"]]]),
      },
    },
  );

  assert.ok(
    issueCodesFor(againstDirectoryOnly, 2).includes("nickname_is_another_employees_name"),
    "the guard must also catch a name owned by an employee absent from the file, and must not be defeated by casing or doubled spaces",
  );

  // ── Legitimate nicknames must still import. ─────────────────────────────────────────────────
  const shortForm = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "B-12", "Full Name": "Dina Hamdy Fadel Mohamed Bdair", Nickname: "Dina Fadel" })],
    { existingState },
  );

  assert.deepEqual(
    issueCodesFor(shortForm, 2),
    [],
    "a short-form nickname nobody else is named must import — 21 live employees are stored exactly this way",
  );
  assert.equal(shortForm.rowsToUpdate.length, 1);

  const ownFullName = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "B-12", "Full Name": "Dina Hamdy Fadel Mohamed Bdair", Nickname: "Dina Hamdy Fadel Mohamed Bdair" })],
    { existingState },
  );

  assert.deepEqual(
    issueCodesFor(ownFullName, 2),
    [],
    "nickname equal to the row's OWN full name is how 11 live employees are stored and must never be refused",
  );

  // ── Two people genuinely share a name: the row that owns it is not being renamed. ───────────
  const sharedName = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "PD-0008", "Full Name": "Gannatallah Amer", Nickname: "Gannatallah Amer" })],
    {
      existingState: {
        ...existingState,
        employeeHrIds: new Set(["PD-0008", "B-165"]),
        employeeHrIdByCanonicalKey: new Map([
          ["pd-0008", { hrId: "PD-0008" }],
          ["b-165", { hrId: "B-165" }],
        ]),
        // The live directory really does carry this name twice.
        employeeHrIdsByFullNameKey: new Map([["gannatallah amer", ["PD-0008", "B-165"]]]),
      },
    },
  );

  assert.deepEqual(
    issueCodesFor(sharedName, 2),
    [],
    "a duplicated full name must not refuse the row that actually owns it",
  );

  // ...but a third person wearing that shared name still is.
  const impostor = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "B-141", "Full Name": "Bishoy Bahaa Fathy Mahna", Nickname: "Gannatallah Amer" })],
    {
      existingState: {
        ...existingState,
        employeeHrIds: new Set(["B-141"]),
        employeeHrIdByCanonicalKey: new Map([["b-141", { hrId: "B-141" }]]),
        employeeHrIdsByFullNameKey: new Map([["gannatallah amer", ["PD-0008", "B-165"]]]),
      },
    },
  );

  assert.ok(
    issueCodesFor(impostor, 2).includes("nickname_is_another_employees_name"),
    "a name shared by two OTHER people is still not this employee's to wear",
  );
}
