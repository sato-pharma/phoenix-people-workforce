import { randomUUID } from "node:crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import {
  DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_DISABLED_MESSAGE,
  DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED,
} from "@/lib/deductions-governance/feature-flags";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  assertDeductionsGovernanceDecisionActor,
  payrollColumnLabel,
} from "./calculations.ts";
import {
  listMonthlyDeductionSummaries,
  listMonthlyDeductionSummaryLines,
} from "./service.ts";
import type {
  DeductionMonthlySummary,
  DeductionMonthlySummaryLine,
} from "./types.ts";

const allowedImportBatchStatuses = new Set([
  "part1_paid",
  "adjustments_open",
  "part2_ready",
  "under_review",
  "rejected",
]);

type PayrollBatchRow = {
  id: string;
  month: number;
  status: string;
  year: number;
};

type PayrollRecordRow = {
  base_salary: number | string | null;
  crm: number | string | null;
  employee_code: string | null;
  finger_print: number | string | null;
  full_name: string | null;
  hr_id: string | null;
  id: string;
  month_salary: number | string | null;
  second_part: number | string | null;
  total_deductions: number | string | null;
  unpaid_vacations: number | string | null;
};

export type DeductionsPayrollPreviewRow = {
  appliedTotals: {
    crm: number;
    fingerPrint: number;
    unpaidVacations: number;
  };
  // Amount ADDED to this employee's payroll deductions (governance import is add-on-top).
  delta: number;
  employeeCode: string;
  employeeName: string | null;
  existingTotals: {
    crm: number;
    fingerPrint: number;
    unpaidVacations: number;
  };
  // True when this employee's salary_records row already carries a non-zero CRM/Fingerprint/
  // Unpaid-Vacation total BEFORE this import. The RPC that runs this import blocks re-running
  // the SAME finalized summary twice, but it cannot see whether a DIFFERENT path (e.g. Automated
  // Payroll's own live pull of the same deduction_candidates/decisions data) already baked an
  // equivalent amount into this row — since import is strictly add-on-top, that would double the
  // deduction. A true value here blocks the import (see canImport) until a human confirms it's
  // not the same money counted twice.
  hasExistingGovernanceAmount: boolean;
  matched: boolean;
  payrollRecordId: string | null;
  // Resulting payroll values after import = existing + applied (add-on-top).
  resultingTotals: {
    crm: number;
    fingerPrint: number;
    unpaidVacations: number;
  };
};

export type DeductionsPayrollPreview = {
  batch: {
    id: string;
    month: number;
    status: string;
    year: number;
  } | null;
  blockers: string[];
  canImport: boolean;
  employeesWithExistingGovernance: DeductionsPayrollPreviewRow[];
  rows: DeductionsPayrollPreviewRow[];
  summary: DeductionMonthlySummary;
  totals: {
    crm: number;
    fingerPrint: number;
    total: number;
    unpaidVacations: number;
  };
  unmatchedEmployees: DeductionsPayrollPreviewRow[];
};

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizedHrId(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed || null;
}

function summarizeLines(lines: DeductionMonthlySummaryLine[]) {
  const byEmployee = new Map<string, {
    crm: number;
    employeeCode: string;
    employeeName: string | null;
    fingerPrint: number;
    unpaidVacations: number;
  }>();
  for (const line of lines) {
    const key = normalizedHrId(line.employeeCode);
    if (!key) continue;
    const bucket = byEmployee.get(key) ?? {
      crm: 0,
      employeeCode: line.employeeCode,
      employeeName: line.employeeName,
      fingerPrint: 0,
      unpaidVacations: 0,
    };
    if (line.payrollColumn === "crm") bucket.crm += line.appliedAmount;
    if (line.payrollColumn === "finger_print") bucket.fingerPrint += line.appliedAmount;
    if (line.payrollColumn === "unpaid_vacations") bucket.unpaidVacations += line.appliedAmount;
    byEmployee.set(key, bucket);
  }
  return byEmployee;
}

