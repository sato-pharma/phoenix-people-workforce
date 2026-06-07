import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeMonthKey } from "../candidate-key.ts";
import { insertDeductionCandidateDrafts } from "../service.ts";
import type { DeductionCandidateDraft } from "../types.ts";

export type VacationDeductionSyncResult = {
  sourceTotal: number;
  created: number;
  skippedExisting: number;
  warnings: string[];
};

type VacationDeductionRow = {
  employee_hr_id: string | null;
  employee_name: string | null;
  end_date: string | null;
  id: string;
  manager_hr_id: string | null;
  manager_of_manager_hr_id: string | null;
  payment_status: string | null;
  start_date: string | null;
  status: string | null;
  unpaid_duration_days: number | string | null;
  unpaid_reason: string | null;
  vacation_type: string | null;
};

function monthRange(monthKeyInput: string) {
  const monthKey = normalizeMonthKey(monthKeyInput);
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    end,
    month,
    monthKey,
    start: `${yearStr}-${monthStr}-01`,
    year,
  };
}

function unpaidDays(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

export async function syncVacationWithoutBalanceDeductionCandidates(input: {
  createdBy: string;
  monthKey: string;
}): Promise<VacationDeductionSyncResult> {
  if (!input.createdBy.trim()) {
    throw new Error("syncVacationWithoutBalanceDeductionCandidates requires createdBy");
  }
  const range = monthRange(input.monthKey);
  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("id,employee_hr_id,employee_name,start_date,end_date,status,payment_status,unpaid_duration_days,unpaid_reason,vacation_type,manager_hr_id,manager_of_manager_hr_id")
    .eq("status", "approved")
    .gt("unpaid_duration_days", 0)
    .lte("start_date", range.end)
    .gte("end_date", range.start);
  if (error) throw error;

  const drafts: DeductionCandidateDraft[] = [];
  for (const row of (data ?? []) as VacationDeductionRow[]) {
    const days = unpaidDays(row.unpaid_duration_days);
    if (days <= 0 || !row.employee_hr_id) continue;
    const startDate = row.start_date?.slice(0, 10) ?? range.start;
    const endDate = row.end_date?.slice(0, 10) ?? startDate;
    drafts.push({
      sourceModule: "VACATION",
      sourceRecordId: `vacation:${row.id}:unpaid`,
      employeeCode: row.employee_hr_id,
      employeeName: row.employee_name,
      monthKey: range.monthKey,
      month: range.month,
      year: range.year,
      deductionType: "leave_without_balance",
      deductionUnit: "days",
      deductionValue: days,
      estimatedAmount: null,
      calculationStatus: "requires_payroll_review",
      severity: "Medium",
      reason: "Approved vacation includes unpaid days because balance was insufficient",
      evidence: {
        paymentStatus: row.payment_status,
        requestId: row.id,
        status: row.status,
        unpaidReason: row.unpaid_reason,
        vacationType: row.vacation_type,
      },
      dates: [startDate, endDate].filter((value, index, array) => value && array.indexOf(value) === index),
      hierarchySnapshot: {
        managerHrId: row.manager_hr_id,
        managerOfManagerHrId: row.manager_of_manager_hr_id,
      },
    });
  }

  const inserted = await insertDeductionCandidateDrafts({
    createdBy: input.createdBy,
    drafts,
    sourceLabel: "Vacation without balance",
  });
  return {
    sourceTotal: drafts.length,
    created: inserted.created,
    skippedExisting: inserted.skippedExisting,
    warnings: inserted.warnings,
  };
}

export const __vacationDeductionConnectorTestables = {
  monthRange,
  unpaidDays,
};
