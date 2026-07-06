import { strict as assert } from "node:assert";

import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";
import { createOrgCode } from "../src/lib/imports/org-rule-engine.ts";

function employeeRow(overrides: Record<string, unknown> = {}) {
  return {
    Area: "Heliopolis",
    "Full Name": "Test Employee",
    HR_ID: "T-001",
    "Job Title": "Medical Representative",
    Line: "Pedia",
    Position: "Medical Representative",
    ...overrides,
  };
}

export function runEmployeeImportSeatValidationTests() {
  const duplicateUpload = validateEmployeeImportRows([
    employeeRow({ HR_ID: "T-001", "Full Name": "First Rep" }),
    employeeRow({ HR_ID: "T-002", "Full Name": "Second Rep" }),
  ]);

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
        employeeOrgSeats: [
          {
            // Existing seats are loaded post-migration with the OFFICIAL area/line codes
            // (public.areas.code / public.lines.code), not the old auto-slugs.
            areaCode: "CA1",
            hrId: "T-000",
            jobTitle: "Medical Representative",
            lineCode: "PD",
            positionCode: createOrgCode("Medical Representative"),
            // This fixture doesn't provide regionCodeByLineArea, so the new row's region can't
            // be derived either — keep both sides null so the seat key still lines up.
            regionName: null,
            regionCode: null,
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

  // Region is derived from (line, area) now, not typed in — two rows only end up in different
  // regions if they're in genuinely different areas.
  const differentRegion = validateEmployeeImportRows([
    employeeRow({ HR_ID: "T-004" }),
    employeeRow({ HR_ID: "T-005", Area: "Giza - Giza Centers" }),
  ]);

  assert.equal(
    differentRegion.validationErrors.some((issue) => issue.code.startsWith("duplicate_employee_org_seat")),
    false,
  );

  const salaryFormula = validateEmployeeImportRows([
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
  ]);
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

  const duplicateCrmUsernameUpload = validateEmployeeImportRows([
    employeeRow({ "CRM Username": "Rep.One", HR_ID: "T-007" }),
    employeeRow({
      Area: "Giza - Giza Centers",
      "CRM Username": "rep.one",
      "Full Name": "CRM Duplicate Rep",
      HR_ID: "T-008",
      Position: "Senior Product Specialist",
    }),
  ]);

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
        crmUsernameToHrId: new Map([["rep.ten", "T-000"]]),
      },
    },
  );

  assert.equal(existingCrmUsernameOwner.failedRows, 1);
  assert.equal(
    existingCrmUsernameOwner.validationErrors.some((issue) => issue.code === "crm_username_already_assigned"),
    true,
  );

  // "Head Office" is a two-word line name that slugifies to "head_office" — a distinct slug from
  // the single-word "office" key lineRules already mapped. Regression guard for that gap.
  const headOfficeLine = validateEmployeeImportRows([
    employeeRow({ Area: "", HR_ID: "T-011", Line: "Head Office" }),
  ]);

  assert.equal(
    headOfficeLine.validationErrors.some((issue) => issue.code === "invalid_line"),
    false,
    headOfficeLine.validationErrors.find((issue) => issue.code === "invalid_line")?.message ?? "expected no invalid_line error",
  );
  assert.equal(headOfficeLine.failedRows, 0);

  // The organogram's own areas table is the source of truth, not the 40-code Sales-geography
  // reconciliation list — these are real pre-unification duplicate rows still assigned to active
  // employees in production (confirmed live: head_office=13, delta_2=3, alex_behiera=1 employees).
  // They must resolve via existingState.areaCodes even though they're absent from the official map.
  const legacyLiveAreas = validateEmployeeImportRows(
    [
      employeeRow({ Area: "Head office", HR_ID: "T-012", Line: "Head Office" }),
      employeeRow({ Area: "Delta (2)", HR_ID: "T-013" }),
      employeeRow({ Area: "Alex - Behiera", HR_ID: "T-014" }),
    ],
    {
      existingState: {
        areaCodes: new Set(["head_office", "delta_2", "alex_behiera"]),
      },
    },
  );

  assert.equal(
    legacyLiveAreas.validationErrors.some((issue) => issue.code === "invalid_area"),
    false,
    legacyLiveAreas.validationErrors.find((issue) => issue.code === "invalid_area")?.message ?? "expected no invalid_area error",
  );

  // An area slug that matches neither the official reconciliation map NOR any known organogram row
  // (a genuine typo/unofficial name) must still be blocked.
  const trulyUnofficialArea = validateEmployeeImportRows(
    [employeeRow({ Area: "Not A Real Area", HR_ID: "T-015" })],
    {
      existingState: {
        areaCodes: new Set(["head_office", "delta_2", "alex_behiera"]),
      },
    },
  );

  assert.equal(
    trulyUnofficialArea.validationErrors.some((issue) => issue.code === "invalid_area"),
    true,
  );
}
