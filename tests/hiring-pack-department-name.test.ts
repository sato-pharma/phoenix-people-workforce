import assert from "node:assert/strict";

import { mapEmployeeFacts, type EmployeeDbRow } from "../src/lib/hiring-pack/service.ts";

// THE TWO READERS OF `departments.name` MUST PRODUCE THE SAME FIELD.
//
// `mapEmployeeFacts` has two callers, and they get the department by different routes because they
// are asking different questions:
//
//   • the single-employee load (`service.ts`) joins ONE department row by id, to print a paper;
//   • the roster-wide fill-rate count (`field-fill-rate.ts`) reads the whole department table once
//     into a Map, to answer "how many people would this field print for".
//
// Its own doc comment promises they "produce the identical shape, which is what lets the fill-rate
// count answer 'how many people would this field print for' with the same reader that prints it".
// That was a claim, not a checked fact: the print path translated the English name to Arabic before
// handing it over and the roster path did not, so the SAME field held "Sales" when the roster loaded
// it and "المبيعات" when the paper did.
//
// It was benign only by luck. `DEPARTMENT` is an unbound key today (`paper-fields.ts`), so the count
// never reads `departmentAr` at all, and `arabicDepartmentName` falls back to the English name rather
// than null, so a mapped department was non-empty either way. Neither of those is a property anybody
// promised to keep. The failure it was one feature away from is an ENGLISH department name printed
// into the Arabic إدارة box of a signed contract — the exact defect the owner corrected on
// 2026-08-31 ("the department is not the line"), arriving by a different road.
//
// So the translation now lives INSIDE `mapEmployeeFacts` and both callers hand it the raw
// `departments.name`. This test pins that by building each caller's own expression.

/** An employee row as `HIRING_PACK_EMPLOYEE_COLUMNS` returns it — only the department matters here. */
function employeeRow(departmentId: number | null): EmployeeDbRow {
  return {
    base_salary: null,
    birth_date: null,
    department_id: departmentId,
    employment_status: "active",
    full_name: "Yasmen Adel",
    gender: null,
    gross_salary: null,
    hire_date: "2026-01-01",
    hr_id: "A-1",
    job_title: "Medical Rep",
    last_working_date: null,
    line_id: 2,
    mobile_number: null,
    name_ar: null,
    national_id: null,
    nickname: null,
    residence_address: null,
    residence_city: null,
    social_insurance_number: null,
    social_insurance_wage: null,
    work_email: null,
  };
}

/**
 * The roster-wide reader's own expression: the whole `departments` table in a Map, looked up by id.
 * Copied in shape from `loadRosterRecords`, so a change there that reintroduces the seam shows up
 * as a disagreement here rather than as a blank box on a contract.
 */
function rosterReader(row: EmployeeDbRow, table: Map<number, string | null>) {
  const departmentName =
    row.department_id === null ? null : (table.get(row.department_id) ?? null);
  return mapEmployeeFacts(row, departmentName);
}

/** The single-employee reader's own expression: one department row joined by id, or none. */
function printReader(row: EmployeeDbRow, joined: { id: number; name: string | null } | null) {
  return mapEmployeeFacts(row, joined?.name ?? null);
}

export function runHiringPackDepartmentNameTests() {
  // The papers are legal documents, so a nickname never reaches them (owner, 2026-11-03).
  assert.equal(
    mapEmployeeFacts({ ...employeeRow(null), nickname: "Yasmen A." }, null).fullName,
    "Yasmen Adel",
    "a person with a nickname keeps the full name on every paper",
  );

  // ── 1. A department that IS in the lookup table ──────────────────────────────────────────────
  //
  // The headline. Sales is 140 of the 162 people carrying a department in production, so this is
  // not an edge case — it is nearly every contract the module prints.
  const sales = new Map<number, string | null>([[3, "Sales"]]);
  const row = employeeRow(3);

  const roster = rosterReader(row, sales);
  const print = printReader(row, { id: 3, name: "Sales" });

  assert.equal(
    roster.departmentAr,
    "المبيعات",
    "the roster reader hands over the raw departments.name, so mapEmployeeFacts must translate it — an English إدارة on an Arabic contract is the defect this closes",
  );
  assert.equal(
    roster.departmentAr,
    print.departmentAr,
    "both readers must produce the identical field, which is what lets the fill-rate count use the same reader that prints",
  );

  // Case-insensitively, because these names are typed by hand in the HR screens.
  assert.equal(
    rosterReader(employeeRow(3), new Map([[3, "  sales  "]])).departmentAr,
    "المبيعات",
    "a hand-typed department name is trimmed and matched case-insensitively by both readers",
  );

  // ── 2. A department that is NOT in the table ─────────────────────────────────────────────────
  //
  // The fallback prints the English name rather than nothing: a blank إدارة on a signed contract is
  // a silent omission, the English word is wrong in a way HR reports. Both readers must agree on
  // that too — this is the case that made the old seam invisible.
  const unmapped = new Map<number, string | null>([[9, "Regulatory Affairs"]]);
  assert.equal(
    rosterReader(employeeRow(9), unmapped).departmentAr,
    "Regulatory Affairs",
    "a department created after the lookup table was written prints visibly rather than blank",
  );
  assert.equal(
    rosterReader(employeeRow(9), unmapped).departmentAr,
    printReader(employeeRow(9), { id: 9, name: "Regulatory Affairs" }).departmentAr,
    "the readers agree on the fallback as well as on the translation",
  );

  // ── 3. Nothing to print ──────────────────────────────────────────────────────────────────────
  //
  // A whitespace-only name is where the old seam DISAGREED ON EMPTINESS, not just on language: the
  // print path cleaned it to null while the roster path passed "   " through as a non-empty value.
  // `collectHiringPackGaps` tests `!employee.departmentAr`, so that row reported a department it
  // would have printed as blank space.
  assert.equal(
    rosterReader(employeeRow(4), new Map([[4, "   "]])).departmentAr,
    null,
    "a whitespace-only department name is nothing to print, in BOTH readers — emptiness is the one thing the fill-rate count reads",
  );
  assert.equal(
    rosterReader(employeeRow(null), sales).departmentAr,
    null,
    "an employee with no department_id has no department to name",
  );
  assert.equal(
    rosterReader(employeeRow(7), sales).departmentAr,
    null,
    "a department_id with no row in the table is absent, not an id printed as a name",
  );
  assert.equal(printReader(employeeRow(null), null).departmentAr, null);

  // ── 4. The line is still not the department ──────────────────────────────────────────────────
  //
  // Owner, 2026-08-31, in those words. A rep's contract named his product line in the box that asks
  // which إدارة employs him. `line_id` is on the row this test hands both readers; neither may reach
  // for it, and no line name may resolve to an Arabic department.
  for (const line of ["CNS", "Pedia", "Anti Infective"]) {
    assert.equal(
      rosterReader(employeeRow(5), new Map([[5, line]])).departmentAr,
      line,
      `${line} is a product line, not a department — it must never resolve to an Arabic department name`,
    );
  }
}