export function buildDeductionsPayrollPreview(input: {
  batch: PayrollBatchRow | null;
  lines: DeductionMonthlySummaryLine[];
  payrollRecords: PayrollRecordRow[];
  summary: DeductionMonthlySummary;
}): DeductionsPayrollPreview {
  const blockers: string[] = [];
  if (!input.batch) {
    blockers.push(`No payroll batch exists for ${input.summary.monthKey}.`);
  } else if (!allowedImportBatchStatuses.has(input.batch.status)) {
    blockers.push(`Payroll batch status ${input.batch.status} is not open for deductions import.`);
  }

  const recordByHrId = new Map<string, PayrollRecordRow>();
  for (const record of input.payrollRecords) {
    const key = normalizedHrId(record.hr_id) ?? normalizedHrId(record.employee_code);
    if (key) recordByHrId.set(key, record);
  }

  const rows: DeductionsPayrollPreviewRow[] = [];
  let totalCrm = 0;
  let totalFingerPrint = 0;
  let totalUnpaidVacations = 0;
  const totalsByEmployee = summarizeLines(input.lines);
  for (const [key, totals] of totalsByEmployee) {
    const record = recordByHrId.get(key) ?? null;
    const existingGovernance =
      money(record?.crm) +
      money(record?.finger_print) +
      money(record?.unpaid_vacations);
    const appliedGovernance =
      money(totals.crm) +
      money(totals.fingerPrint) +
      money(totals.unpaidVacations);
    totalCrm += money(totals.crm);
    totalFingerPrint += money(totals.fingerPrint);
    totalUnpaidVacations += money(totals.unpaidVacations);
    rows.push({
      appliedTotals: {
        crm: money(totals.crm),
        fingerPrint: money(totals.fingerPrint),
        unpaidVacations: money(totals.unpaidVacations),
      },
      // Add-on-top: the delta applied to payroll is the governance amount itself.
      delta: Math.round(appliedGovernance * 100) / 100,
      employeeCode: totals.employeeCode,
      employeeName: totals.employeeName ?? record?.full_name ?? null,
      existingTotals: {
        crm: money(record?.crm),
        fingerPrint: money(record?.finger_print),
        unpaidVacations: money(record?.unpaid_vacations),
      },
      hasExistingGovernanceAmount: existingGovernance > 0,
      matched: Boolean(record),
      payrollRecordId: record?.id ?? null,
      resultingTotals: {
        crm: money(money(record?.crm) + money(totals.crm)),
        fingerPrint: money(money(record?.finger_print) + money(totals.fingerPrint)),
        unpaidVacations: money(money(record?.unpaid_vacations) + money(totals.unpaidVacations)),
      },
    });
  }
  rows.sort((left, right) =>
    (left.employeeName ?? left.employeeCode).localeCompare(right.employeeName ?? right.employeeCode),
  );
  const unmatchedEmployees = rows.filter((row) => !row.matched);
  if (unmatchedEmployees.length > 0) {
    blockers.push(`${unmatchedEmployees.length} deduction employee(s) are not matched in the payroll batch.`);
  }
  // Import is strictly add-on-top (see resultingTotals above), and the RPC only guards against
  // the SAME finalized summary being imported twice. It cannot see a DIFFERENT path -- most
  // notably Automated Payroll's own live pull of this same deduction_candidates/decisions data
  // -- having already applied an equivalent amount to this row. Surface it as a hard blocker
  // (same mechanism as unmatchedEmployees) rather than silently doubling the deduction; a human
  // has to confirm the pre-existing amount isn't this same money before import can proceed.
  const employeesWithExistingGovernance = rows.filter((row) => row.hasExistingGovernanceAmount);
  if (employeesWithExistingGovernance.length > 0) {
    blockers.push(
      `${employeesWithExistingGovernance.length} deduction employee(s) already have a non-zero CRM/Fingerprint/Unpaid-Vacation total in this payroll batch. This import adds on top of whatever is already there, so a pre-existing amount usually means it was already applied by another path (e.g. Automated Payroll) or a previous import -- verify manually before importing, or this would double the deduction.`,
    );
  }

  return {
    batch: input.batch
      ? {
          id: input.batch.id,
          month: input.batch.month,
          status: input.batch.status,
          year: input.batch.year,
        }
      : null,
    blockers,
    canImport: blockers.length === 0,
    employeesWithExistingGovernance,
    rows,
    summary: input.summary,
    totals: {
      crm: money(totalCrm),
      fingerPrint: money(totalFingerPrint),
      total: money(totalCrm + totalFingerPrint + totalUnpaidVacations),
      unpaidVacations: money(totalUnpaidVacations),
    },
    unmatchedEmployees,
  };
}

