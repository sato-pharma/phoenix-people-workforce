// Unified Deductions module: the MASTER monthly export.
//
// One workbook for the whole month, every category together — beside the
// per-category export, not replacing it. Three sheets:
//   Cover      — provenance (who, when, totals).
//   Summary    — one row per employee, the amount that WILL ACTUALLY be
//                deducted (the eligible/approved total publish commits), with a
//                separate Pending column for what is still awaiting a decision.
//   Detailed   — every candidate, all categories, one row each, with three
//                extra columns the per-category sheet does not carry: Line,
//                Region and Direct Manager.
//
// The workbook can be narrowed to one line and/or one region (see org-filter.ts).
// A narrowed workbook says so on its Cover, in every sheet title and in its own
// filename — a filtered total is otherwise indistinguishable from the month's
// company total, and that is not a mistake anyone catches by reading a number.
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
import {
  describeDeductionsOrgFilter,
  EMPTY_DEDUCTIONS_ORG_FILTER,
  normalizeOrgLabel,
  type DeductionsOrgFilter,
  type DeductionsOrgInfo,
} from "../org-filter.ts";
import { summarizeEmployeeMonthCandidates, type EmployeeMonthDeductionSummary } from "../service.ts";
import { deductionsCategories, type DeductionsCandidateWithDecision, type DeductionsCategory } from "../types.ts";

/** The per-employee org enrichment the Detailed sheet's extra columns need.
 *  Shared with the filter module so the columns and the narrowing can never
 *  read two different answers for the same employee. */
export type EmployeeOrgInfo = DeductionsOrgInfo;

export type DeductionsMasterMeta = {
  monthKey: string;
  generatedAtIso: string;
  generatedByName: string;
  generatedByHrId: string;
  /** Optional Line/Region narrowing. Omitted means the whole company. */
  filter?: DeductionsOrgFilter;
};

/** " — Line: CNS · Region: Delta (2)", or "" when nothing is filtered. */
function filterSuffix(filter: DeductionsOrgFilter): string {
  const description = describeDeductionsOrgFilter(filter);
  return description ? ` — ${description}` : "";
}

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
  regionName: string;
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
      // Printed through the same normalizer the filter groups by, so a person
      // the directory has no line for reads "Unassigned" on the sheet and sits
      // in the "Unassigned" bucket of the dropdown — one word, one meaning.
      lineName: normalizeOrgLabel(org?.lineName),
      regionName: normalizeOrgLabel(org?.regionName),
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
  filter: DeductionsOrgFilter,
): void {
  // Only render a category column if at least one employee has a real (eligible)
  // deduction in it — an all-zero column is noise on a summary.
  const activeCategories = CATEGORIES_IN_ORDER.filter((category) =>
    employees.some((employee) => (employee.summary.willPublish[category]?.amount ?? 0) > 0),
  );

  // Identity columns, then one column per active category. Kept as its own
  // array so the totals row below indexes off `leadColumns.length` rather than a
  // hardcoded 4 — adding Region beside Line silently shifted every category
  // total one column left when that number was written by hand.
  const leadColumns: TableColumn[] = [
    { label: "HR ID", width: 12 },
    { label: "Employee Name", width: 30 },
    { label: "Line", width: 16 },
    { label: "Region", width: 16 },
    { label: "Direct Manager", width: 24 },
  ];

  const columns: TableColumn[] = [
    ...leadColumns,
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
    employee.regionName,
    employee.managerName,
    ...activeCategories.map((category) => money(employee.summary.willPublish[category]?.amount ?? 0)),
    money(employee.summary.willPublishTotal),
    money(employee.summary.pendingTotal),
  ]);

  const totals: CellValue[] = new Array(columns.length).fill(null);
  totals[0] = "TOTAL";
  activeCategories.forEach((category, index) => {
    totals[leadColumns.length + index] = round2(
      employees.reduce((sum, employee) => sum + (employee.summary.willPublish[category]?.amount ?? 0), 0),
    );
  });
  totals[columns.length - 2] = round2(employees.reduce((sum, employee) => sum + employee.summary.willPublishTotal, 0));
  totals[columns.length - 1] = round2(employees.reduce((sum, employee) => sum + employee.summary.pendingTotal, 0));

  const description = describeDeductionsOrgFilter(filter);
  const sheet = workbook.addWorksheet(sanitizeSheetName("Summary"), { properties: { defaultColWidth: 14 } });
  writeTable(sheet, 1, {
    columns,
    rows,
    title: `Deductions Summary — ${monthKey}${filterSuffix(filter)}`,
    totals,
    note:
      `${employees.length} employee(s) with a deduction this month` +
      (description ? ` in ${description}` : "") +
      ". Final Deduction is what publishing takes; Pending is detected but not yet approved. Amounts in EGP." +
      (description ? " This is a FILTERED extract — these totals are not the company's totals for the month." : ""),
  });
}

