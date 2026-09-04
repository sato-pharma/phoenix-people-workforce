// Two things this pins:
//
// 1. THE BUG the owner reported: the deductions XLSX printed a BLANK "Applied
//    Value"/"Applied Amount" for a deduction that was approved to payroll. The
//    reviewer approving WITHOUT narrowing the days leaves decision.appliedValue
//    and appliedAmount null; the export printed those raw fields, while publish
//    falls back to rawValue/estimatedAmount. So an approved row showed nothing.
//    The Applied columns must now show the SAME figure publish commits, and a row
//    publish will not take (Pending / cleared) must show 0, never the estimate.
//
// 2. The MASTER export: a per-employee Summary of what will actually be deducted
//    (eligible only, pending shown apart) and a Detailed sheet carrying two extra
//    columns the per-category sheet does not — Line and Direct Manager (Region
//    joined them later, with the Line/Region filter).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { buildDeductionsCategoryWorkbook } from "../src/lib/deductions/exports/category-workbook.ts";
import {
  buildDeductionsMasterWorkbook,
  type EmployeeOrgInfo,
} from "../src/lib/deductions/exports/master-workbook.ts";
import type {
  DeductionsCandidateWithDecision,
  DeductionsCategory,
  DeductionsDecisionStatus,
  DeductionsUnit,
} from "../src/lib/deductions/types.ts";

function candidate(input: {
  id: string;
  category: DeductionsCategory;
  employeeHrId?: string;
  employeeHrIdCompact?: string;
  employeeName?: string;
  sourceSystem?: string;
  unit?: DeductionsUnit;
  rawValue?: number;
  estimatedAmount?: number | null;
  decisionStatus: DeductionsDecisionStatus | null;
  appliedValue?: number | null;
  appliedAmount?: number | null;
}): DeductionsCandidateWithDecision {
  return {
    id: input.id,
    category: input.category,
    sourceSystem: input.sourceSystem ?? "fingerprint_report",
    sourceRecordId: `rec-${input.id}`,
    candidateKey: `key-${input.id}`,
    employeeHrId: input.employeeHrId ?? "B-207",
    employeeHrIdCompact: input.employeeHrIdCompact ?? "b207",
    employeeName: input.employeeName ?? "Ali Mohamed",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: input.unit ?? "days",
    rawValue: input.rawValue ?? 1,
    estimatedAmount: input.estimatedAmount === undefined ? 1000 : input.estimatedAmount,
    calculationStatus: "calculated",
    severity: null,
    reason: null,
    evidence: {},
    dates: ["2026-07-12"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-07-01T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    decision:
      input.decisionStatus === null
        ? null
        : {
            id: `d-${input.id}`,
            candidateId: input.id,
            decisionStatus: input.decisionStatus,
            decisionReason: input.decisionStatus === "Pending" ? "" : "reason",
            hrNote: "",
            appliedValue: input.appliedValue ?? null,
            appliedAmount: input.appliedAmount ?? null,
            appliedDates: null,
            decidedBy: null,
            decidedAt: null,
            actorRoleAtDecision: null,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-01T00:00:00Z",
          },
  };
}

/** The [row, col] of the header cell whose value is exactly `label`. */
function headerCell(sheet: ExcelJS.Worksheet, label: string): { row: number; col: number } {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      if (sheet.getRow(r).getCell(c).value === label) return { row: r, col: c };
    }
  }
  throw new Error(`header "${label}" not found in sheet "${sheet.name}"`);
}

/** The value under `columnLabel` on the data row whose "HR ID" cell equals `hrId`. */
function cellFor(sheet: ExcelJS.Worksheet, hrId: string, columnLabel: string): unknown {
  const idHeader = headerCell(sheet, "HR ID");
  const target = headerCell(sheet, columnLabel);
  for (let r = idHeader.row + 1; r <= sheet.rowCount; r += 1) {
    if (sheet.getRow(r).getCell(idHeader.col).value === hrId) {
      return sheet.getRow(r).getCell(target.col).value;
    }
  }
  throw new Error(`no data row for HR ID "${hrId}" in sheet "${sheet.name}"`);
}

/** The value under `columnLabel` on the row whose first cell is "TOTAL". */
function totalFor(sheet: ExcelJS.Worksheet, columnLabel: string): unknown {
  const target = headerCell(sheet, columnLabel);
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    if (sheet.getRow(r).getCell(1).value === "TOTAL") {
      return sheet.getRow(r).getCell(target.col).value;
    }
  }
  throw new Error(`no TOTAL row in sheet "${sheet.name}"`);
}

