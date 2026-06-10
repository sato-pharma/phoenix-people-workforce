import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";

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

export async function getEmployeeAttendanceData(
  hrId: string,
  dateFrom: string,
  dateTo: string,
): Promise<EmployeeAttendanceData> {
  const [reportData, disputesData] = await Promise.all([
    getFingerprintAttendanceReport({ dateFrom, dateTo, employeeHrId: hrId }),
    getAttendanceExceptions({ dateFrom, dateTo, employeeHrId: hrId, status: "pending" }),
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
    if (dd > 0) summary.deductionDays++;

    return {
      date: row.date,
      deductionDays: row.deductionDays,
      firstPunch: row.actualFirstPunch,
      hasException: row.hasException ?? false,
      lastPunch: row.actualLastPunch,
      lateMinutes: row.lateMinutes,
      rawDate: row.sortKey.slice(0, 10),
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
