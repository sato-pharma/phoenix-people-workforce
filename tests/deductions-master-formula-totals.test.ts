// The MASTER deductions workbook carries LIVE Excel formulas for every total,
// not numbers baked in at export time (owner rule, 2026-10-06: "every total must
// be formula"). This pins three things the change turns on:
//
//   1. Every total is a SUM formula — the per-employee Final Deduction (footing
//      to that row's own category cells), the Summary totals row (footing down
//      each column), the Detailed Applied-Amount total, and the Cover's two
//      headline figures (a cross-sheet SUM of the Summary's columns).
//   2. The formulas actually point at the right cells: we parse each SUM range,
//      read the cells it names, and confirm they sum to the formula's cached
//      result. A layout drift that left a formula pointing at the wrong rows
//      would fail here even though the cached number looked correct.
//   3. The numbers are unchanged — SUM-of-cells equals what publish/payroll
//      takes, because candidate amounts are already 2dp at source.

import { strict as assert } from "node:assert";

import ExcelJS from "exceljs";

import {
  buildDeductionsMasterWorkbook,
  type EmployeeOrgInfo,
} from "../src/lib/deductions/exports/master-workbook.ts";
import type {
  DeductionsCandidateWithDecision,
  DeductionsCategory,
  DeductionsDecisionStatus,
} from "../src/lib/deductions/types.ts";

function candidate(input: {
  id: string;
  category: DeductionsCategory;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string;
  estimatedAmount: number;
  decisionStatus: DeductionsDecisionStatus;
  sourceSystem?: string;
}): DeductionsCandidateWithDecision {
  return {
    id: input.id,
    category: input.category,
    sourceSystem: input.sourceSystem ?? "fingerprint_report",
    sourceRecordId: `rec-${input.id}`,
    candidateKey: `key-${input.id}`,
    employeeHrId: input.employeeHrId,
    employeeHrIdCompact: input.employeeHrIdCompact,
    employeeName: input.employeeName,
    monthKey: "2026-09",
    month: 9,
    year: 2026,
    unit: "days",
    rawValue: 1,
    estimatedAmount: input.estimatedAmount,
    calculationStatus: "calculated",
    severity: null,
    reason: null,
    evidence: {},
    dates: ["2026-09-12"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-09-01T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    decision: {
      id: `d-${input.id}`,
      candidateId: input.id,
      decisionStatus: input.decisionStatus,
      decisionReason: input.decisionStatus === "Pending" ? "" : "reason",
      hrNote: "",
      appliedValue: null,
      appliedAmount: null,
      appliedDates: null,
      decidedBy: null,
      decidedAt: null,
      actorRoleAtDecision: null,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    },
  };
}

type FormulaValue = { formula: string; result: number };

function isFormulaCell(value: unknown): value is FormulaValue {
  return typeof value === "object" && value !== null && "formula" in value;
}

/** A cell's number, unwrapping a formula cell to its cached result. */
function numOf(value: unknown): number {
  if (isFormulaCell(value)) return typeof value.result === "number" ? value.result : 0;
  if (typeof value === "number") return value;
  return 0;
}

function headerCell(sheet: ExcelJS.Worksheet, label: string): { row: number; col: number } {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      if (sheet.getRow(r).getCell(c).value === label) return { row: r, col: c };
    }
  }
  throw new Error(`header "${label}" not found in sheet "${sheet.name}"`);
}

function dataRowFor(sheet: ExcelJS.Worksheet, hrId: string): number {
  const idHeader = headerCell(sheet, "HR ID");
  for (let r = idHeader.row + 1; r <= sheet.rowCount; r += 1) {
    if (sheet.getRow(r).getCell(idHeader.col).value === hrId) return r;
  }
  throw new Error(`no data row for HR ID "${hrId}" in sheet "${sheet.name}"`);
}

function totalRow(sheet: ExcelJS.Worksheet): number {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    if (sheet.getRow(r).getCell(1).value === "TOTAL") return r;
  }
  throw new Error(`no TOTAL row in sheet "${sheet.name}"`);
}

const COLUMN_RE = /SUM\((?:'([^']+)'!)?([A-Z]+)(\d+):([A-Z]+)(\d+)\)/;

function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1-based
}

/** Reads the cells a SUM() names and returns their numeric sum — so the formula
 *  is checked against where the data ACTUALLY is, not just its cached result.
 *  Handles both a column range (F3:F5) and a row range (F3:G3). */
function evalSum(workbook: ExcelJS.Workbook, ownSheet: ExcelJS.Worksheet, formula: string): number {
  const m = COLUMN_RE.exec(formula);
  assert.ok(m, `formula must be a single SUM range, got "${formula}"`);
  const [, sheetName, startCol, startRow, endCol, endRow] = m;
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : ownSheet;
  assert.ok(sheet, `formula references a sheet that is not in the workbook: "${sheetName}"`);
  let sum = 0;
  for (let c = columnToIndex(startCol); c <= columnToIndex(endCol); c += 1) {
    for (let r = Number(startRow); r <= Number(endRow); r += 1) {
      sum += numOf(sheet.getRow(r).getCell(c).value);
    }
  }
  return Math.round(sum * 100) / 100;
}

/** Asserts a cell is a SUM formula whose result equals `expected` AND whose
 *  range actually sums to `expected`. */
