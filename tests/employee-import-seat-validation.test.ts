import { strict as assert } from "node:assert";

import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";
import { createOrgCode } from "../src/lib/imports/org-rule-engine.ts";

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

// The real import path (app/api/imports/employees/confirm) always loads the 42 canonical areas
// before validating, so sales-line rows can resolve their Area. Supply that context here or the
// Phase-7 fail-closed guard blocks every sales-line row with "canonical_area_unavailable" (by
// design) and masks the seat/CRM/salary logic this test actually covers.
const canonicalAreas = [
  { code: "AB1", name: "Cairo" },
  { code: "AB2", name: "Giza" },
];

export function runEmployeeImportSeatValidationTests() {
  const duplicateUpload = validateEmployeeImportRows(
    [
      employeeRow({ HR_ID: "T-001", "Full Name": "First Rep" }),
      employeeRow({ HR_ID: "T-002", "Full Name": "Second Rep" }),
    ],
    { existingState: { canonicalAreas } },
  );

  assert.equal(duplicateUpload.failedRows, 1);
  assert.equal(
    duplicateUpload.validationErrors.some((issue) => issue.code === "duplicate_employee_org_seat"),
    true,
  );
  assert.match(
    duplicateUpload.validationErrors.find((issue) => issue.code === "duplicate_employee_org_seat")?.message ?? "",
    /same title, position, area, region, and line/i,
  );

  const duplicateExisting = validateEmployeeImportRows(
    [employeeRow({ HR_ID: "T-003", "Full Name": "Third Rep" })],
    {
      existingState: {
        canonicalAreas,
        employeeOrgSeats: [
          {
            // Post-cutover existing employees carry the canonical area code that "Cairo" resolves to.
            areaCode: canonicalAreas[0].code,
            hrId: "T-000",
            jobTitle: "Medical Representative",
            lineCode: createOrgCode("Pedia"),
            positionCode: createOrgCode("Medical Representative"),
            regionName: "Cairo",
          },
        ],
      },
    },
  );

  assert.equal(duplicateExisting.failedRows, 1);
  assert.equal(
    duplicateExisting.validationErrors.some((issue) => issue.code === "duplicate_employee_org_seat_existing"),
    true,
  );

  const differentRegion = validateEmployeeImportRows(
    [
      employeeRow({ HR_ID: "T-004", Region: "Cairo" }),
      employeeRow({ HR_ID: "T-005", Region: "Giza" }),
    ],
    { existingState: { canonicalAreas } },
  );

  assert.equal(
    differentRegion.validationErrors.some((issue) => issue.code.startsWith("duplicate_employee_org_seat")),
    false,
  );

  const salaryFormula = validateEmployeeImportRows(
    [
      employeeRow({
        "Base Salary": 14000,
        "Basic Salary": 1,
        "Full Name": "Salary Formula Rep",
        "Gross Salary": 999,
        HR_ID: "T-006",
        "Net Salary": 999,
        "Social Insurance": 1200,
        Taxes: 800,
      }),
    ],
    { existingState: { canonicalAreas } },
  );
  const compensation = salaryFormula.rowsToInsert[0].compensation;

  assert.equal(compensation.baseSalary, 14000);
  assert.equal(compensation.basicSalary, 9800);
  assert.equal(compensation.extraCostOfLiving, 2000);
  assert.equal(compensation.fuelAllowance, 500);
  assert.equal(compensation.grossSalary, 16000);
  assert.equal(compensation.netSalary, 16500);
  assert.equal(
    salaryFormula.validationWarnings.some((issue) => issue.code === "gross_salary_formula_mismatch"),
    true,
  );
  assert.equal(
    salaryFormula.validationWarnings.some((issue) => issue.code === "net_salary_formula_mismatch"),
    true,
  );

  const duplicateCrmUsernameUpload = validateEmployeeImportRows(
    [
      employeeRow({ "CRM Username": "Rep.One", HR_ID: "T-007", Region: "Cairo" }),
      employeeRow({
        Area: "Giza",
        "CRM Username": "rep.one",
        "Full Name": "CRM Duplicate Rep",
        HR_ID: "T-008",
        Line: "Derma",
        Position: "Senior Product Specialist",
        Region: "Giza",
      }),
    ],
    { existingState: { canonicalAreas } },
  );

  assert.equal(duplicateCrmUsernameUpload.failedRows, 2);
  assert.equal(
    duplicateCrmUsernameUpload.validationErrors.some((issue) => issue.code === "duplicate_crm_username"),
    true,
  );
  assert.match(
    duplicateCrmUsernameUpload.validationErrors.find((issue) => issue.code === "duplicate_crm_username")?.message ?? "",
    /duplicate CRM username/i,
  );

  const existingCrmUsernameOwner = validateEmployeeImportRows(
    [employeeRow({ "CRM Username": "Rep.Ten", HR_ID: "T-010" })],
    {
      existingState: {
        canonicalAreas,
        crmUsernameToHrId: new Map([["rep.ten", "T-000"]]),
      },
    },
  );

  assert.equal(existingCrmUsernameOwner.failedRows, 1);
  assert.equal(
    existingCrmUsernameOwner.validationErrors.some((issue) => issue.code === "crm_username_already_assigned"),
    true,
  );
}
