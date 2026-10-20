// HR Daily & Weekly Reports — the HEAD OFFICE section: one line per person per working day, from
// the fingerprint record, Sunday to Thursday.
//
// NOTHING HERE RE-DECIDES WHAT A DAY IS. Every judgment is the attendance module's own:
//   - who is expected     — getAttendanceRoster (device-mapped, office titles only, employment span);
//   - which policy        — resolveActiveAttendancePolicy over the active flexible-hours policies;
//   - is it a working day — classifyAttendanceDay over the holiday calendar;
//   - should it be judged — reconcileDay, the gating matrix the weekly attendance review uses
//                           (leave, excuse, CRM leave, CRM field visit, device outage, the plan);
//   - what a punched day  — the fingerprint report's own status, lateness and policy days.
// The one cover added here is the BUSINESS TRIP (loadOutstationTripDays): a person on an outstation
// trip is not missing from the office, and the weekly review's own sync reads trips the same way.
//
// DAYS ONLY. The fingerprint report prices its days; `deductionValue` is never copied — only
// `deductionDays`, as the policy's suggestion.

import { getApprovedExcuseDayMap } from "@/lib/attendance/approved-excuse-days";
import { getCrmActivityDayMaps } from "@/lib/attendance/crm-day-maps";
import { describeReconcileSkip, reconcileDay, type ReconcileSkipOutcome } from "@/lib/attendance/digest-reconcile";
import { getAttendanceExceptionMap } from "@/lib/attendance/exceptions";
import { getFingerprintAttendanceReport, type FingerprintReportRow } from "@/lib/attendance/fingerprint-report";
import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { getPlanOfficeDayDetailMap } from "@/lib/attendance/plan-office-days";
import { loadAttendanceFlexPolicyGroups, type AttendanceFlexPolicyGroupDbRow } from "@/lib/attendance/policy-groups";
import { getAttendanceRoster, isWithinEmploymentSpan } from "@/lib/attendance/roster";
import {
  buildAttendanceCalendarContext,
  classifyAttendanceDay,
  getApprovedLeaveDayMap,
  getFullDayApprovedLeaveMap,
} from "@/lib/attendance/working-days";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { describeOutstationTripDay, loadOutstationTripDays } from "@/lib/outstation/trip-work-evidence";

import { eachDay } from "./periods";
import type { HrOpsFlag, HrOpsLineDraft, HrOpsOfficeMetrics, HrOpsSectionBuild } from "./types";

/** What the skip outcome of reconcileDay means, in words for her screen. */
const SKIP_NOTES: Record<ReconcileSkipOutcome, string> = {
  approved_excuse: "Covered by an approved excuse.",
  approved_leave: "Covered by an approved leave.",
  crm_field_visit: "A real CRM field visit was recorded — a field day, not an office absence.",
  crm_leave: "Leave recorded in the CRM.",
  device_outage: "The fingerprint device was not syncing this day — not judged.",
  holiday: "Official holiday.",
  no_plan_field_day: "Not an office day in the approved plan — not judged.",
  weekly_off: "Weekly off.",
};

export type OfficeDayInput = {
  employee: { hrId: string; employeeName: string; jobTitle: string; department: string };
  dateIso: string;
  /** Null when no active policy matches the person: judged on every working day, company weekend. */
  policy: Pick<AttendanceFlexPolicyGroupDbRow, "judgment_mode" | "working_weekdays" | "policy_name" | "scheduled_start" | "scheduled_end"> | null;
  isHoliday: boolean;
  holidayName: string | null;
  isWeeklyOff: boolean;
  isFuture: boolean;
  /** False when the holiday calendar could not be read: a no-punch day is then never flagged. */
  holidayCalendarReachable: boolean;
  /** The cover sources that could not be read. A no-punch day is then never flagged. */
  unreadableCovers: string[];
  fullDayLeave: boolean;
  /** Any approved leave, half days included. */
  anyLeave: boolean;
  approvedExcuse: boolean;
  exception: { status: string; reason: string } | null;
  crmLeave: boolean;
  crmFieldVisit: boolean;
  crmDetail: string | null;
  /** The approved plan for the day. Read only for a policy judged on office days only. */
  planSaysOffice: boolean | null;
  deviceOutage: boolean;
  /** "Outstation trip to Aswan (approved)", when a business trip covers the day. */
  trip: string | null;
  punch: Pick<
    FingerprintReportRow,
    | "actualFirstPunch"
    | "actualLastPunch"
    | "scheduledStart"
    | "scheduledEnd"
    | "lateMinutes"
    | "earlyLeaveMinutes"
    | "status"
    | "deductionDays"
    | "recommendedAction"
    | "timeLong"
    | "hasException"
    | "halfDayVacationPart"
  > | null;
};