function assertFooting(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  row: number,
  col: number,
  expected: number,
  what: string,
): void {
  const value = sheet.getRow(row).getCell(col).value;
  assert.ok(isFormulaCell(value), `${what} must be a formula, not a static number`);
  assert.match(value.formula, /^SUM\(/, `${what} must be a SUM formula`);
  // ExcelJS drops a formula's cached result when it is 0, so read through numOf
  // (undefined → 0); Excel recalculates it on open regardless.
  assert.equal(numOf(value), expected, `${what}: cached result`);
  assert.equal(evalSum(workbook, sheet, value.formula), expected, `${what}: the SUM range must foot to ${expected}`);
}

export async function runDeductionsMasterFormulaTotalsTests(): Promise<void> {
  const meta = {
    monthKey: "2026-09",
    generatedAtIso: "2026-10-01T00:00:00Z",
    generatedByName: "Tester",
    generatedByHrId: "T-1",
  };

  // Alpha: two eligible categories → Final = 1234.56 + 100 = 1334.56.
  // Beta:  one eligible CRM day    → Final = 725.81.
  // Gamma: a pending fingerprint   → Final = 0, Pending = 50 (on the sheet via Pending).
  const candidates = [
    candidate({ id: "a1", category: "fingerprint", employeeHrId: "B-207", employeeHrIdCompact: "b207", employeeName: "Alpha", estimatedAmount: 1234.56, decisionStatus: "Approved for Payroll" }),
    candidate({ id: "a2", category: "crm", sourceSystem: "crm_visits_mirror", employeeHrId: "B-207", employeeHrIdCompact: "b207", employeeName: "Alpha", estimatedAmount: 100, decisionStatus: "Approved for Payroll" }),
    candidate({ id: "b1", category: "crm", sourceSystem: "crm_visits_mirror", employeeHrId: "B-500", employeeHrIdCompact: "b500", employeeName: "Beta", estimatedAmount: 725.81, decisionStatus: "Approved for Payroll" }),
    candidate({ id: "g1", category: "fingerprint", employeeHrId: "B-900", employeeHrIdCompact: "b900", employeeName: "Gamma", estimatedAmount: 50, decisionStatus: "Pending" }),
  ];

  const orgByCompactHrId = new Map<string, EmployeeOrgInfo>([
    ["b207", { lineName: "CNS", regionName: "Cairo", managerName: "Manager One" }],
    ["b500", { lineName: "Pedia", regionName: "Delta (2)", managerName: "Manager Two" }],
    ["b900", { lineName: "CNS", regionName: "Cairo", managerName: "Manager One" }],
  ]);

  const workbook = buildDeductionsMasterWorkbook({ meta, candidates, orgByCompactHrId });

  const summary = workbook.getWorksheet("Summary")!;
  assert.ok(summary, "the master workbook has a Summary sheet");
  const finalCol = headerCell(summary, "Final Deduction (EGP)").col;
  const pendingCol = headerCell(summary, "Pending (awaiting approval)").col;

  // 1. Each employee's Final Deduction foots to their own category cells.
  assertFooting(workbook, summary, dataRowFor(summary, "B-207"), finalCol, 1334.56, "Alpha's Final Deduction");
  assertFooting(workbook, summary, dataRowFor(summary, "B-500"), finalCol, 725.81, "Beta's Final Deduction");
  assertFooting(workbook, summary, dataRowFor(summary, "B-900"), finalCol, 0, "Gamma's Final Deduction");

  // 2. The Summary totals row — every numeric total is a SUM down its column.
  const tRow = totalRow(summary);
  assertFooting(workbook, summary, tRow, finalCol, 2060.37, "Summary Final Deduction total");
  assertFooting(workbook, summary, tRow, pendingCol, 50, "Summary Pending total");
  assertFooting(workbook, summary, tRow, headerCell(summary, "Fingerprint").col, 1234.56, "Summary Fingerprint total");
  assertFooting(workbook, summary, tRow, headerCell(summary, "CRM").col, 825.81, "Summary CRM total");

  // 3. The Detailed Applied-Amount total.
  const detailed = workbook.getWorksheet("Detailed")!;
  assert.ok(detailed, "the master workbook has a Detailed sheet");
  assertFooting(
    workbook,
    detailed,
    totalRow(detailed),
    headerCell(detailed, "Applied Amount").col,
    2060.37,
    "Detailed Applied Amount total",
  );

  // 4. The Cover's two headline figures are cross-sheet SUMs of the Summary
  //    columns, never a second static copy that could drift from it.
  const cover = workbook.getWorksheet("Cover")!;
  assert.ok(cover, "the master workbook has a Cover sheet");
  for (const [key, expected] of [
    ["Total to be deducted (applied)", 2060.37],
    ["Total pending (awaiting approval)", 50],
  ] as const) {
    const label = headerCell(cover, key);
    const value = cover.getRow(label.row).getCell(label.col + 1).value;
    assert.ok(isFormulaCell(value), `Cover "${key}" must be a formula`);
    assert.match(value.formula, /^SUM\('?Summary/, `Cover "${key}" must SUM the Summary sheet`);
    assert.equal(numOf(value), expected, `Cover "${key}" cached result`);
    assert.equal(evalSum(workbook, cover, value.formula), expected, `Cover "${key}" must foot to ${expected}`);
  }
}
