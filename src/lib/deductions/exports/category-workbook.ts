// Unified Deductions module: per-category detail export.
//
// One shared, parameterized builder rather than 7 near-identical ones — the 7
// categories share the exact same candidate shape (deductions_candidates
// joined with its decision), only the category filter and label differ.
//
// Uses the house branded workbook kit (Cover + Provenance sheet, zebra-styled
// data table) so this matches every other export in the codebase rather than
// being a bare, unbranded dump.

import ExcelJS from "exceljs";

import { buildCoverSheet, sanitizeSheetName, writeTable, type CellValue, type TableColumn } from "@/lib/export/phoenix-xlsx-style";
import { deductionsCategoryLabel, resolveAppliedDeductionDates } from "../calculations.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "../types.ts";

function money(value: number | null): CellValue {
  return value == null ? null : Math.round(value * 100) / 100;
}

function joinDates(dates: readonly string[]): string {
  return dates.length > 0 ? dates.join(", ") : "";
}

const COLUMNS: TableColumn[] = [
  { label: "HR ID", width: 12 },
  { label: "Employee Name", width: 30 },
  { label: "Hire Date", width: 12 },
  { label: "Month", width: 10 },
  { label: "Unit", width: 9 },
  { label: "Raw Value", numFmt: "#,##0.00", right: true, width: 11 },
  { label: "Estimated Amount", numFmt: "#,##0.00", right: true, width: 15 },
  { label: "Calculation Status", width: 16 },
  { label: "Severity", width: 10 },
  { label: "Reason", width: 40 },
  { label: "Dates", width: 40 },
  // Side by side with "Dates" on purpose: detected vs actually charged is the
  // comparison somebody opens this sheet to make. Without it the workbook shows
  // "Applied Value 12" against a list of 14 dates and no record of which two the
  // reviewer dropped.
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

function candidateRow(candidate: DeductionsCandidateWithDecision): CellValue[] {
  return [
    candidate.employeeHrId,
    candidate.employeeName ?? "",
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
    candidate.decision?.appliedValue == null ? null : candidate.decision.appliedValue,
    money(candidate.decision?.appliedAmount ?? null),
    candidate.decision?.decisionReason ?? "",
    candidate.decision?.hrNote ?? "",
    candidate.decision?.decidedBy ?? "",
    candidate.decision?.decidedAt ?? "",
    candidate.sourceSystem,
    candidate.sourceRecordId,
    candidate.createdAt,
  ];
}

export type CategoryWorkbookMeta = {
  category: DeductionsCategory;
  monthKey: string;
  generatedAtIso: string;
  generatedByName: string;
  generatedByHrId: string;
};

/**
 * Builds the branded, detail-level workbook for one category/month: a Cover
 * sheet (provenance — who exported it, when, how many rows, what the total is)
 * and a Data sheet with every field on the candidate + its decision, so this
 * is a complete audit record, not just a summary.
 */
export function buildDeductionsCategoryWorkbook(input: {
  meta: CategoryWorkbookMeta;
  candidates: DeductionsCandidateWithDecision[];
}): ExcelJS.Workbook {
  const { meta, candidates } = input;
  const label = deductionsCategoryLabel(meta.category);
  const totalAmount = candidates.reduce(
    (sum, candidate) => sum + (candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? 0),
    0,
  );
  const employeeCount = new Set(candidates.map((candidate) => candidate.employeeHrIdCompact)).size;

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  buildCoverSheet(workbook, {
    title: `Deductions — ${label}`,
    subtitle: `Full candidate detail for ${meta.monthKey}, one row per deduction.`,
    confidentialNote:
      "Contains individual payroll deduction data. Internal HR/Finance use only — do not forward outside the organization.",
    rows: [
      ["Category", label],
      ["Month", meta.monthKey],
      ["Generated (UTC)", meta.generatedAtIso],
      ["Exported by", `${meta.generatedByName} (${meta.generatedByHrId})`],
      ["Candidates in this export", String(candidates.length)],
      ["Employees affected", String(employeeCount)],
      ["Total estimated/applied amount", `${totalAmount.toFixed(2)} EGP`],
    ],
  });

  const sheet = workbook.addWorksheet(sanitizeSheetName(label), { properties: { defaultColWidth: 14 } });
  const totals: CellValue[] = new Array(COLUMNS.length).fill(null);
  totals[0] = "TOTAL";
  const appliedAmountColumnIndex = COLUMNS.findIndex((column) => column.label === "Applied Amount");
  totals[appliedAmountColumnIndex] = totalAmount;
  writeTable(sheet, 1, {
    columns: COLUMNS,
    rows: candidates.map(candidateRow),
    title: `${label} — ${meta.monthKey}`,
    totals,
    note: `${candidates.length} candidate(s), ${employeeCount} employee(s). Amounts in EGP.`,
  });

  return workbook;
}