const DETAIL_COLUMNS: TableColumn[] = [
  { label: "Category", width: 16 },
  { label: "HR ID", width: 12 },
  { label: "Employee Name", width: 30 },
  { label: "Line", width: 16 },
  { label: "Region", width: 16 },
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
    normalizeOrgLabel(org?.lineName),
    normalizeOrgLabel(org?.regionName),
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
  filter: DeductionsOrgFilter,
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
  const description = describeDeductionsOrgFilter(filter);
  const sheet = workbook.addWorksheet(sanitizeSheetName("Detailed"), { properties: { defaultColWidth: 14 } });
  writeTable(sheet, 1, {
    columns: DETAIL_COLUMNS,
    rows: ordered.map((candidate) => detailRow(candidate, orgByCompactHrId)),
    title: `All Deductions — ${monthKey}${filterSuffix(filter)}`,
    totals,
    note:
      `${ordered.length} candidate(s), ${employeeCount} employee(s), every category. Amounts in EGP.` +
      (description ? ` Filtered to ${description} — not the whole company.` : ""),
  });
}

/**
 * Builds the master monthly deductions workbook: Cover + Summary + Detailed.
 * `orgByCompactHrId` maps the candidate's `employeeHrIdCompact` to that
 * employee's line, region and direct manager (resolved by the caller from the
 * employee directory, leavers included); a missing entry renders "Unassigned"
 * for line and region, and a blank manager.
 *
 * `meta.filter` only LABELS the workbook. The caller narrows `candidates`
 * itself (filterCandidatesByOrg) before handing them over — one function does
 * the selecting, so a workbook can never be labelled with a filter it did not
 * actually apply.
 */
export function buildDeductionsMasterWorkbook(input: {
  meta: DeductionsMasterMeta;
  candidates: DeductionsCandidateWithDecision[];
  orgByCompactHrId: ReadonlyMap<string, EmployeeOrgInfo>;
}): ExcelJS.Workbook {
  const { meta, candidates, orgByCompactHrId } = input;
  const filter = meta.filter ?? EMPTY_DEDUCTIONS_ORG_FILTER;
  const filterDescription = describeDeductionsOrgFilter(filter);

  const employees = buildEmployeeSummaries(candidates, meta.monthKey, orgByCompactHrId);
  const grandTotal = round2(employees.reduce((sum, employee) => sum + employee.summary.willPublishTotal, 0));
  const pendingTotal = round2(employees.reduce((sum, employee) => sum + employee.summary.pendingTotal, 0));
  const employeeCount = new Set(candidates.map((candidate) => candidate.employeeHrIdCompact)).size;

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  buildCoverSheet(workbook, {
    title: `Deductions — Master (All Categories)${filterDescription ? " — Filtered" : ""}`,
    subtitle: filterDescription
      ? `Every deduction category for ${meta.monthKey}, narrowed to ${filterDescription}. A FILTERED extract — the totals below are for this selection only, not for the company.`
      : `Every deduction category for ${meta.monthKey}: a per-employee summary and a full detail sheet.`,
    confidentialNote:
      "Contains individual payroll deduction data. Internal HR/Finance use only — do not forward outside the organization.",
    rows: [
      ["Month", meta.monthKey],
      // Both axes are printed even when unset, so "Line: All" is a stated fact
      // on the cover rather than something the reader has to infer from the
      // absence of a row.
      ["Line filter", filter.line ?? "All lines"],
      ["Region filter", filter.region ?? "All regions"],
      ["Scope", filterDescription ? "FILTERED EXTRACT — not the whole company" : "Whole company"],
      ["Generated (UTC)", meta.generatedAtIso],
      ["Exported by", `${meta.generatedByName} (${meta.generatedByHrId})`],
      ["Candidates in this export", String(candidates.length)],
      ["Employees affected", String(employeeCount)],
      ["Employees with a deduction", String(employees.length)],
      ["Total to be deducted (applied)", `${grandTotal.toFixed(2)} EGP`],
      ["Total pending (awaiting approval)", `${pendingTotal.toFixed(2)} EGP`],
    ],
  });

  buildSummarySheet(workbook, meta.monthKey, employees, filter);
  buildDetailedSheet(workbook, meta.monthKey, candidates, orgByCompactHrId, filter);

  return workbook;
}
