import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionHrId } from "@/lib/deductions-governance/service";

export type EmployeeAttendanceSummary = {
  absentDays: number;
  completeDays: number;
  deductionDays: number;
  exceptionDays: number;
  lateDays: number;
  shortDays: number;
  totalRows: number;
};

export type EmployeeAttendanceData = {
  dateFrom: string;
  dateTo: string;
  pendingDisputes: number;
  rows: Array<{
    date: string;
    deductionConfirmed: boolean;
    deductionDays: string;
    firstPunch: string;
    hasException: boolean;
    lastPunch: string;
    lateMinutes: string;
    rawDate: string;
    recommendedAction: string;
    status: string;
    timeLong: string;
  }>;
  summary: EmployeeAttendanceSummary;
};

async function getHrConfirmedDeductionDates(hrId: string): Promise<Set<string>> {
  const compactHrId = compactDeductionHrId(hrId);
  if (!compactHrId) return new Set();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deduction_candidates")
    .select("dates, deduction_decisions!inner(decision_status)")
    .eq("source_module", "ATTENDANCE_DEVICE")
    .eq("employee_hr_id_compact", compactHrId)
    .is("superseded_at", null)
    .eq("deduction_decisions.decision_status", "Approved for Payroll");

  if (error || !data) return new Set();

  const confirmed = new Set<string>();
  for (const row of data) {
    const dates = Array.isArray(row.dates) ? row.dates : [];
    for (const d of dates) {
      if (typeof d === "string") confirmed.add(d);
    }
  }
  return confirmed;
}

export async function getEmployeeAttendanceData(
  hrId: string,
  dateFrom: string,
  dateTo: string,
): Promise<EmployeeAttendanceData> {
  const [reportData, disputesData, confirmedDates] = await Promise.all([
    getFingerprintAttendanceReport({ dateFrom, dateTo, exactEmployeeHrId: hrId }),
    getAttendanceExceptions({ dateFrom, dateTo, employeeHrId: hrId, status: "pending" }),
    getHrConfirmedDeductionDates(hrId),
  ]);

  const summary: EmployeeAttendanceSummary = {
    absentDays: 0,
    completeDays: 0,
    deductionDays: 0,
    exceptionDays: 0,
    lateDays: 0,
    shortDays: 0,
    totalRows: reportData.rows.length,
  };

  const rows = reportData.rows.map((row) => {
    const s = row.status;
    if (s === "Complete") summary.completeDays++;
    else if (s === "Late" || s === "Early leave") summary.lateDays++;
    else if (s === "Short day") summary.shortDays++;
    else if (s === "Absence" || s === "Single punch") summary.absentDays++;
    if (s === "Exception") summary.exceptionDays++;

    const dd = parseFloat(row.deductionDays);
    const rawDate = row.sortKey.slice(0, 10);
    const deductionConfirmed = dd > 0 && confirmedDates.has(rawDate);
    if (deductionConfirmed) summary.deductionDays++;

    return {
      date: row.date,
      deductionConfirmed,
      deductionDays: row.deductionDays,
      firstPunch: row.actualFirstPunch,
      hasException: row.hasException ?? false,
      lastPunch: row.actualLastPunch,
      lateMinutes: row.lateMinutes,
      rawDate,
      recommendedAction: row.recommendedAction,
      status: row.status,
      timeLong: row.timeLong,
    };
  });

  return {
    dateFrom,
    dateTo,
    pendingDisputes: disputesData.length,
    rows,
    summary,
  };
}
