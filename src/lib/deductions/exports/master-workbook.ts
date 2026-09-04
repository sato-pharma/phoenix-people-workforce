// Unified Deductions module: the MASTER monthly export.
//
// One workbook for the whole month, every category together — beside the
// per-category export, not replacing it. Three sheets:
//   Cover      — provenance (who, when, totals).
//   Summary    — one row per employee, the amount that WILL ACTUALLY be
//                deducted (the eligible/approved total publish commits), with a
//                separate Pending column for what is still awaiting a decision.
//   Detailed   — every candidate, all categories, one row each, with two extra
//                columns the per-category sheet does not carry: Line and Direct
//                Manager (the employee's own line and reports-to).
//
// The money columns resolve exactly the way publishMonth does — see
// resolvePublishedAppliedValue / resolvePublishedAppliedAmount — so this sheet
// and the payroll it feeds can never disagree.

import ExcelJS from "exceljs";

import { buildCoverSheet, sanitizeSheetName, writeTable, type CellValue, type TableColumn } from "@/lib/export/phoenix-xlsx-style";
import {
  DEDUCTIONS_CATEGORY_CONFIG,
  deductionsCategoryLabel,
  isEligibleForPublish,
  resolveAppliedDeductionDates,
  resolvePublishedAppliedAmount,
  resolvePublishedAppliedValue,
} from "../calculations.ts";
import { summarizeEmployeeMonthCandidates, type EmployeeMonthDeductionSummary } from "../service.ts";
import { deductionsCategories, type DeductionsCandidateWithDecision, type DeductionsCategory } from "../types.ts";

/** The per-employee org enrichment the Detailed sheet's two extra columns need. */
export type EmployeeOrgInfo = { lineName: string | null; managerName: string | null };

export type DeductionsMasterMeta = {
  monthKey: string;
  generatedAtIso: string;
  generatedByName: string;
  generatedByHrId: string;
};

