import { getFingerprintAttendanceReport, type FingerprintReportRow } from "@/lib/attendance/fingerprint-report";
import { isAttendanceTrackingEligible } from "@/lib/attendance/eligibility";
import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { getApprovedExcuseDayMap } from "@/lib/attendance/approved-excuse-days";
import { getCrmActivityDayMaps } from "@/lib/attendance/crm-day-maps";
import { reconcileDay } from "@/lib/attendance/digest-reconcile";
import { normalizeMonthKey } from "../candidate-key.ts";
import { insertDeductionCandidateDrafts } from "../service.ts";
import type { DeductionCandidateDraft, DeductionType } from "../types.ts";

/**
 * Whether a fingerprint report row may generate an attendance deduction.
 *
 * The fingerprint report now surfaces office/HQ staff (anyone enrolled on a
 * device) so they can see their own punch history. Deductions, however, stay
 * scoped to FIELD ROLES ONLY (Medical Rep / DM / RSM) — office/HQ staff are NOT
 * auto-deducted (owner decision, 2026-06-20). Filtering here keeps deduction
 * behaviour identical to before the report was widened.
 */
function isDeductionEligibleRow(row: { jobTitle: string }): boolean {
  return isAttendanceTrackingEligible(row.jobTitle);
}

/**
 * Whether a candidate day is a universal cancel per reconcileDay's precedence
 * (digest-reconcile.ts) — an approved full-day leave/excuse, or a CRM-recorded
 * leave/field-visit that day. Confirmed 2026-07-24: this connector's source
 * report (fingerprint-report.ts) only knows about a narrow "attendance
 * exceptions" table and half-day vacations — it has no CRM awareness and no
 * awareness of full-day leave/excuse the way the weekly digest and the
 * Employee Day-by-Day Report (employee-day-report.ts) do via reconcileDay, so
 * a field rep with a real CRM-logged visit or an approved leave/excuse the
 * exception table doesn't know about could otherwise get a device deduction
 * candidate created here. tier/isWorkingDay/hasPunch/deviceOutage are fed
 * neutral values that can never themselves trigger a skip/flag here (every
 * candidate row already implies a real punch that day) — only the four real
 * signals below can, so this reuses reconcileDay's exact universal-cancel
 * precedence rather than re-deriving it.
 */
function isCandidateDayCovered(input: {
  hasApprovedLeave: boolean;
  hasApprovedExcuse: boolean;
  hasCrmLeave: boolean;
  hasCrmFieldVisit: boolean;
}): boolean {
  const decision = reconcileDay({
    deviceOutage: false,
    hasApprovedExcuse: input.hasApprovedExcuse,
    hasApprovedLeave: input.hasApprovedLeave,
    hasCrmFieldVisit: input.hasCrmFieldVisit,
    hasCrmLeave: input.hasCrmLeave,
    hasPunch: true,
    isHoliday: false,
    isWorkingDay: true,
    planSaysOffice: null,
    tier: "every_working_day",
  });
  return decision.action !== "judge";
}

export type AttendanceDeviceSyncResult = {
  sourceTotal: number;
  created: number;
  skippedExisting: number;
  /** Candidate days not drafted because isCandidateDayCovered found an approved
   * leave/excuse or a CRM-recorded leave/field-visit that day — see above. */
  skippedCovered: number;
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

  const candidateRows: Array<{ row: FingerprintReportRow; dateIso: string; deductionDays: number }> = [];
  for (const row of report.rows) {
    // Office/HQ staff appear in the report for visibility but are not
    // auto-deducted — deductions stay scoped to field roles. See above.
    if (!isDeductionEligibleRow(row)) continue;
    const deductionDays = Number(row.deductionDays);
    if (!Number.isFinite(deductionDays) || deductionDays <= 0) continue;
    const [dateIso] = row.sortKey.split("\u0000");
    if (!dateIso) continue;
    candidateRows.push({ dateIso, deductionDays, row });
  }

  const candidateHrIds = Array.from(new Set(candidateRows.map((candidate) => candidate.row.employeeHrId)));
  const emptyDayMap = new Map<string, Set<string>>();
  const [leaveDayMap, excuseDayMap, crmActivity] = candidateHrIds.length > 0
    ? await Promise.all([
        getApprovedLeaveDayMap({ dateFromIso: range.start, dateToIso: range.end, employeeHrIds: candidateHrIds }),
        getApprovedExcuseDayMap({ dateFromIso: range.start, dateToIso: range.end, employeeHrIds: candidateHrIds }),
        getCrmActivityDayMaps({ dateFromIso: range.start, dateToIso: range.end, employeeHrIds: candidateHrIds }),
      ])
    : ([emptyDayMap, emptyDayMap, { fieldVisitMap: emptyDayMap, leaveMap: emptyDayMap }] as const);

  const drafts: DeductionCandidateDraft[] = [];
  let skippedCovered = 0;
  for (const { row, dateIso, deductionDays } of candidateRows) {
    const hrId = row.employeeHrId;
    const covered = isCandidateDayCovered({
      hasApprovedExcuse: excuseDayMap.get(hrId)?.has(dateIso) ?? false,
      hasApprovedLeave: leaveDayMap.get(hrId)?.has(dateIso) ?? false,
      hasCrmFieldVisit: crmActivity.fieldVisitMap.get(hrId)?.has(dateIso) ?? false,
      hasCrmLeave: crmActivity.leaveMap.get(hrId)?.has(dateIso) ?? false,
    });
    if (covered) {
      skippedCovered += 1;
      continue;
    }
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
    sourceTotal: candidateRows.length,
    created: inserted.created,
    skippedExisting: inserted.skippedExisting,
    skippedCovered,
    warnings: inserted.warnings,
  };
}

export const __attendanceDeviceConnectorTestables = {
  deductionTypeForStatus,
  isCandidateDayCovered,
  isDeductionEligibleRow,
  monthRange,
  parseAmount,
};