async function loadPayrollBatchForSummary(summary: DeductionMonthlySummary) {
  const { data, error } = await getSupabaseAdmin()
    .from("salary_batches")
    .select("id,month,year,status")
    .eq("month", summary.month)
    .eq("year", summary.year)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? data[0] as PayrollBatchRow : null;
}

async function loadPayrollRecords(batchId: string | null) {
  if (!batchId) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("salary_records")
    .select("id,hr_id,employee_code,full_name,base_salary,crm,finger_print,unpaid_vacations,total_deductions,second_part,month_salary")
    .eq("batch_id", batchId);
  if (error) throw error;
  return (data ?? []) as PayrollRecordRow[];
}

async function loadSummaryAndLines(input: {
  access: AccessContext;
  summaryId?: string;
  monthKey?: string;
}) {
  const summaries = await listMonthlyDeductionSummaries({
    access: input.access,
    limit: 1,
    monthKey: input.monthKey,
  });
  const summary = input.summaryId
    ? (await listMonthlyDeductionSummaries({ access: input.access, limit: 100 }))
        .find((item) => item.id === input.summaryId) ?? null
    : summaries[0] ?? null;
  if (!summary) throw new Error("No finalized deductions summary was found for this request.");
  const lines = await listMonthlyDeductionSummaryLines({
    access: input.access,
    summaryId: summary.id,
  });
  return { lines, summary };
}

export async function previewDeductionsPayrollImport(input: {
  access: AccessContext;
  monthKey?: string;
  summaryId?: string;
}): Promise<DeductionsPayrollPreview> {
  // Closed for the Deductions-module cutover. Gated here as well as in confirm
  // (which calls this) so neither entry point can be reopened on its own.
  if (!DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED) {
    throw new Error(DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_DISABLED_MESSAGE);
  }
  assertDeductionsGovernanceDecisionActor(input.access);
  const { lines, summary } = await loadSummaryAndLines(input);
  const batch = await loadPayrollBatchForSummary(summary);
  const payrollRecords = await loadPayrollRecords(batch?.id ?? null);
  const preview = buildDeductionsPayrollPreview({
    batch,
    lines,
    payrollRecords,
    summary,
  });
  await writeAuditLog({
    actorLoginId: input.access.loginId ?? input.access.hrId ?? "system",
    entityId: summary.id,
    entityType: "deduction_payroll_preview",
    newValues: {
      blockers: preview.blockers,
      mappedColumns: ["CRM", "Finger Print", "Unpaid Vacations"].map(String),
      rowCount: preview.rows.length,
    },
    summary: `Deductions payroll import preview opened for ${summary.monthKey}.`,
  });
  return preview;
}

export async function confirmDeductionsPayrollImport(input: {
  access: AccessContext;
  monthKey?: string;
  summaryId?: string;
}) {
  // This is the one that actually writes salary_records. Gated explicitly rather
  // than relying on the preview call below, so removing that call could never
  // silently reopen the write path.
  if (!DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED) {
    throw new Error(DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_DISABLED_MESSAGE);
  }
  const preview = await previewDeductionsPayrollImport(input);
  if (!preview.canImport) {
    throw new Error(preview.blockers.join(" "));
  }
  const actor = input.access.loginId ?? input.access.hrId ?? "system";
  const importJobId = randomUUID();
  const { data, error } = await getSupabaseAdmin().rpc(
    "phx_import_deductions_governance_to_payroll",
    {
      p_actor_login_id: actor,
      p_import_job_id: importJobId,
      p_summary_id: preview.summary.id,
    },
  );
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: actor,
    entityId: preview.summary.id,
    entityType: "deduction_payroll_import",
    newValues: {
      columns: [
        payrollColumnLabel("crm"),
        payrollColumnLabel("finger_print"),
        payrollColumnLabel("unpaid_vacations"),
      ],
      importJobId,
      result: data,
    },
    summary: `Deductions imported to payroll for ${preview.summary.monthKey}.`,
  });
  invalidateExecutiveDashboardCache("deductions imported to payroll", ["payroll"]);
  return {
    importJobId,
    preview,
    result: data,
  };
}
