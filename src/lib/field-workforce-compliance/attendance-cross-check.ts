/**
 * Cross-check between Field Workforce Compliance's CRM-visit classification and the
 * physical fingerprint attendance system, for one month's already-built employee timelines.
 *
 * Scope: only employees with an ACTIVE fingerprint device mapping are checked — a missing
 * punch is only a meaningful signal for someone who actually uses the device. An employee
 * who is merely "attendance-tracking eligible by job title" but never enrolled on a device
 * would show zero punches every day regardless of real attendance, which would make every
 * worked day look like a false "visits_no_punch" — that false-positive risk is why this
 * intentionally does NOT use the broader isAttendanceTracked() eligibility check.
 *
 * Also flags the reverse-of-trust case: a day FWC classified "AV" (vacation signal) where the
 * employee has a matching fingerprint punch — the CRM calendar and physical attendance
 * disagree. This only ever fires for device-mapped employees, which in practice means
 * office-based (Head Office) staff, since field reps are not enrolled on a fingerprint device.
 * That signal is further split by how much of the day was actually worked (last punch minus
 * first punch, Cairo-local): under AV_HALF_DAY_MAX_WORKED_MINUTES reads as a half-day vacation
 * (av_with_partial_punch) rather than a full contradiction (av_with_punch) — owner-confirmed
 * threshold: HO's Ramadan schedule was 10:00-16:00 (6h) with a 1h grace, and the same 5h
 * threshold was confirmed for non-Ramadan months too, so one constant covers both.
 *

 * A day with an approved attendance exception is never flagged either way — HR already
 * reviewed and explained it.
 *
 * Read-only of both systems. Never mutates attendance or FWC data. Best-effort: any failure
 * downgrades to an empty result + a warning, matching loadHolidays' pattern in
 * ireports360-source.ts — a cross-check outage must never break the FWC preview.
 */

import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type {
  FieldWorkforceAttendanceCrossCheckResult,
  FieldWorkforceEmployeeSummary,
} from "@/lib/field-workforce-compliance/types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Owner-confirmed threshold (2026-07): under 5 worked hours on an AV-tagged day reads as a
 * half-day vacation, not a full attendance/calendar contradiction. Derived from HO's Ramadan
 * schedule (10:00-16:00 = 6h, minus 1h grace = 5h) and separately confirmed as the same 5h
 * figure for non-Ramadan months — one constant, no month-of-year branching needed. */
const AV_HALF_DAY_MAX_WORKED_MINUTES = 5 * 60;

export type FieldWorkforceAttendanceCrossCheckOutcome = {
  /** Keyed "<canonicalHrKey>|<dateIso>". Only present for device-mapped employees' non-ignored,
   * non-exception days where the two systems actually disagree. */
  crossCheckByHrKeyAndDate: Map<string, FieldWorkforceAttendanceCrossCheckResult>;
  /** Non-null only when the cross-check itself could not run (attendance data unavailable). */
  warning: string | null;
};

const emptyOutcome = (warning: string | null = null): FieldWorkforceAttendanceCrossCheckOutcome => ({
  crossCheckByHrKeyAndDate: new Map(),
  warning,
});

/**
 * Builds the cross-check map for a month's already-classified FWC employee timelines.
 * Call this AFTER the FWC preview is built (classifier has already resolved ignored/status
 * per day) — it reads `employee.timeline[].ignored/status/countedAsWorkedDay`, it doesn't
 * reclassify anything itself.
 */
