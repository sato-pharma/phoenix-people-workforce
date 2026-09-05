import assert from "node:assert/strict";

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

function jobTitleFor(result: ReturnType<typeof validateEmployeeImportRows>, hrId: string) {
  const record = [...result.rowsToInsert, ...result.rowsToUpdate].find((row) => row.hrId === hrId);
  return record?.jobTitle;
}

// Regression test for the 2026-09-05 production incident: `employees.job_title` for four active
// employees (AA the CEO, A-2, A-3, AB) carried the mangled per-word title case that
// tests/org-title-case-acronyms.test.ts already pins for POSITIONS — "Ceo", "Qppv", "Sfe Manager",
// "R And D Manager". positions.title had been fixed on 2026-08-28, but `employees.job_title` was
// never included: it is written verbatim from the uploaded sheet's Job Title cell
// (app/api/imports/employees/confirm/route.ts), with no casing pass at all. The four rows were
// fixed by hand on production; this pins that a future upload cannot write the same mangled forms
// back by routing record.jobTitle through the same shared toOrgTitleCase() at buildRecord() time.
export function runEmployeeImportJobTitleCasingTests() {
  const existingState = {
    canonicalAreas: [{ code: "AB1", name: "Cairo" }],
    employeeHrIds: new Set<string>(),
    employeeHrIdByCanonicalKey: new Map(),
  };

  // ── The four titles that were actually wrong in production. ──────────────────────────────
  const mangledCases: ReadonlyArray<{ hrId: string; uploaded: string; expected: string }> = [
    { hrId: "AA", uploaded: "Ceo", expected: "CEO" },
    { hrId: "A-3", uploaded: "Qppv", expected: "QPPV" },
    { hrId: "A-2", uploaded: "Sfe Manager", expected: "SFE Manager" },
    { hrId: "AB", uploaded: "R And D Manager", expected: "R&D Manager" },
  ];

  const result = validateEmployeeImportRows(
    mangledCases.map(({ hrId, uploaded }) =>
      employeeRow({ HR_ID: hrId, "Job Title": uploaded, Position: uploaded }),
    ),
    { existingState },
  );

  for (const { hrId, uploaded, expected } of mangledCases) {
    assert.equal(
      jobTitleFor(result, hrId),
      expected,
      `${hrId}: uploading "${uploaded}" in the Job Title column must canonicalize to "${expected}", the exact bug that put a mangled title on the CEO's own record`,
    );
  }

  // ── The common case must not regress. ─────────────────────────────────────────────────────
  // 111 live employees are stored as "Medical Representative" — an ordinary multi-word title with
  // no acronym must still Title Case normally, not get flattened or left untouched.
  const ordinary = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "T-002", "Job Title": "medical representative" })],
    { existingState },
  );
  assert.equal(
    jobTitleFor(ordinary, "T-002"),
    "Medical Representative",
    "an ordinary lowercase title must still be Title-Cased, exactly as before this change",
  );

  // ── A blank Job Title cell must not synthesize one. ───────────────────────────────────────
  // toOrgTitleCase() takes a string, not null — the guard around the call must not turn "nothing
  // uploaded" into a generated title.
  const blank = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "T-003", "Job Title": "" })],
    { existingState },
  );
  assert.equal(
    jobTitleFor(blank, "T-003"),
    null,
    "a blank Job Title cell must stay null, never a title invented from the Position column",
  );

  // ── A live title with a minor word must survive a re-upload. ─────────────────────────────
  // The canonicalization added on 2026-09-05 title-cased EVERY word, so re-uploading B-185's real
  // stored title "Finance and Admin Manager" rewrote it to "Finance And Admin Manager" — the same
  // class of silent damage this test exists to prevent, introduced by the repair itself. Production
  // stores the lower-case "and" on both the employees row and the `finance_and_admin_manager`
  // position row, so "And" is a regression against real data, not a tidier rendering of it.
  const minorWord = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "B-185", "Job Title": "Finance and Admin Manager" })],
    { existingState },
  );
  assert.equal(
    jobTitleFor(minorWord, "B-185"),
    "Finance and Admin Manager",
    "an ordinary minor word must stay lower-case mid-title — re-uploading B-185's live title must be a no-op",
  );

  // ── Already-correct casing is a fixed point. ──────────────────────────────────────────────
  // Re-uploading the now-fixed production values must not degrade them (the exact idempotence
  // property tests/org-title-case-acronyms.test.ts pins for positions — "R&D" must not become
  // "R&d" on a second pass).
  const alreadyCorrect = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "T-004", "Job Title": "R&D Manager" })],
    { existingState },
  );
  assert.equal(
    jobTitleFor(alreadyCorrect, "T-004"),
    "R&D Manager",
    "re-uploading an already-correct title must be a no-op, not a second pass of degradation",
  );
}