function minutes(value: string | null | undefined): number | null {
  const parsed = Number(String(value ?? "").trim());
  return String(value ?? "").trim() !== "" && Number.isFinite(parsed) ? parsed : null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** "09:00:00" → "09:00". The policy stores a time of day; the screen prints hours and minutes. */
function policyTime(value: string | null | undefined): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? "").trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

/** The policy's day count, as a number of days — `""` means it offered none. */
export function parseSuggestedDays(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The flags a JUDGED punched day carries, from the fingerprint report's own verdict. Lateness is a
 * flag in its own right even when the day also ran short, because she confirms each fact apart.
 */
export function punchFlags(punch: NonNullable<OfficeDayInput["punch"]>): HrOpsFlag[] {
  const flags: HrOpsFlag[] = [];
  const status = String(punch.status ?? "").trim();
  if (status === "Single punch") flags.push("single_punch");
  if ((minutes(punch.lateMinutes) ?? 0) > 0) flags.push("late");
  if (status === "Short day" || status === "Early leave") flags.push("early_leave");
  return flags;
}

/**
 * One person's head-office day. Pure — the loader below gathers the facts, this decides the line.
 * Returns null for a day with nothing to report: a weekly off, holiday or future day with no punch.
 */
export function judgeOfficeDay(input: OfficeDayInput): (Omit<HrOpsLineDraft, "hrKey"> & { hrKey: string | null }) | null {
  const isWorkingDay = !input.isWeeklyOff && !input.isHoliday && !input.isFuture;
  if (!input.punch && !isWorkingDay) return null;

  const notes: string[] = [];
  const punch = input.punch;
  const metrics: HrOpsOfficeMetrics = {
    earlyLeaveMinutes: punch ? minutes(punch.earlyLeaveMinutes) : null,
    firstPunch: punch ? clean(punch.actualFirstPunch) : null,
    kind: "office",
    lastPunch: punch ? clean(punch.actualLastPunch) : null,
    lateMinutes: punch ? minutes(punch.lateMinutes) : null,
    notes,
    recommendedAction: punch ? clean(punch.recommendedAction) : null,
    scheduledEnd: (punch ? clean(punch.scheduledEnd) : null) ?? policyTime(input.policy?.scheduled_end),
    scheduledStart: (punch ? clean(punch.scheduledStart) : null) ?? policyTime(input.policy?.scheduled_start),
    status: punch ? clean(punch.status) ?? "Recorded" : "No punch",
    workedTime: punch ? clean(punch.timeLong) : null,
  };
  const line = {
    areaName: null,
    employeeName: input.employee.employeeName,
    flags: [] as HrOpsFlag[],
    hrId: input.employee.hrId,
    hrKey: canonicalHrIdKey(input.employee.hrId),
    jobTitle: clean(input.employee.jobTitle),
    lineName: clean(input.employee.department),
    managerName: null,
    metrics,
    section: "office" as const,
    suggestedDays: null as number | null,
    workDate: input.dateIso,
  };

  if (!input.policy) notes.push("No attendance policy matches this person — judged on the company working week.");
  if (input.exception?.status === "pending") notes.push(`Attendance exception awaiting a decision: ${input.exception.reason}`);
  if (input.anyLeave && !input.fullDayLeave) notes.push("A half-day leave was approved for this day.");

  if (!isWorkingDay) {
    notes.push(input.isHoliday ? `Official holiday${input.holidayName ? `: ${input.holidayName}` : ""} — not judged.` : "Weekly off — not judged.");
    return line;
  }

  const tier = input.policy?.judgment_mode ?? "every_working_day";
  const approvedException = input.exception?.status === "approved" || Boolean(punch?.hasException);
  const decision = reconcileDay({
    deviceOutage: input.deviceOutage,
    hasApprovedExcuse: input.approvedExcuse,
    // A full-day leave or an approved attendance exception covers the day. A half day does not —
    // the worked half is still judged (owner, 2026-09-08: "judge the worked half").
    hasApprovedLeave: input.fullDayLeave || approvedException,
    hasCrmFieldVisit: input.crmFieldVisit,
    hasCrmLeave: input.crmLeave,
    hasPunch: Boolean(punch),
    isHoliday: false,
    isWorkingDay: true,
    planSaysOffice: tier === "office_days_only" ? input.planSaysOffice : null,
    tier,
  });

  if (decision.action === "skip") {
    const outcome = describeReconcileSkip({
      hasApprovedExcuse: input.approvedExcuse,
      hasApprovedLeave: input.fullDayLeave || approvedException,
      hasCrmFieldVisit: input.crmFieldVisit,
      hasCrmLeave: input.crmLeave,
      hasOutage: input.deviceOutage,
      isHoliday: false,
      isWeeklyOff: false,
    });
    const note = outcome === "approved_leave" && approvedException && !input.fullDayLeave
      ? `Covered by an approved attendance exception${input.exception?.reason ? `: ${input.exception.reason}` : "."}`
      : SKIP_NOTES[outcome];
    notes.push(outcome === "crm_leave" || outcome === "crm_field_visit" ? `${note}${input.crmDetail ? ` (${input.crmDetail})` : ""}` : note);
    return line;
  }

  if (decision.action === "flag" && decision.flagType === "field_punch_anomaly") {
    notes.push("A punch was recorded on a field day in the approved plan — for the manager to look at, not a deduction.");
    return line;
  }

  // The business trip — the one cover this report adds to the matrix. Checked last, after every
  // cover reconcileDay knows, so its note never hides a leave or an excuse that also covered the day.
  if (input.trip) {
    notes.push(`On a business trip: ${input.trip}.`);
    return line;
  }

  if (!punch) {
    // A day nobody can judge honestly is said so, never flagged.
    if (!input.holidayCalendarReachable) {
      notes.push("Not judged: the holiday calendar could not be read, so this may have been a holiday.");
      return line;
    }
    if (input.unreadableCovers.length > 0) {
      notes.push(`Not judged: ${input.unreadableCovers.join(", ")} could not be read.`);
      return line;
    }
    line.flags = ["no_punch"];
    // The policy offers no figure for a missing day; her recommendation supplies it.
    line.suggestedDays = null;
    if (input.anyLeave && !input.fullDayLeave) notes.push("The half not on leave has no punch.");
    return line;
  }

  const flags = punchFlags(punch);
  line.flags = flags;
  line.suggestedDays = flags.length > 0 ? parseSuggestedDays(punch.deductionDays) : null;
  if (punch.halfDayVacationPart) notes.push(`Judged on the worked half (${punch.halfDayVacationPart === "am_only" ? "AM" : "PM"} on leave).`);
  return line;
}

function hasDate(map: Map<string, Set<string>> | undefined, hrId: string, dateIso: string): boolean {
  return Boolean(map?.get(hrId)?.has(dateIso));
}

/** Settled value, or undefined with the source named in `failed`. */
function settled<T>(result: PromiseSettledResult<T>, label: string, failed: string[]): T | undefined {
  if (result.status === "fulfilled") return result.value;
  failed.push(label);
  return undefined;
}

/**
 * Build the head-office lines for `from` .. `to`. Each source degrades alone: a cover source that
 * cannot be read stops any NO-PUNCH day being flagged (said on the line and in the warnings), and a
 * roster or fingerprint failure leaves the section empty with the reason named — never a smaller
 * report that reads as a clean one.
 */
export async function buildOfficeSection(input: { from: string; to: string }): Promise<HrOpsSectionBuild> {
  const warnings: string[] = [];
  let roster: Awaited<ReturnType<typeof getAttendanceRoster>>;
  try {
    roster = await getAttendanceRoster({ dateFromIso: input.from, dateToIso: input.to });
  } catch (error) {
    return { lines: [], warnings: [`Head office: the attendance roster could not be read (${errorText(error)}), so this section is empty.`] };
  }
  const hrIds = roster.map((employee) => employee.hrId);
  if (hrIds.length === 0) return { lines: [], warnings: ["Head office: nobody is mapped to the fingerprint device for these dates."] };

  const [
    policiesResult,
    calendarResult,
    anyLeaveResult,
    fullLeaveResult,
    excuseResult,
    exceptionResult,
    crmResult,
    planResult,
    outageResult,
    tripResult,
    fingerprintResult,
  ] = await Promise.allSettled([
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
    buildAttendanceCalendarContext({ dateFromIso: input.from, dateToIso: input.to }),
    getApprovedLeaveDayMap({ dateFromIso: input.from, dateToIso: input.to, employeeHrIds: hrIds }),
    getFullDayApprovedLeaveMap({ dateFromIso: input.from, dateToIso: input.to, employeeHrIds: hrIds }),
    getApprovedExcuseDayMap({ dateFromIso: input.from, dateToIso: input.to, employeeHrIds: hrIds }),
    getAttendanceExceptionMap(hrIds, input.from, input.to),
    getCrmActivityDayMaps({ dateFromIso: input.from, dateToIso: input.to, employeeHrIds: hrIds }),
    getPlanOfficeDayDetailMap({ dateFromIso: input.from, dateToIso: input.to, employeeHrIds: hrIds }),
    getCompanyWideOutageDates(input.from, input.to),
    loadOutstationTripDays({ end: input.to, start: input.from }),
    getFingerprintAttendanceReport({ dateFrom: input.from, dateTo: input.to }),
  ]);

  const fingerprint = fingerprintResult.status === "fulfilled" ? fingerprintResult.value : null;
  if (!fingerprint) {
    return {
      lines: [],
      warnings: [`Head office: the fingerprint report could not be read (${errorText((fingerprintResult as PromiseRejectedResult).reason)}), so this section is empty.`],
    };
  }
  if (fingerprint.truncated) warnings.push("Head office: the fingerprint record was cut short at its safety ceiling — some punches may be missing.");

  const unreadable: string[] = [];
  const policies = settled(policiesResult, "the attendance policies", unreadable) ?? [];
  const calendar = settled(calendarResult, "the holiday calendar", unreadable);
  const anyLeave = settled(anyLeaveResult, "the approved leave", unreadable);
  const fullLeave = settled(fullLeaveResult, "the approved leave", unreadable);
  const excuses = settled(excuseResult, "the approved excuses", unreadable);
  const exceptions = settled(exceptionResult, "the attendance exceptions", unreadable);
  const crm = settled(crmResult, "the CRM activity", unreadable);
  const plans = settled(planResult, "the approved plans", unreadable);
  const outages = settled(outageResult, "the device sync health", unreadable);
  const trips = settled(tripResult, "the business trips", unreadable);
  const unreadableCovers = [...new Set(unreadable)];
  if (unreadableCovers.length > 0) {
    warnings.push(`Head office: ${unreadableCovers.join(", ")} could not be read, so no day without a punch was flagged.`);
  }
  const holidayCalendarReachable = calendar?.holidayCalendarReachable ?? false;
  if (calendar && !holidayCalendarReachable) {
    warnings.push("Head office: the holiday calendar could not be read in full, so no day without a punch was flagged.");
  }

  const punchByKey = new Map<string, FingerprintReportRow>();
  for (const row of fingerprint.rows) {
    const hrId = normalizeAttendanceHrId(row.employeeHrId);
    if (hrId) punchByKey.set(`${hrId}|${row.dateIso}`, row);
  }
  const tripByKey = new Map<string, string>();
  for (const day of trips ?? []) {
    const hrId = normalizeAttendanceHrId(day.hrId);
    if (hrId && !tripByKey.has(`${hrId}|${day.date}`)) tripByKey.set(`${hrId}|${day.date}`, describeOutstationTripDay(day));
  }

  const lines: HrOpsLineDraft[] = [];
  for (const employee of roster) {
    for (const dateIso of eachDay(input.from, input.to)) {
      if (!isWithinEmploymentSpan(employee, dateIso)) continue;
      const policy = resolveActiveAttendancePolicy({ hr_id: employee.hrId, job_title: employee.jobTitle }, policies, dateIso, dateIso) ?? null;
      const day = calendar
        ? classifyAttendanceDay({ context: calendar, dateIso, jobTitle: employee.jobTitle, workingWeekdays: policy?.working_weekdays })
        : null;
      const exception = exceptions?.get(`${employee.hrId}|${dateIso}`) ?? null;
      const plan = plans?.get(employee.hrId)?.get(dateIso) ?? null;
      const judged = judgeOfficeDay({
        anyLeave: hasDate(anyLeave, employee.hrId, dateIso),
        approvedExcuse: hasDate(excuses, employee.hrId, dateIso),
        crmDetail: crm?.detailMap.get(employee.hrId)?.get(dateIso) ?? null,
        crmFieldVisit: hasDate(crm?.fieldVisitMap, employee.hrId, dateIso),
        crmLeave: hasDate(crm?.leaveMap, employee.hrId, dateIso),
        dateIso,
        deviceOutage: Boolean(outages?.has(dateIso)),
        employee,
        exception: exception ? { reason: exception.reason, status: exception.status } : null,
        fullDayLeave: hasDate(fullLeave, employee.hrId, dateIso),
        holidayCalendarReachable,
        holidayName: day?.holidayName ?? null,
        isFuture: day?.isFuture ?? false,
        isHoliday: day?.isHoliday ?? false,
        // With no calendar at all the day is treated as working but never flagged (see above).
        isWeeklyOff: day?.isWeeklyOff ?? false,
        planSaysOffice: plan ? plan.isOffice : null,
        policy,
        punch: punchByKey.get(`${employee.hrId}|${dateIso}`) ?? null,
        trip: tripByKey.get(`${employee.hrId}|${dateIso}`) ?? null,
        // A failed calendar read is already named here (settled() above), so it blocks a no-punch flag.
        unreadableCovers,
      });
      if (!judged || !judged.hrKey) continue;
      lines.push({ ...judged, hrKey: judged.hrKey });
    }
  }
  return { lines, warnings };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
