import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { normalizeMonthKey } from "../candidate-key.ts";
import { insertDeductionCandidateDrafts } from "../service.ts";
import type { DeductionCandidateDraft, DeductionType } from "../types.ts";

export type AttendanceDeviceSyncResult = {
  sourceTotal: number;
  created: number;
  skippedExisting: number;
  warnings: string[];
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

function deductionTypeForStatus(status: string): DeductionType {
  const normalized = status.trim().toLowerCase();
  if (normalized.includes("single")) return "missing_punch";
  if (normalized.includes("early") || normalized.includes("short")) return "early_leave";
  return "late_arrival";
}

function parseAmount(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

export async function syncAttendanceDeviceDeductionCandidates(input: {
  createdBy: string;
  monthKey: string;
}): Promise<AttendanceDeviceSyncResult> {
  if (!input.createdBy.trim()) {
    throw new Error("syncAttendanceDeviceDeductionCandidates requires createdBy");
  }
  const range = monthRange(input.monthKey);
  const report = await getFingerprintAttendanceReport({
    dateFrom: range.start,
    dateTo: range.end,
  });

  const drafts: DeductionCandidateDraft[] = [];
  for (const row of report.rows) {
    const deductionDays = Number(row.deductionDays);
    if (!Number.isFinite(deductionDays) || deductionDays <= 0) continue;
    const [dateIso] = row.sortKey.split("\u0000");
    if (!dateIso) continue;
    drafts.push({
      sourceModule: "ATTENDANCE_DEVICE",
      sourceRecordId: `fingerprint:${dateIso}:${row.employeeHrId}:${row.status}`,
      employeeCode: row.employeeHrId,
      employeeName: row.employeeName,
      monthKey: range.monthKey,
      month: range.month,
      year: range.year,
      deductionType: deductionTypeForStatus(row.status),
      deductionUnit: "days",
      deductionValue: Math.round(deductionDays * 100) / 100,
      estimatedAmount: parseAmount(row.deductionValue),
      calculationStatus: parseAmount(row.deductionValue) == null ? "requires_payroll_review" : "calculated",
      severity: "Medium",
      reason: "Fingerprint attendance policy deduction",
      evidence: {
        actualFirstPunch: row.actualFirstPunch,
        actualLastPunch: row.actualLastPunch,
        earlyLeaveMinutes: row.earlyLeaveMinutes,
        graceMinutes: row.graceMinutes,
        jobTitle: row.jobTitle,
        lateMinutes: row.lateMinutes,
        recommendedAction: row.recommendedAction,
        scheduledEnd: row.scheduledEnd,
        scheduledStart: row.scheduledStart,
        status: row.status,
      },
      dates: [dateIso],
      hierarchySnapshot: {
        department: row.department,
        jobTitle: row.jobTitle,
      },
    });
  }

  const inserted = await insertDeductionCandidateDrafts({
    createdBy: input.createdBy,
    drafts,
    sourceLabel: "Fingerprint attendance",
  });
  return {
    sourceTotal: drafts.length,
    created: inserted.created,
    skippedExisting: inserted.skippedExisting,
    warnings: inserted.warnings,
  };
}

export const __attendanceDeviceConnectorTestables = {
  deductionTypeForStatus,
  monthRange,
  parseAmount,
};