function money(value: number | null): CellValue {
  return value == null ? null : Math.round(value * 100) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function joinDates(dates: readonly string[]): string {
  return dates.length > 0 ? dates.join(", ") : "";
}

// "Applied Value" / "Applied Amount" mean what PAYROLL WILL ACTUALLY TAKE — the
// same resolution the category sheet and publishMonth use. An eligible row shows
// the published figure (with the fallback to raw/estimate when the reviewer
// approved without narrowing days); a row publish will not take shows 0.
function appliedValueCell(candidate: DeductionsCandidateWithDecision): CellValue {
  return isEligibleForPublish(candidate) ? resolvePublishedAppliedValue(candidate) : 0;
}

function appliedAmountCell(candidate: DeductionsCandidateWithDecision): CellValue {
  return isEligibleForPublish(candidate) ? money(resolvePublishedAppliedAmount(candidate)) : 0;
}

// Categories in their configured display order (fingerprint, crm, …), used for
// stable column ordering on the Summary sheet.
const CATEGORIES_IN_ORDER = [...deductionsCategories].sort(
  (left, right) => DEDUCTIONS_CATEGORY_CONFIG[left].sortOrder - DEDUCTIONS_CATEGORY_CONFIG[right].sortOrder,
);

type EmployeeSummaryRow = {
  employeeHrId: string;
  employeeName: string;
  lineName: string;
  managerName: string;
  summary: EmployeeMonthDeductionSummary;
};

function buildEmployeeSummaries(
  candidates: DeductionsCandidateWithDecision[],
  monthKey: string,
  orgByCompactHrId: ReadonlyMap<string, EmployeeOrgInfo>,
): EmployeeSummaryRow[] {
  const byEmployee = new Map<string, DeductionsCandidateWithDecision[]>();
  for (const candidate of candidates) {
    const bucket = byEmployee.get(candidate.employeeHrIdCompact) ?? [];
    bucket.push(candidate);
    byEmployee.set(candidate.employeeHrIdCompact, bucket);
  }

  const rows: EmployeeSummaryRow[] = [];
  for (const [compact, group] of byEmployee) {
    const summary = summarizeEmployeeMonthCandidates({ candidates: group, monthKey });
    if (!summary) continue;
    // Only employees who actually have something at stake — a real deduction OR
    // a pending one. A person whose every candidate was cleared owes nothing and
    // is awaiting nothing, so they belong in the Detailed audit sheet, not on the
    // "what will be deducted" summary.
    if (summary.willPublishTotal <= 0 && summary.pendingTotal <= 0) continue;
    const org = orgByCompactHrId.get(compact);
    rows.push({
      employeeHrId: group[0].employeeHrId,
      employeeName: summary.employeeName ?? group[0].employeeName ?? group[0].employeeHrId,
      lineName: org?.lineName ?? "",
      managerName: org?.managerName ?? "",
      summary,
    });
  }

  return rows.sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  monthKey: string,
  employees: EmployeeSummaryRow[],
): void {
  // Only render a category column if at least one employee has a real (eligible)
  // deduction in it — an all-zero column is noise on a summary.
  const activeCategories = CATEGORIES_IN_ORDER.filter((category) =>
    employees.some((employee) => (employee.summary.willPublish[category]?.amount ?? 0) > 0),
  );

  const columns: TableColumn[] = [
    { label: "HR ID", width: 12 },
    { label: "Employee Name", width: 30 },
    { label: "Line", width: 16 },
    { label: "Direct Manager", width: 24 },
    ...activeCategories.map((category) => ({
      label: deductionsCategoryLabel(category),
      numFmt: "#,##0.00",
      right: true,
      width: 15,
    })),
    { label: "Final Deduction (EGP)", numFmt: "#,##0.00", right: true, width: 18, dataBar: true },
    { label: "Pending (awaiting approval)", numFmt: "#,##0.00", right: true, width: 20 },
  ];

  const rows: CellValue[][] = employees.map((employee) => [
    employee.employeeHrId,
    employee.employeeName,
    employee.lineName,
    employee.managerName,
    ...activeCategories.map((category) => money(employee.summary.willPublish[category]?.amount ?? 0)),
    money(employee.summary.willPublishTotal),
    money(employee.summary.pendingTotal),
  ]);

  const totals: CellValue[] = new Array(columns.length).fill(null);
  totals[0] = "TOTAL";
  activeCategories.forEach((category, index) => {
    totals[4 + index] = round2(
      employees.reduce((sum, employee) => sum + (employee.summary.willPublish[category]?.amount ?? 0), 0),
    );
  });
  totals[columns.length - 2] = round2(employees.reduce((sum, employee) => sum + employee.summary.willPublishTotal, 0));
  totals[columns.length - 1] = round2(employees.reduce((sum, employee) => sum + employee.summary.pendingTotal, 0));

  const sheet = workbook.addWorksheet(sanitizeSheetName("Summary"), { properties: { defaultColWidth: 14 } });
  writeTable(sheet, 1, {
    columns,
    rows,
    title: `Deductions Summary — ${monthKey}`,
    totals,
    note:
      `${employees.length} employee(s) with a deduction this month. ` +
      "Final Deduction is what publishing takes; Pending is detected but not yet approved. Amounts in EGP.",
  });
}

const DETAIL_COLUMNS: TableColumn[] = [
  { label: "Category", width: 16 },
  { label: "HR ID", width: 12 },
  { label: "Employee Name", width: 30 },
  { label: "Line", width: 16 },
  { label: "Direct Manager", width: 24 },
  { label: "Hire Date", width: 12 },
  { label: "Month", width: 10 },
  { label: "Unit", width: 9 },
  { label: "Raw Value", numFmt: "#,##0.00", right: true, width: 11 },
  { label: "Estimated Amount", numFmt: "#,##0.00", right: true, width: 15 },
  { label: "Calculation Status", width: 16 },
  { label: "Severity", width: 10 },
  { label: "Reason", width: 40 },
  { label: "Dates", width: 40 },
  { label: "Applied Dates", width: 40 },
  { label: "Decision Status", width: 18 },
  { label: "Applied Value", numFmt: "#,##0.00", right: true, width: 12 },
  { label: "Applied Amount", numFmt: "#,##0.00", right: true, width: 14, dataBar: true },
  { label: "Decision Reason", width: 40 },
  { label: "HR Note", width: 30 },
  { label: "Decided By", width: 14 },
  { label: "Decided At", width: 18 },
  { label: "Source System", width: 18 },
  { label: "Source Record ID", width: 24 },
  { label: "Created At", width: 18 },
];

function detailRow(
  candidate: DeductionsCandidateWithDecision,
  orgByCompactHrId: ReadonlyMap<string, EmployeeOrgInfo>,
): CellValue[] {
  const org = orgByCompactHrId.get(candidate.employeeHrIdCompact);
  return [
    deductionsCategoryLabel(candidate.category),
    candidate.employeeHrId,
    candidate.employeeName ?? "",
    org?.lineName ?? "",
    org?.managerName ?? "",
    candidate.hireDate ?? "",
    candidate.monthKey,
    candidate.unit,
    candidate.rawValue,
    money(candidate.estimatedAmount),
    candidate.calculationStatus,
    candidate.severity ?? "",
    candidate.reason ?? "",
    joinDates(candidate.dates),
    joinDates(resolveAppliedDeductionDates(candidate)),
    candidate.decision?.decisionStatus ?? "Pending",
    appliedValueCell(candidate),
    appliedAmountCell(candidate),
    candidate.decision?.decisionReason ?? "",
    candidate.decision?.hrNote ?? "",
    candidate.decision?.decidedBy ?? "",
    candidate.decision?.decidedAt ?? "",
    candidate.sourceSystem,
    candidate.sourceRecordId,
    candidate.createdAt,
  ];
}

function buildDetailedSheet(
  workbook: ExcelJS.Workbook,
  monthKey: string,
  candidates: DeductionsCandidateWithDecision[],
  orgByCompactHrId: ReadonlyMap<string, EmployeeOrgInfo>,
): void {
  const ordered = [...candidates].sort((left, right) => {
    const byName = String(left.employeeName ?? "").localeCompare(String(right.employeeName ?? ""));
    if (byName !== 0) return byName;
    const byCategory =
      DEDUCTIONS_CATEGORY_CONFIG[left.category].sortOrder - DEDUCTIONS_CATEGORY_CONFIG[right.category].sortOrder;
    if (byCategory !== 0) return byCategory;
    return String(left.createdAt).localeCompare(String(right.createdAt));
  });

  const totalAmount = round2(
    ordered.reduce(
      (sum, candidate) =>
        isEligibleForPublish(candidate) ? sum + (resolvePublishedAppliedAmount(candidate) ?? 0) : sum,
      0,
    ),
  );

  const totals: CellValue[] = new Array(DETAIL_COLUMNS.length).fill(null);
  totals[0] = "TOTAL";
  const appliedAmountColumnIndex = DETAIL_COLUMNS.findIndex((column) => column.label === "Applied Amount");
  totals[appliedAmountColumnIndex] = totalAmount;

  const employeeCount = new Set(ordered.map((candidate) => candidate.employeeHrIdCompact)).size;
  const sheet = workbook.addWorksheet(sanitizeSheetName("Detailed"), { properties: { defaultColWidth: 14 } });
  writeTable(sheet, 1, {
    columns: DETAIL_COLUMNS,
    rows: ordered.map((candidate) => detailRow(candidate, orgByCompactHrId)),
    title: `All Deductions — ${monthKey}`,
    totals,
    note: `${ordered.length} candidate(s), ${employeeCount} employee(s), every category. Amounts in EGP.`,
  });
}

/**
 * Builds the master monthly deductions workbook: Cover + Summary + Detailed.
 * `orgByCompactHrId` maps the candidate's `employeeHrIdCompact` to that
 * employee's line and direct manager (resolved by the caller from the employee
 * directory, leavers included); a missing entry simply renders blank.
 */
export function buildDeductionsMasterWorkbook(input: {
  meta: DeductionsMasterMeta;
  candidates: DeductionsCandidateWithDecision[];
  orgByCompactHrId: ReadonlyMap<string, EmployeeOrgInfo>;
}): ExcelJS.Workbook {
  const { meta, candidates, orgByCompactHrId } = input;

  const employees = buildEmployeeSummaries(candidates, meta.monthKey, orgByCompactHrId);
  const grandTotal = round2(employees.reduce((sum, employee) => sum + employee.summary.willPublishTotal, 0));
  const pendingTotal = round2(employees.reduce((sum, employee) => sum + employee.summary.pendingTotal, 0));
  const employeeCount = new Set(candidates.map((candidate) => candidate.employeeHrIdCompact)).size;

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  buildCoverSheet(workbook, {
    title: "Deductions — Master (All Categories)",
    subtitle: `Every deduction category for ${meta.monthKey}: a per-employee summary and a full detail sheet.`,
    confidentialNote:
      "Contains individual payroll deduction data. Internal HR/Finance use only — do not forward outside the organization.",
    rows: [
      ["Month", meta.monthKey],
      ["Generated (UTC)", meta.generatedAtIso],
      ["Exported by", `${meta.generatedByName} (${meta.generatedByHrId})`],
      ["Candidates in this export", String(candidates.length)],
      ["Employees affected", String(employeeCount)],
      ["Employees with a deduction", String(employees.length)],
      ["Total to be deducted (applied)", `${grandTotal.toFixed(2)} EGP`],
      ["Total pending (awaiting approval)", `${pendingTotal.toFixed(2)} EGP`],
    ],
  });

  buildSummarySheet(workbook, meta.monthKey, employees);
  buildDetailedSheet(workbook, meta.monthKey, candidates, orgByCompactHrId);

  return workbook;
}