export async function buildFieldWorkforceAttendanceCrossCheck(input: {
  employees: FieldWorkforceEmployeeSummary[];
  month: number;
  year: number;
}): Promise<FieldWorkforceAttendanceCrossCheckOutcome> {
  const dateFrom = `${input.year}-${pad2(input.month)}-01`;
  const lastDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
  const dateTo = `${input.year}-${pad2(input.month)}-${pad2(lastDay)}`;

  let deviceMappedKeys: Set<string>;
  try {
    const rawDeviceMapped = await loadActiveDeviceMappedHrIds();
    deviceMappedKeys = new Set(
      [...rawDeviceMapped].map((id) => canonicalHrIdKey(id)).filter((key): key is string => Boolean(key)),
    );
  } catch (error) {
    return emptyOutcome(`Attendance cross-check unavailable this month: ${error instanceof Error ? error.message : "device mapping lookup failed"}.`);
  }

  const trackedEmployees = input.employees.filter((employee) => {
    const key = canonicalHrIdKey(employee.hrId);
    return key ? deviceMappedKeys.has(key) : false;
  });
  if (trackedEmployees.length === 0) return emptyOutcome(null);

  let report: Awaited<ReturnType<typeof getFingerprintAttendanceReport>>;
  let exceptions: Awaited<ReturnType<typeof getAttendanceExceptions>>;
  let dayPunchMinutes: Awaited<ReturnType<typeof loadEmployeeDayPunchMinutes>>;
  try {
    [report, exceptions, dayPunchMinutes] = await Promise.all([
      getFingerprintAttendanceReport({ dateFrom, dateTo, employeeHrIds: trackedEmployees.map((employee) => employee.hrId) }),
      getAttendanceExceptions({ dateFrom, dateTo, status: "approved" }),
      loadEmployeeDayPunchMinutes({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds: trackedEmployees.map((employee) => employee.hrId) }),
    ]);
  } catch (error) {
    return emptyOutcome(`Attendance cross-check unavailable this month: ${error instanceof Error ? error.message : "fingerprint report unavailable"}.`);
  }

  const punchedKeys = new Set<string>();
  for (const row of report.rows) {
    const key = canonicalHrIdKey(row.employeeHrId);
    if (key) punchedKeys.add(`${key}|${row.dateIso}`);
  }

  const exceptionKeys = new Set<string>();
  for (const exception of exceptions) {
    const key = canonicalHrIdKey(exception.employeeHrId);
    if (key) exceptionKeys.add(`${key}|${exception.exceptionDate.slice(0, 10)}`);
  }

  // Worked minutes = last punch minus first punch that Cairo-local day (null when we can't
  // compute it — e.g. a single visible punch). Only ever consulted for the AV+punch case, to
  // decide half-day vs. full contradiction; every other branch stays boolean punched/not.
  const workedMinutesByKey = new Map<string, number | null>();
  for (const [hrId, byDate] of dayPunchMinutes) {
    const key = canonicalHrIdKey(hrId);
    if (!key) continue;
    for (const [dateIso, punches] of byDate) {
      const span = punches.firstPunchMinutes != null && punches.lastPunchMinutes != null
        ? punches.lastPunchMinutes - punches.firstPunchMinutes
        : null;
      // A negative span can only arise from the October DST fall-back minute-of-day wrap; treat
      // it as unknown (null). The AV+punch branch already defaults unknown worked time to
      // av_with_partial_punch, so this is behaviour-neutral, it just makes the intent explicit
      // and never lets a garbled negative masquerade as a sub-threshold "partial" measurement.
      const worked = span != null && span >= 0 ? span : null;
      workedMinutesByKey.set(`${key}|${dateIso}`, worked);
    }
  }

  return {
    crossCheckByHrKeyAndDate: computeAttendanceCrossCheck({ employees: trackedEmployees, exceptionKeys, punchedKeys, workedMinutesByKey }),
    warning: null,
  };
}

/**
 * Pure decision logic, extracted so it's directly unit-testable without a DB — given the
 * already-tracked (device-mapped) employees plus the punched-day and approved-exception key
 * sets (both "<canonicalHrKey>|<dateIso>"), decides visits_no_punch / punch_no_visits per day.
 * Skips FWC-ignored days (pre-hire/post-exit/holiday/weekly-off — already resolved in the
 * timeline) and any day with an approved exception (already reviewed by HR).
 *
 * workedMinutesByKey (same "<canonicalHrKey>|<dateIso>" keying) is only consulted for the
 * AV+punch case, to split it into av_with_partial_punch (< AV_HALF_DAY_MAX_WORKED_MINUTES
 * worked, or unknown — the conservative default) vs. av_with_punch (proven >= the threshold).
 * Defaulting an unresolvable duration to the half-day bucket avoids ever wrongly zeroing out a
 * genuine vacation day on incomplete data.
 */
export function computeAttendanceCrossCheck(input: {
  employees: FieldWorkforceEmployeeSummary[];
  exceptionKeys: Set<string>;
  punchedKeys: Set<string>;
  workedMinutesByKey?: Map<string, number | null>;
}): Map<string, FieldWorkforceAttendanceCrossCheckResult> {
  const workedMinutesByKey = input.workedMinutesByKey ?? new Map<string, number | null>();
  const crossCheckByHrKeyAndDate = new Map<string, FieldWorkforceAttendanceCrossCheckResult>();
  for (const employee of input.employees) {
    const hrKey = canonicalHrIdKey(employee.hrId);
    if (!hrKey) continue;
    for (const cell of employee.timeline) {
      if (cell.ignored) continue;
      const dayKey = `${hrKey}|${cell.dateIso}`;
      if (input.exceptionKeys.has(dayKey)) continue;
      const punched = input.punchedKeys.has(dayKey);

      if (cell.countedAsWorkedDay && !punched) {
        crossCheckByHrKeyAndDate.set(dayKey, "visits_no_punch");
      } else if (cell.status === "N" && punched) {
        crossCheckByHrKeyAndDate.set(dayKey, "punch_no_visits");
      } else if (cell.status === "AV" && punched) {
        const workedMinutes = workedMinutesByKey.get(dayKey) ?? null;
        crossCheckByHrKeyAndDate.set(
          dayKey,
          workedMinutes != null && workedMinutes >= AV_HALF_DAY_MAX_WORKED_MINUTES
            ? "av_with_punch"
            : "av_with_partial_punch",
        );
      }
    }
  }
  return crossCheckByHrKeyAndDate;
}