export async function runDeductionsExportAppliedAndMasterTests(): Promise<void> {
  const meta = {
    monthKey: "2026-07",
    generatedAtIso: "2026-08-01T00:00:00Z",
    generatedByName: "Tester",
    generatedByHrId: "T-1",
  };

  // ── 1. The category export: approved-without-narrowing must NOT be blank ────
  const approved = candidate({
    id: "c-approved",
    category: "fingerprint",
    employeeHrId: "B-207",
    rawValue: 4,
    estimatedAmount: 4183.86,
    decisionStatus: "Approved for Payroll",
    // The exact production shape: approved, but the reviewer never touched the
    // days, so both applied fields are null.
    appliedValue: null,
    appliedAmount: null,
  });
  const cleared = candidate({
    id: "c-cleared",
    category: "fingerprint",
    employeeHrId: "B-301",
    employeeHrIdCompact: "b301",
    employeeName: "Sara Cleared",
    rawValue: 2,
    estimatedAmount: 2000,
    decisionStatus: "Do Not Take Action",
  });
  const pending = candidate({
    id: "c-pending",
    category: "fingerprint",
    employeeHrId: "B-402",
    employeeHrIdCompact: "b402",
    employeeName: "Nour Pending",
    rawValue: 1,
    estimatedAmount: 1000,
    decisionStatus: "Pending",
  });

  const categoryWb = buildDeductionsCategoryWorkbook({
    meta: { ...meta, category: "fingerprint" },
    candidates: [approved, cleared, pending],
  });
  const categorySheet = categoryWb.getWorksheet("Fingerprint")!;
  assert.ok(categorySheet, "the category sheet must exist");

  // The headline regression. Before the fix these two were blank ("").
  assert.equal(
    cellFor(categorySheet, "B-207", "Applied Value"),
    4,
    "an approved deduction must show its applied days (rawValue when the reviewer did not narrow), never a blank",
  );
  assert.equal(
    cellFor(categorySheet, "B-207", "Applied Amount"),
    4183.86,
    "an approved deduction must show the amount publish will take (estimatedAmount fallback), never a blank",
  );
  // A row publish will not take applies nothing — 0, not the detected estimate.
  assert.equal(cellFor(categorySheet, "B-301", "Applied Amount"), 0, "a cleared row applies nothing");
  assert.equal(cellFor(categorySheet, "B-402", "Applied Amount"), 0, "a Pending fingerprint row is not yet applied");
  // The TOTAL is what publish takes: only the approved row.
  assert.equal(
    totalFor(categorySheet, "Applied Amount"),
    4183.86,
    "the TOTAL must sum only what will be deducted, not every detected candidate",
  );

  // ── 2. The master export ────────────────────────────────────────────────────
  const e1Approved = candidate({
    id: "m1",
    category: "fingerprint",
    employeeHrId: "B-207",
    employeeHrIdCompact: "b207",
    employeeName: "Alpha Employee",
    rawValue: 4,
    estimatedAmount: 4183.86,
    decisionStatus: "Approved for Payroll",
  });
  const e1Pending = candidate({
    id: "m2",
    category: "fingerprint",
    employeeHrId: "B-207",
    employeeHrIdCompact: "b207",
    employeeName: "Alpha Employee",
    rawValue: 1,
    estimatedAmount: 1000,
    decisionStatus: "Pending",
  });
  const e2CrmMandatory = candidate({
    id: "m3",
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    employeeHrId: "B-500",
    employeeHrIdCompact: "b500",
    employeeName: "Beta Employee",
    rawValue: 1,
    estimatedAmount: 725.81,
    decisionStatus: "Pending",
  });
  const e2Cleared = candidate({
    id: "m4",
    category: "fingerprint",
    employeeHrId: "B-500",
    employeeHrIdCompact: "b500",
    employeeName: "Beta Employee",
    rawValue: 3,
    estimatedAmount: 500,
    decisionStatus: "Do Not Take Action",
  });

  const orgByCompactHrId = new Map<string, EmployeeOrgInfo>([
    ["b207", { lineName: "CNS", regionName: "Cairo", managerName: "Manager One" }],
    ["b500", { lineName: "Pedia", regionName: "Delta (2)", managerName: "Manager Two" }],
  ]);

  const masterWb = buildDeductionsMasterWorkbook({
    meta,
    candidates: [e1Approved, e1Pending, e2CrmMandatory, e2Cleared],
    orgByCompactHrId,
  });

  const summary = masterWb.getWorksheet("Summary")!;
  assert.ok(summary, "the master workbook must have a Summary sheet");
  // Final = eligible only. Pending shown apart.
  assert.equal(
    cellFor(summary, "B-207", "Final Deduction (EGP)"),
    4183.86,
    "the summary's final value is what will actually be deducted — the approved fingerprint row only",
  );
  assert.equal(
    cellFor(summary, "B-207", "Pending (awaiting approval)"),
    1000,
    "the unapproved fingerprint row is pending, never folded into the final figure",
  );
  assert.equal(
    cellFor(summary, "B-500", "Final Deduction (EGP)"),
    725.81,
    "a mandatory CRM day is deducted by default, so it is the final figure for that employee",
  );
  // The summary carries the employee's line + direct manager too.
  assert.equal(cellFor(summary, "B-207", "Line"), "CNS", "the summary shows each employee's line");
  assert.equal(cellFor(summary, "B-207", "Region"), "Cairo", "the summary shows each employee's region");
  assert.equal(cellFor(summary, "B-207", "Direct Manager"), "Manager One", "the summary shows the direct manager");

  const detailed = masterWb.getWorksheet("Detailed")!;
  assert.ok(detailed, "the master workbook must have a Detailed sheet");
  // The two new columns exist and are populated — the core of the second ask.
  headerCell(detailed, "Line");
  headerCell(detailed, "Direct Manager");
  assert.equal(cellFor(detailed, "B-207", "Line"), "CNS", "the detailed sheet resolves the employee's line");
  assert.equal(
    cellFor(detailed, "B-207", "Direct Manager"),
    "Manager One",
    "the detailed sheet resolves the direct manager of the person with the deduction",
  );
  headerCell(detailed, "Category");
  assert.equal(
    cellFor(detailed, "B-207", "Applied Amount"),
    4183.86,
    "the detailed sheet's applied amount matches what publish takes",
  );

  // Grand total across all categories = only what publish commits.
  assert.equal(
    totalFor(detailed, "Applied Amount"),
    round2(4183.86 + 725.81),
    "the master detail TOTAL is the approved fingerprint plus the mandatory CRM day, nothing cleared or pending",
  );

  // ── 3. The UI actually offers the master export ─────────────────────────────
  const workspace = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
  assert.match(
    workspace,
    /\/api\/admin\/deductions\/export\/master\?monthKey=/,
    "the workspace must expose a month-level Master XLSX download button",
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
