import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { columns } from "../src/lib/employees/employee-master-columns.ts";
import { createEmployeeColumnLookup } from "../src/lib/imports/employee-column-map.ts";
import { normalizeHeaderName } from "../src/lib/imports/employee-normalizers.ts";

// THE GAP THIS CLOSES. The Employee Master sheet and the employee edit form are two doors onto the
// same row, and for one day in September 2026 they disagreed: fourteen fields HR had asked for
// landed on the sheet, the upload wrote them, and the form still showed the old set — so a field
// was fillable by spreadsheet and invisible on the screen HR actually opens. Nothing failed; the
// form simply had no input for them.
//
// Neither half can notice that on its own, which is why this is a test and not a convention. It
// reads the two files as TEXT rather than rendering the component: the form is a 4,000-line client
// component with Next.js and React context all the way through it, and the invariant worth pinning
// is not how an input renders — it is that the field is WIRED AT ALL, in all three places a field
// has to appear before it can be saved.

const FORM = "src/components/employees/employee-management.tsx";
const WRITER = "src/lib/employees/employee-directory.ts";

/**
 * The fields HR asked for on 2026-09-29, paired with the column each one lands in.
 *
 * Written out rather than derived from the column contract, deliberately: most of the contract's
 * keys are org ids the form resolves through a picker (`areaId`, `teamId`) or figures it derives
 * (`basicSalary`), so a derived list would either be wrong or need a second mapping to correct it.
 * These fourteen are plain fields with one input each, and the point of the list is that adding a
 * fifteenth means adding a line here too.
 */
const HR_FIELDS: Array<[formKey: string, column: string]> = [
  ["birthPlace", "birth_place"],
  ["qualification", "qualification"],
  ["universityName", "university_name"],
  ["collegeMajor", "college_major"],
  ["seniorYear", "senior_year"],
  ["contractDuration", "contract_duration"],
  ["contractRenewalDate", "contract_renewal_date"],
  ["probationEndDate", "probation_end_date"],
  ["medicalInsuranceCardReceivedDate", "medical_insurance_card_received_date"],
  ["socialInsuranceStartDate", "social_insurance_start_date"],
  ["kaabElamaalNumber", "kaab_elamaal_number"],
  ["kaabElamaalIssuer", "kaab_elamaal_issuer"],
  ["kaabElamaalIssueDate", "kaab_elamaal_issue_date"],
  ["kaabElamaalRefund", "kaab_elamaal_refund"],
];

export function runEmployeeFormHrFieldsTests() {
  const form = readFileSync(FORM, "utf8");
  const writer = readFileSync(WRITER, "utf8");

  for (const [key, column] of HR_FIELDS) {
    // 1. AN INPUT EXISTS. `updateForm("<key>"` is what every field on this form calls; a field in
    //    the state with no input is exactly the invisible-field bug this test is here for.
    assert.ok(
      form.includes(`updateForm("${key}"`),
      `"${key}" has no input on the employee form — it is fillable from the Employee Master upload ` +
        "and invisible on the screen HR opens",
    );

    // 2. THE FORM LOADS IT BACK. Without this an edit to any OTHER field re-submits this one blank.
    assert.ok(
      form.includes(`${key}: employee.${key} ??`),
      `"${key}" is never read back into the form from the employee row — opening an existing ` +
        "employee would show it empty, and saving would submit that emptiness",
    );

    // 3. THE SAVE CARRIES IT.
    assert.ok(
      form.includes(`${key}: optionalText(form.${key})`),
      `"${key}" is not in the payload the form submits — typing in it would do nothing`,
    );

    // 4. THE WRITER PERSISTS IT.
    assert.ok(
      writer.includes(`${column}:`),
      `employees.${column} is never written by employeePayload — the form would post the value and ` +
        "the database would keep the old one",
    );
  }

  // The sheet half of the same contract: each of these is an IMPORTED master column, so the upload
  // writes it too. A column that stopped being imported would make the sheet lie about what it
  // saves, which is the failure the alias table already guards — this checks the pairing holds for
  // these fourteen specifically.
  const lookup = createEmployeeColumnLookup();
  for (const [key] of HR_FIELDS) {
    const column = columns.find((candidate) => candidate.key === key);
    assert.ok(column, `"${key}" is not on the Employee Master sheet at all`);
    assert.equal(
      column.imported,
      true,
      `"${column.header}" is on the sheet but marked as not imported — HR would fill it and the ` +
        "upload would drop it",
    );
    assert.ok(
      lookup.get(normalizeHeaderName(column.header)),
      `"${column.header}" matches no alias in employee-column-map.ts — the upload would silently ` +
        "stop writing that field",
    );
  }
}
