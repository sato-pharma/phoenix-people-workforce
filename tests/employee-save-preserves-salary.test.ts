import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { employeeCompensationColumns } from "../src/lib/employees/employee-directory.ts";

/**
 * A SAVE THAT CARRIES NO PAY MUST NEVER ERASE PAY.
 *
 * `employees` has no history table behind it: an overwritten salary produces no audit row and
 * cannot be recovered from this database. Before this was pinned, `employeePayload` wrote ten money
 * columns unconditionally, so any caller whose payload simply did not carry pay — a partial API
 * save, a script, a client that never rendered the salary section, or a viewer whose read of those
 * figures was redacted — blanked real payroll data as a side effect of editing a phone number.
 *
 * The route-level guard that stood in for this keyed on WHO WAS VIEWING
 * (`isSalaryRedactedForViewer`: HR Advisory / HR Operations, and only for a named list of HR ids),
 * so it never fired for Super Admin, nor for anyone off that list. These tests pin the rule on the
 * PAYLOAD instead, which is what actually decides whether a figure exists to write.
 */
export function runEmployeeSavePreservesSalaryTests() {
  const MONEY_COLUMNS = [
    "base_salary",
    "basic_salary",
    "extra_cost_of_living",
    "fuel_allowance",
    "gross_salary",
    "medical_insurance",
    "net_salary",
    "social_insurance",
    "social_insurance_wage",
    "taxes",
  ];

  // ---------------------------------------------------------------------------------------------
  // THE HEADLINE: a Super Admin save that omits every money field writes no money column at all.
  // Super Admin is precisely the case the viewer-keyed guard could never cover — its reads are
  // never redacted, so isSalaryRedactedForViewer returns false and the route's splice never runs.
  // ---------------------------------------------------------------------------------------------
  const omittedColumns = employeeCompensationColumns(
    { hrId: "B-77", fullName: "Omitted Money Fields", mobileNumber: "01000000000" },
    true,
  );

  for (const column of MONEY_COLUMNS) {
    assert.equal(
      Object.hasOwn(omittedColumns, column),
      false,
      `${column} must be ABSENT from the upsert body when the payload carried no value for it — a key present with null is what PostgREST turns into "SET ${column} = NULL" and erases real payroll data`,
    );
  }
  assert.deepEqual(
    Object.keys(omittedColumns),
    [],
    "a save carrying no pay at all must write no money column whatsoever",
  );

  // ---------------------------------------------------------------------------------------------
  // The edit form posts explicit null for an empty box (formToPayload's optionalNumber), never
  // undefined — so "absent" and "cleared" are indistinguishable on the wire and BOTH must preserve.
  // This is the same call the employee import already makes for these columns (the `!== null`
  // guards in app/api/imports/employees/confirm/route.ts).
  // ---------------------------------------------------------------------------------------------
  assert.deepEqual(
    Object.keys(
      employeeCompensationColumns(
        {
          hrId: "B-77",
          fullName: "Explicit Nulls",
          baseSalary: null,
          basicSalary: null,
          extraCostOfLiving: null,
          fuelAllowance: null,
          grossSalary: null,
          medicalInsurance: null,
          netSalary: null,
          socialInsurance: null,
          socialInsuranceWage: null,
          taxes: null,
        },
        true,
      ),
    ),
    [],
    "an explicitly-nulled money field preserves too: the form cannot express the difference from absent, and failing to clear is a visible no-op while failing to preserve destroys payroll data silently",
  );

  // ---------------------------------------------------------------------------------------------
  // The statutory half. Payroll never reads social_insurance_status — the WAGE column alone decides
  // what is filed with the Authority — so blanking it silently changes a government filing.
  // ---------------------------------------------------------------------------------------------
  const wageColumns = employeeCompensationColumns(
    { hrId: "B-77", fullName: "Wage Only", socialInsuranceWage: 9400 },
    true,
  );
  assert.equal(
    wageColumns.social_insurance_wage,
    9400,
    "a supplied insurance wage is still written — preservation must not make the column unwritable",
  );
  assert.equal(
    Object.hasOwn(wageColumns, "base_salary"),
    false,
    "supplying ONE money field must not drag the others in as nulls: base_salary stays absent",
  );
  assert.equal(
    Object.hasOwn(wageColumns, "taxes"),
    false,
    "taxes stays absent when only the insurance wage was supplied",
  );

  // ---------------------------------------------------------------------------------------------
  // Preservation must not become a write blocker: every supplied figure still reaches its column,
  // and the net-salary derivation chain still fills the rest in.
  // ---------------------------------------------------------------------------------------------
  const suppliedColumns = employeeCompensationColumns(
    {
      hrId: "B-77",
      fullName: "Every Figure Supplied",
      baseSalary: 12000,
      basicSalary: 8400,
      extraCostOfLiving: 500,
      fuelAllowance: 750,
      grossSalary: 15000,
      medicalInsurance: 200,
      netSalary: 11000,
      socialInsurance: 1300,
      socialInsuranceWage: 9400,
      taxes: 900,
    },
    true,
  );
  assert.deepEqual(
    Object.keys(suppliedColumns).sort(),
    [...MONEY_COLUMNS].sort(),
    "every money column the caller actually supplied is still written on an update",
  );
  // The pass-through figures, which this change must leave exactly as the caller sent them.
  assert.equal(suppliedColumns.base_salary, 12000, "a supplied base salary reaches the column unchanged");
  assert.equal(suppliedColumns.basic_salary, 8400, "a supplied basic salary reaches the column unchanged");
  assert.equal(suppliedColumns.medical_insurance, 200, "a supplied medical insurance figure reaches the column unchanged");
  assert.equal(suppliedColumns.social_insurance, 1300, "a supplied social insurance figure reaches the column unchanged");
  assert.equal(suppliedColumns.taxes, 900, "a supplied tax figure reaches the column unchanged");

  // A payload carrying only the net salary still derives the whole chain, exactly as before —
  // preservation keys on what the payload yields, not on how many keys the caller happened to send.
  const derivedFromNet = employeeCompensationColumns(
    { hrId: "B-77", fullName: "Net Only", netSalary: 11000 },
    true,
  );
  assert.equal(
    typeof derivedFromNet.base_salary,
    "number",
    "a net salary alone still derives and writes a base salary — the derivation chain is untouched",
  );
  assert.equal(derivedFromNet.net_salary, 11000, "the supplied net salary is written");
  assert.equal(
    Object.hasOwn(derivedFromNet, "taxes"),
    false,
    "taxes is not part of the net-salary derivation, so an unsupplied one is preserved rather than nulled",
  );

  // Zero is a real figure, not an absence — it must be written, or a genuine zero silently reverts
  // to whatever was stored before.
  const zeroColumns = employeeCompensationColumns(
    { hrId: "B-77", fullName: "Zeroed", taxes: 0, socialInsurance: 0 },
    true,
  );
  assert.equal(zeroColumns.taxes, 0, "an explicit 0 is a supplied value and must be written, not preserved away");
  assert.equal(zeroColumns.social_insurance, 0, "an explicit 0 social insurance is written");

  // ---------------------------------------------------------------------------------------------
  // On a CREATE there is no stored figure to protect, so the columns are written exactly as before
  // and a new row's pay is never left implicit.
  // ---------------------------------------------------------------------------------------------
  const created = employeeCompensationColumns(
    { hrId: "B-77", fullName: "Omitted Money Fields" },
    false,
  );
  assert.deepEqual(
    Object.keys(created).sort(),
    [...MONEY_COLUMNS].sort(),
    "a create still writes every money column explicitly — preservation only applies where something is stored",
  );
  assert.equal(created.base_salary, null, "a create with no salary writes an explicit null, as before");

  // ---------------------------------------------------------------------------------------------
  // WIRING. The behaviour above is worthless if employeePayload stops routing through the helper,
  // so pin that its returned payload spreads it and re-writes none of these columns on its own.
  // Matched by regex, never a byte window: this file is ~87KB and shifts constantly.
  // ---------------------------------------------------------------------------------------------
  const source = readFileSync("src/lib/employees/employee-directory.ts", "utf8");
  assert.match(
    source,
    /\.\.\.employeeCompensationColumns\(input, isUpdate\)/,
    "employeePayload must build its money columns through employeeCompensationColumns, or the preservation rule is bypassed entirely",
  );

  // Isolate employeePayload's OWN returned object. Anchored on stable declarations rather than a
  // byte window, so this does not false-fail as the file shifts around it — and scoped, so it does
  // not read employeeCompensationColumns' own (correct) object literal as a violation.
  const payloadStart = source.indexOf("async function employeePayload(");
  assert.notEqual(payloadStart, -1, "employeePayload must still exist to be pinned");
  const returnStart = source.indexOf("\n  return {", payloadStart);
  assert.notEqual(returnStart, -1, "employeePayload must still end in a returned payload object");
  const returnEnd = source.indexOf("\n  };", returnStart);
  assert.notEqual(returnEnd, -1, "employeePayload's returned object must be terminated");
  const payloadObject = source.slice(returnStart, returnEnd);
  assert.match(
    payloadObject,
    /employeeCompensationColumns/,
    "the isolated payload object must be the one that spreads the compensation columns",
  );

  for (const column of MONEY_COLUMNS) {
    assert.doesNotMatch(
      payloadObject,
      new RegExp(`^\\s{4}${column}:`, "m"),
      `${column} must not be written unconditionally in employeePayload's returned object — that is exactly the shape that erases pay; it belongs inside employeeCompensationColumns`,
    );
  }

  // The route-level redaction splice stays: it solves a different problem (a redacted viewer
  // legitimately submitting blanked values) and this change makes it belt-and-braces, not redundant.
  assert.match(
    readFileSync("app/api/employees/route.ts", "utf8"),
    /isSalaryRedactedForViewer\(access, payload\.employee\.hrId\)/,
    "the employees POST route must keep re-splicing current salary for a redacted viewer",
  );
}
