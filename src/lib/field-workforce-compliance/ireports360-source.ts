/**
 * iReports360 data source for Field Workforce Compliance.
 *
 * The monthly compliance matrix is sourced from the `ireports360_visits` mirror table
 * (kept in sync by visits-report's cron/backfill — see src/lib/visits-report/service.ts),
 * not from a live CRM call. This module builds the SAME in-memory matrix the Excel parser
 * consumes, so the existing parser + classifier + archive + recommendations pipeline runs
 * unchanged regardless of which source produced the matrix. (The per-rep-day drill-down that
 * used to live here — the one place that called the CRM live — now lives in @/lib/crm/rep-day.)
 *
 * Day-cell mapping (owner-confirmed default; the parity test validates it):
 *   - Regular visit (visitType 0)        -> numeric count for that day (VISITS)
 *   - Annual Vacation (-4), Health (-15) -> "AV" (leave / absence signal)
 *   - Campaign (-8), Conference (-1),
 *     Group Meeting (-2), Training (-9),
 *     Meeting (-11), Traveling (-12)     -> "CP" (worked day, non-numeric activity)
 *   - eligible working day with no record -> "N" (no-activity candidate)
 *   - Friday                              -> left blank (classifier ignores Fridays)
 *   - future day (current month)          -> left blank (not yet occurred)
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { scanVisitsForRange } from "@/lib/crm/reads";
import { isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { buildFieldWorkforceCompliancePreview } from "@/lib/field-workforce-compliance/classifier";
import {
  daysInMonth,
  parseFieldWorkforceComplianceMatrix,
} from "@/lib/field-workforce-compliance/parser";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import type {
  FieldWorkforceCrmIdentity,
  FieldWorkforceCrmIdentityConfidence,
  FieldWorkforceCustomerAuthenticity,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeReference,
  FieldWorkforceHoliday,
  FieldWorkforceLoggingTiming,
  FieldWorkforceLoggingTimingSummary,
  FieldWorkforcePreviewResult,
} from "@/lib/field-workforce-compliance/types";
import type { IReports360Visit } from "@/lib/crm/client";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility";
import { buildFieldWorkforceAttendanceCrossCheck } from "@/lib/field-workforce-compliance/attendance-cross-check";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";

type DirectoryRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Non-regular visit types -> compliance status. Regular (0) is handled as a count. */
const VISIT_TYPE_TO_STATUS = new Map<number, "AV" | "CP">([
  [-1, "CP"], // Conference
  [-2, "CP"], // Group Meeting
  [-4, "AV"], // Annual Vacation
  [-8, "CP"], // Campaign (Prospection)
  [-9, "CP"], // Training
  [-11, "CP"], // Meeting
  [-12, "CP"], // Traveling
  [-15, "AV"], // Health Day
]);

/** Subset of the employee directory that the matrix builder reads. */
export type FieldWorkforceEmployeeInput = Pick<
  DirectoryRow,
  | "crmId"
  | "crmUsername"
  | "employmentStatus"
  | "fullName"
  | "hireDate"
  | "hrId"
  | "jobTitle"
  | "positionTitle"
>;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isFridayIso(dateIso: string): boolean {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

/** Employees who have left the company are not rendered in the monthly report. */
function isDepartedStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "terminated" || normalized === "resigned" || normalized === "inactive";
}

/** Maps a single agent-day's visit records to a compliance cell value.
 *
 * Priority: CP (campaign/special activity) > regular visit count > AV (leave).
 * If ANY visit on a day maps to CP, the whole day is classified as CP —
 * a mixed day (regular visits + one campaign activity) is a campaign day.
 */
function dayCellValue(visits: IReports360Visit[]): number | "AV" | "CP" {
  let regularCount = 0;
  let hasCp = false;
  let hasAv = false;

  for (const visit of visits) {
    if (visit.visitType === 0) {
      regularCount++;
    } else {
      const mapped = VISIT_TYPE_TO_STATUS.get(visit.visitType) ?? "CP";
      if (mapped === "AV") hasAv = true;
      else hasCp = true;
    }
  }

  if (hasCp) return "CP";
  if (regularCount > 0) return regularCount;
  if (hasAv) return "AV";
  return "CP";
}

/** CRM comment pattern for an AV-type visit that is actually an excuse (e.g. "Afternoon
 * Excuse", "Morning Excuse"), not real vacation. iReports360 has no separate visit_type for
 * excuses — both are logged under the same AV-mapped types (-4/-15), distinguished only by
 * this free-text comment. */
const EXCUSE_COMMENT_PATTERN = /excuse/i;

/** True when ANY AV-mapped visit that day carries an excuse-labeled comment. Used only to
 * exclude excuse days from the fingerprint-contradiction recommendation — never affects the
 * base AV classification/severity, which stays visit_type-driven as before. */
function dayHasExcuseLabeledAv(visits: IReports360Visit[]): boolean {
  return visits.some((visit) =>
    VISIT_TYPE_TO_STATUS.get(visit.visitType) === "AV" &&
    EXCUSE_COMMENT_PATTERN.test(visit.comment ?? ""));
}

/**
 * A visit as consumed by the matrix builder. Extends the CRM visit shape with the mirror's
 * already-resolved hr ids (agent_hr_id / double_hr_id). Those come from visits-report's own
 * sync-time resolution (manual override -> crm_id -> crm_username), so when present they are
 * the authoritative crm->hr mapping and make visits-report the single source of truth for
 * identity. Optional because the CRM-live drill-down path and older callers don't carry them.
 */
export type FieldWorkforceMatrixVisit = IReports360Visit & {
  agentHrId?: string | null;
  doubleHrId?: string | null;
};

/**
 * IReports360Visit.saveDate — when this visit record was SAVED into the CRM, from the
 * mirror's crm_save_date column — is what feeds the logging-timing signal below. NOT a
 * GPS-verified visit time: iReports360's own visitDate/visit_date_time is a fixed midnight
 * placeholder on every row (verified in production, 2026-07: 100% of 93,742 rows match), so
 * it carries no real time-of-day signal at all. saveDate is a reasonable proxy for real-time
 * field logging (spreads realistically across a rep's day rather than clustering at one
 * batch-save instant on the vast majority of multi-visit days), but every consumer of it
 * must label it "logged", never "visited".
 */

const LATE_START_THRESHOLD_MINUTES = 11 * 60 + 30; // 11:30 AM, owner-confirmed.

/** Cairo wall-clock minute-of-day for a vendor CRM save timestamp. iReports360 returns saveDate
 * as a ZONE-LESS Cairo wall-clock ("2026-07-16T18:13:18"); the sync stores that string verbatim in
 * a timestamptz column, so Postgres tags it +00 and it returns as an ...Z instant whose clock
 * reading is ALREADY Cairo-local. Read it as-is (timeZone "UTC"); converting through Africa/Cairo
 * would add the Egypt offset a SECOND time and report every logged time 2–3h late (false "late log"). */
function cairoMinutesOfDay(date: Date): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "UTC",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const hour = value("hour");
  const minute = value("minute");
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

function minutesToClockString(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** "AM"/"PM" only (case-normalized); null for anything else (blank, unrecognized values seen
 * in production) — never guessed. */
function normalizeAmpm(value: string | null | undefined): "AM" | "PM" | null {
  const upper = String(value ?? "").trim().toUpperCase();
  return upper === "AM" || upper === "PM" ? upper : null;
}

// Customer-authenticity thresholds — owner-confirmed (2026-07).
const HIGH_CONCENTRATION_SHARE = 0.6;
const LOW_VARIETY_MIN_CONTACTS = 3;
const CONSECUTIVE_SAME_CONTACT_DAYS = 3;
const PM_RECURRING_MIN_WEEKS_IN_ONE_WEEK = 2;

/** ISO 8601 week key ("<isoYear>-W<weekNumber>") for a calendar date, so weeks that span a
 * month/year boundary still group correctly. Only used for informational pattern detection —
 * not a payroll/attendance week boundary. */
function isoWeekKey(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const target = new Date(date.getTime());
  const dayNumber = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const weekNumber = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${pad2(weekNumber)}`;
}

/** Readable contact label: the mirror's contact_name (99.9% populated in production),
 * falling back to "Contact #<id>" on the rare null. */
function contactDisplayName(contactId: number, contactName: string | null): string {
  const cleaned = String(contactName ?? "").trim();
  return cleaned || `Contact #${contactId}`;
}

/**
 * Customer-visit-pattern signal for one employee's month, from their REGULAR (customer)
 * visits only — campaign/meeting/training/leave visit types have no real customer contact
 * and are excluded. contact_crm_id is never null on regular visits in production (verified),
 * so no fuzzy contact matching is needed. See FieldWorkforceCustomerAuthenticity for the rule
 * definitions. Pure function — no DB access — so it's directly unit-testable.
 */
function computeCustomerAuthenticitySignals(monthVisits: FieldWorkforceMatrixVisit[]): FieldWorkforceCustomerAuthenticity {
  const customerVisits = monthVisits.filter((visit) => visit.visitType === 0 && visit.contactID != null);
  const totalCustomerVisits = customerVisits.length;

  if (totalCustomerVisits === 0) {
    return { distinctContacts: 0, flagged: false, flaggedRules: [], topContactName: null, topContactShare: null, totalCustomerVisits: 0 };
  }

  const countByContact = new Map<number, number>();
  const nameByContact = new Map<number, string | null>();
  const daysByContact = new Map<number, Set<string>>();
  const pmWeeksByContact = new Map<number, Map<string, number>>();
  const weeksWithAnyPmVisit = new Set<string>();

  for (const visit of customerVisits) {
    const contactId = visit.contactID as number;
    countByContact.set(contactId, (countByContact.get(contactId) ?? 0) + 1);
    if (!nameByContact.has(contactId)) nameByContact.set(contactId, visit.contactName);

    const dayIso = (visit.visitDate ?? "").slice(0, 10);
    const days = daysByContact.get(contactId) ?? new Set<string>();
    days.add(dayIso);
    daysByContact.set(contactId, days);

    if (normalizeAmpm(visit.ampm) === "PM") {
      const week = isoWeekKey(dayIso);
      weeksWithAnyPmVisit.add(week);
      const weeks = pmWeeksByContact.get(contactId) ?? new Map<string, number>();
      weeks.set(week, (weeks.get(week) ?? 0) + 1);
      pmWeeksByContact.set(contactId, weeks);
    }
  }

  const distinctContacts = countByContact.size;
  const [topContactId, topCount] = [...countByContact.entries()].reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
  );
  const topContactShare = topCount / totalCustomerVisits;
  const topContactName = contactDisplayName(topContactId, nameByContact.get(topContactId) ?? null);

  const flaggedRules: string[] = [];
  if (distinctContacts < LOW_VARIETY_MIN_CONTACTS) flaggedRules.push("low_variety");
  if (topContactShare >= HIGH_CONCENTRATION_SHARE) flaggedRules.push("high_concentration");

  const hasConsecutiveSameContact = [...daysByContact.values()].some((days) => {
    const sorted = [...days].sort();
    let streak = 1;
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = new Date(`${sorted[index - 1]}T00:00:00Z`);
      const current = new Date(`${sorted[index]}T00:00:00Z`);
      const dayGap = Math.round((current.getTime() - previous.getTime()) / 86_400_000);
      streak = dayGap === 1 ? streak + 1 : 1;
      if (streak >= CONSECUTIVE_SAME_CONTACT_DAYS) return true;
    }
    return false;
  });
  if (hasConsecutiveSameContact) flaggedRules.push("consecutive_same_contact");

  const hasPmRecurringContact = [...pmWeeksByContact.entries()].some(([, weeks]) => {
    const twiceInOneWeek = [...weeks.values()].some((count) => count >= PM_RECURRING_MIN_WEEKS_IN_ONE_WEEK);
    const everyPmWeek = weeksWithAnyPmVisit.size >= 2 && weeks.size === weeksWithAnyPmVisit.size;
    return twiceInOneWeek || everyPmWeek;
  });
  if (hasPmRecurringContact) flaggedRules.push("pm_recurring_contact");

  return {
    distinctContacts,
    flagged: flaggedRules.length > 0,
    flaggedRules,
    topContactName,
    topContactShare,
    totalCustomerVisits,
  };
}

/**
 * Builds the Field Workforce Compliance matrix (header row + one row per EMPLOYEE) for a
 * month of iReports360 visits. The report is **employee-driven**: every eligible, active
 * Phoenix employee gets a row even with zero visits, so fully-absent reps and non-visiting
 * managers still appear (and can be reviewed for deductions). Agents in the visit feed that
 * map to no eligible employee are ignored. The output is consumed by the existing
 * parseFieldWorkforceComplianceMatrix, so dateColumns/validation stay identical.
 *
 * Identity resolution (Tier 0 hardening): each visit's agent is recognised by its always-present
 * crm_id and mapped to an hr_id — preferring the mirror's own resolved agent_hr_id, then the
 * directory's crm_id -> hr_id map. There is **no fuzzy first/last-name matching** (its
 * mis-attributions could silently manufacture a wrong no-activity -> payroll deduction).
 * Alongside the matrix it returns, per employee hr key, a FieldWorkforceCrmIdentity describing
 * how confidently they were tied to a CRM identity — `unresolved` employees (no crm_id, no
 * username, never resolved by the sync) have untrustworthy "N" days and are excluded from
 * deduction candidates downstream.
 */
export function buildIReports360FieldWorkforceMatrix(input: {
  employees: FieldWorkforceEmployeeInput[];
  month: number;
  todayIso?: string | null;
  visits: FieldWorkforceMatrixVisit[];
  year: number;
}): {
  avExcuseLabeledKeys: Set<string>;
  customerAuthenticityByHrKey: Map<string, FieldWorkforceCustomerAuthenticity>;
  identityByHrKey: Map<string, FieldWorkforceCrmIdentity>;
  loggingTimingByHrKeyAndDate: Map<string, FieldWorkforceLoggingTiming>;
  matrix: unknown[][];
} {
  const { employees, month, visits, year } = input;
  const todayIso = input.todayIso ?? null;
  const monthPrefix = `${year}-${pad2(month)}`;
  const dayCount = daysInMonth(year, month);
  const dateIsos = Array.from({ length: dayCount }, (_, index) => `${monthPrefix}-${pad2(index + 1)}`);

  // The directory IS the authoritative crm_id -> hr_id map. Keyed by the string crm_id
  // because employees.crm_id is text while the visit feed's agent id is numeric.
  const hrKeyByCrmId = new Map<string, string>();
  for (const employee of employees) {
    const crmId = employee.crmId == null ? "" : String(employee.crmId).trim();
    const hrKey = canonicalHrIdKey(employee.hrId);
    if (crmId && hrKey) hrKeyByCrmId.set(crmId, hrKey);
  }

  // Recognise a visit participant by crm_id, then map to an employee hr key: prefer the
  // mirror's already-resolved hr_id (inherits the sync's override/username decisions), else
  // the directory crm_id map. Null => this CRM agent is not a Phoenix employee, so the visit
  // is correctly ignored (no fuzzy-name rescue).
  const resolveHrKey = (crmId: number | null | undefined, mirrorHrId: string | null | undefined): string | null => {
    const fromMirror = canonicalHrIdKey(mirrorHrId ?? "");
    if (fromMirror) return fromMirror;
    if (crmId == null) return null;
    return hrKeyByCrmId.get(String(crmId).trim()) ?? null;
  };

  // Credit each visit to BOTH its primary agent AND its joint/"double" partner. Managers and
  // senior staff often only ride along on reps' visits as the double, so without this they
  // would wrongly show zero worked days. Track which hr keys the sync itself resolved so we
  // can tell override-resolved employees (real, just no directory crm mapping of ours) apart
  // from genuinely unresolved ones.
  const visitsByHrKey = new Map<string, FieldWorkforceMatrixVisit[]>();
  const syncResolvedHrKeys = new Set<string>();
  const credit = (hrKey: string | null, visit: FieldWorkforceMatrixVisit) => {
    if (!hrKey) return;
    if (!visitsByHrKey.has(hrKey)) visitsByHrKey.set(hrKey, []);
    visitsByHrKey.get(hrKey)!.push(visit);
  };
  for (const visit of visits) {
    const dayIso = (visit.visitDate ?? "").slice(0, 10);
    if (!dayIso.startsWith(monthPrefix)) continue;
    const agentSyncKey = canonicalHrIdKey(visit.agentHrId ?? "");
    if (agentSyncKey) syncResolvedHrKeys.add(agentSyncKey);
    const doubleSyncKey = canonicalHrIdKey(visit.doubleHrId ?? "");
    if (doubleSyncKey) syncResolvedHrKeys.add(doubleSyncKey);

    const agentKey = resolveHrKey(visit.agentID, visit.agentHrId);
    credit(agentKey, visit);
    if (visit.doubleID != null && visit.doubleID !== visit.agentID) {
      const doubleKey = resolveHrKey(visit.doubleID, visit.doubleHrId);
      if (doubleKey && doubleKey !== agentKey) credit(doubleKey, visit);
    }
  }

  const header: unknown[] = ["TM", "HR ID", "Hiring Date", "Month", "Year", ...dateIsos];
  const matrix: unknown[][] = [header];
  const identityByHrKey = new Map<string, FieldWorkforceCrmIdentity>();
  const loggingTimingByHrKeyAndDate = new Map<string, FieldWorkforceLoggingTiming>();
  const customerAuthenticityByHrKey = new Map<string, FieldWorkforceCustomerAuthenticity>();
  const avExcuseLabeledKeys = new Set<string>();

  const eligible = employees
    .filter((employee) => isFieldWorkforceComplianceEligibleTitle(employee.jobTitle, employee.positionTitle))
    .filter((employee) => !isDepartedStatus(employee.employmentStatus))
    .sort((left, right) =>
      String(left.hrId).localeCompare(String(right.hrId), undefined, { numeric: true }));

  for (const employee of eligible) {
    const hrKey = canonicalHrIdKey(employee.hrId);
    const agentVisits = hrKey ? visitsByHrKey.get(hrKey) ?? [] : [];

    // Confidence: could we ever have SEEN this employee's visits? Drives the deduction guard.
    const crmId = employee.crmId == null ? "" : String(employee.crmId).trim();
    const crmUsername = employee.crmUsername == null ? "" : String(employee.crmUsername).trim();
    let confidence: FieldWorkforceCrmIdentityConfidence;
    if (crmId) confidence = "crm_id";
    else if (crmUsername) confidence = "crm_username";
    else if (hrKey && syncResolvedHrKeys.has(hrKey)) confidence = "override";
    else confidence = "unresolved";
    if (hrKey) {
      identityByHrKey.set(hrKey, {
        attributedVisitRows: agentVisits.length,
        confidence,
        crmId: crmId || null,
      });
    }

    const byDay = new Map<string, FieldWorkforceMatrixVisit[]>();
    for (const visit of agentVisits) {
      const dayIso = (visit.visitDate ?? "").slice(0, 10);
      if (!byDay.has(dayIso)) byDay.set(dayIso, []);
      byDay.get(dayIso)!.push(visit);
    }

    if (hrKey) {
      for (const [dayIso, dayVisits] of byDay) {
        const timing = computeLoggingTiming(dayVisits);
        if (timing) loggingTimingByHrKeyAndDate.set(`${hrKey}|${dayIso}`, timing);
        if (dayHasExcuseLabeledAv(dayVisits)) avExcuseLabeledKeys.add(`${hrKey}|${dayIso}`);
      }
      customerAuthenticityByHrKey.set(hrKey, computeCustomerAuthenticitySignals(agentVisits));
    }

    const dayCells = dateIsos.map((dateIso) => {
      const dayVisits = byDay.get(dateIso);
      if (dayVisits && dayVisits.length > 0) return dayCellValue(dayVisits);
      if (isFridayIso(dateIso)) return null;
      if (todayIso && dateIso > todayIso) return null;
      return "N";
    });

    matrix.push([
      employee.fullName ?? "",
      employee.hrId,
      employee.hireDate ? String(employee.hireDate).slice(0, 10) : "",
      month,
      year,
      ...dayCells,
    ]);
  }

  return { avExcuseLabeledKeys, customerAuthenticityByHrKey, identityByHrKey, loggingTimingByHrKeyAndDate, matrix };
}

/** One day's CRM-logging-timing signal from its (unordered) visits' saveDate (crm_save_date).
 * Null when no visit that day has a usable save timestamp. See the comment above
 * FieldWorkforceMatrixVisit for why this is "logged" time, not a GPS-verified visit time. */
function computeLoggingTiming(dayVisits: FieldWorkforceMatrixVisit[]): FieldWorkforceLoggingTiming | null {
  const timedVisits = dayVisits
    .map((visit) => {
      if (!visit.saveDate) return null;
      const date = new Date(visit.saveDate);
      if (Number.isNaN(date.getTime())) return null;
      const minutes = cairoMinutesOfDay(date);
      if (minutes == null) return null;
      return { ampm: normalizeAmpm(visit.ampm), minutes };
    })
    .filter((entry): entry is { ampm: "AM" | "PM" | null; minutes: number } => entry !== null);

  if (timedVisits.length === 0) return null;

  const allMinutes = timedVisits.map((entry) => entry.minutes);
  const firstMinutes = Math.min(...allMinutes);
  const lastMinutes = Math.max(...allMinutes);

  const amMinutes = timedVisits.filter((entry) => entry.ampm === "AM").map((entry) => entry.minutes);
  const isLateStart = amMinutes.length > 0 ? Math.min(...amMinutes) > LATE_START_THRESHOLD_MINUTES : null;

  return {
    activeWindowMinutes: lastMinutes - firstMinutes,
    firstLoggedTime: minutesToClockString(firstMinutes),
    isLateStart,
    lastLoggedTime: minutesToClockString(lastMinutes),
  };
}

/** Parses an "HH:MM" clock string (as produced by minutesToClockString) back to minutes. */
function clockStringToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Month-level rollup of a timeline's per-day loggingTiming. Null if no day that month has a
 * CRM-logged save timestamp (Excel path). */
function summarizeLoggingTiming(timeline: FieldWorkforceDayCell[]): FieldWorkforceLoggingTimingSummary | null {
  const timedDays = timeline.filter((cell): cell is FieldWorkforceDayCell & { loggingTiming: FieldWorkforceLoggingTiming } =>
    Boolean(cell.loggingTiming));
  if (timedDays.length === 0) return null;

  const firstLoggedMinutes = timedDays
    .map((cell) => (cell.loggingTiming.firstLoggedTime ? clockStringToMinutes(cell.loggingTiming.firstLoggedTime) : null))
    .filter((value): value is number => value != null);
  const avgFirstLoggedTime = firstLoggedMinutes.length > 0
    ? minutesToClockString(Math.round(firstLoggedMinutes.reduce((sum, value) => sum + value, 0) / firstLoggedMinutes.length))
    : null;
  const lateStartDayCount = timedDays.filter((cell) => cell.loggingTiming.isLateStart === true).length;

  return { avgFirstLoggedTime, lateStartDayCount, timedDayCount: timedDays.length };
}

function toEmployeeReference(employee: DirectoryRow): FieldWorkforceEmployeeReference {
  return {
    areaName: employee.areaName,
    departmentName: employee.departmentName,
    employmentStatus: employee.employmentStatus,
    fullName: employee.fullName,
    hireDate: employee.hireDate,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    managerName: employee.managerName,
    regionName: employee.regionName,
    roleName: employee.positionTitle ?? employee.jobTitle,
    teamName: employee.teamName,
  };
}

async function loadHolidays(month: number, year: number): Promise<{
  connected: boolean;
  holidays: FieldWorkforceHoliday[];
  message: string | null;
  sourceLabel: string;
}> {
  try {
    const result = await getConfirmedNationalHolidays({ month, year });
    return {
      connected: result.connected,
      holidays: result.holidays.map((holiday) => ({
        endDate: holiday.endDate,
        name: holiday.name,
        startDate: holiday.startDate,
      })),
      message: result.message,
      sourceLabel: result.sourceLabel,
    };
  } catch (error) {
    return {
      connected: false,
      holidays: [],
      message: error instanceof Error ? error.message : "National holiday lookup failed.",
      sourceLabel: "Egypt public holidays",
    };
  }
}

/** The iReports360 visits mirror is ready when the CRM read layer can probe it (single source). */
async function isVisitsReportSchemaReady(): Promise<boolean> {
  return isCrmVisitsSchemaReady();
}

export type VisitsMirrorRow = {
  agent_crm_id: number;
  agent_hr_id?: string | null;
  agent_name: string | null;
  ampm?: string | null;
  contact_crm_id?: number | null;
  contact_name?: string | null;
  crm_save_date?: string | null;
  double_crm_id: number | null;
  double_hr_id?: string | null;
  double_name: string | null;
  visit_date: string;
  visit_type: number | null;
};

/** Maps a mirror row (ireports360_visits) onto the matrix-builder visit shape. Carries the
 * mirror's already-resolved agent_hr_id / double_hr_id (visits-report's sync-time
 * override->crm_id->username resolution) so the matrix builder can trust them for identity.
 * Other CRM fields are unused by the matrix builder and left null. visit_type is never null
 * in production today (verified), so a null here fails loudly rather than silently defaulting
 * to a "regular visit" and miscounting compliance. Exported for the mirror-row-mapping parity
 * test in tests/field-workforce-compliance-eligibility.test.ts. */
export function visitFromMirrorRow(row: VisitsMirrorRow): FieldWorkforceMatrixVisit {
  if (row.visit_type == null) {
    throw new Error(`ireports360_visits row for agent ${row.agent_crm_id} on ${row.visit_date} has no visit_type.`);
  }
  return {
    agentHrId: row.agent_hr_id ?? null,
    agentID: row.agent_crm_id,
    agentName: row.agent_name,
    ampm: row.ampm ?? null,
    attendance: null,
    callType: null,
    comment: null,
    contactID: row.contact_crm_id ?? null,
    contactName: row.contact_name ?? null,
    customerName: null,
    doubleHrId: row.double_hr_id ?? null,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    id: 0,
    saveDate: row.crm_save_date ?? null,
    visitDate: row.visit_date,
    visitType: row.visit_type,
    visitTypeDescription: null,
  };
}

/** Fetches every ireports360_visits row in [startDate, endDate] in a single query — a full
 * month must be in memory at once to build the matrix, unlike visits-report's UI which
 * paginates for display only.
 *
 * Previously used offset-based pagination (.range()) which caused "canceling statement due to
 * statement timeout" errors: each paginated call against the ~93k-row table with its wide
 * raw_payload jsonb column was running close to the 8s Postgres statement timeout, and
 * offset-based pagination degrades as the offset grows. A covering index on visit_date
 * (ireports360_visits_visit_date_covering_idx) now allows a single index-only scan that
 * fetches all projected columns without touching the wide heap rows.
 *
 * Day bucketing: filtering and every downstream day cell key off `visit_date` (a pure DATE
 * populated directly by visits-report's own sync from the CRM API's visit-date field — its
 * correctness is a visits-report concern, not derived here). Note: `visit_date_time` is NOT a
 * useful cross-check for this — verified in production (2026-07) that it is a fixed
 * `<visit_date> 00:00:00+00` placeholder on all 93,742 rows (iReports360 never returns a real
 * visit clock time), so comparing it to `visit_date` is tautological, not a real timezone
 * verification. `crm_save_date`, by contrast, does carry real time variety and is what the
 * logging-timing signal (computeLoggingTiming) is built on — see the comment above
 * FieldWorkforceMatrixVisit. */
async function loadMirrorVisitsForRange(startDate: string, endDate: string): Promise<VisitsMirrorRow[]> {
  // Reads through the CRM single-door range scanner, which offset-paginates past the db-max-rows
  // cap WITHOUT an ORDER BY so the covering index ireports360_visits_visit_date_covering_idx can
  // serve each page as an index-only scan — keeping a full month (~90k rows) well within the 8s
  // statement timeout. Resigned/excluded agents are removed inside the read layer (single source).
  return scanVisitsForRange<VisitsMirrorRow>({
    dateFrom: startDate,
    dateTo: endDate,
    columns:
      "agent_crm_id, agent_hr_id, agent_name, ampm, contact_crm_id, contact_name, crm_save_date, " +
      "double_crm_id, double_hr_id, double_name, visit_date, visit_type",
  });
}

function validateMonthYear(month: number, year: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new FieldWorkforcePreviewError({
      code: "invalid_month",
      message: "Select a month between 1 and 12.",
      status: 400,
    });
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new FieldWorkforcePreviewError({
      code: "invalid_year",
      message: "Select a valid year.",
      status: 400,
    });
  }
}

/**
 * Live-view equivalent of buildFieldWorkforceCompliancePreviewFromWorkbook: reads a
 * month of visits from the ireports360_visits mirror (visits-report's synced table,
 * NOT a live CRM call), maps them onto the compliance matrix, and runs the existing
 * classifier to produce the same FieldWorkforcePreviewResult. Any historical month back
 * to the mirror's earliest synced data works the same way — there is no separate
 * "import" step; the view always reflects whatever visits-report has synced so far.
 */
export async function buildFieldWorkforceCompliancePreviewFromVisitsReport(input: {
  month: number;
  todayIso?: string | null;
  year: number;
}): Promise<FieldWorkforcePreviewResult> {
  const { month, year } = input;
  validateMonthYear(month, year);

  if (!(await isVisitsReportSchemaReady())) {
    throw new FieldWorkforcePreviewError({
      code: "visits_report_not_ready",
      message: "The iReports360 visits mirror is not set up yet. Run the visits-report migration/backfill first.",
      status: 503,
    });
  }

  const startDate = `${year}-${pad2(month)}-01`;
  const endDate = `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;

  const [mirrorRows, directory] = await Promise.all([
    loadMirrorVisitsForRange(startDate, endDate),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const visits = mirrorRows.map(visitFromMirrorRow);

  const { avExcuseLabeledKeys, customerAuthenticityByHrKey, identityByHrKey, loggingTimingByHrKeyAndDate, matrix } = buildIReports360FieldWorkforceMatrix({
    employees: directory,
    month,
    todayIso: input.todayIso ?? null,
    visits,
    year,
  });

  const parsed = parseFieldWorkforceComplianceMatrix({
    fileName: `iReports360 Visits Mirror ${MONTH_LABELS[month - 1]} ${year}`,
    matrix,
    sheetName: "iReports360 Visits (mirror)",
  });

  const holidays = await loadHolidays(month, year);

  const preview = buildFieldWorkforceCompliancePreview({
    employeeReferences: directory.map(toEmployeeReference),
    holidayConnected: holidays.connected,
    holidayMessage: holidays.message,
    holidaySourceLabel: holidays.sourceLabel,
    holidays: holidays.holidays,
    parsed,
  });

  // Attach the CRM-identity resolution to each employee so the UI and the deductions guard
  // can tell a genuinely-absent rep apart from one we simply couldn't match to a CRM account.
  // Also attach per-day CRM-logging timing (informational only — never affects
  // severity/deductions) and roll it up into a month-level summary per employee.
  const unresolvedHrIds: string[] = [];
  const employeesWithIdentity = preview.employees.map((employee) => {
    const hrKey = canonicalHrIdKey(employee.hrId);
    const identity = hrKey ? identityByHrKey.get(hrKey) ?? null : null;
    if (identity?.confidence === "unresolved") unresolvedHrIds.push(employee.hrId);

    const timeline = employee.timeline.map((cell) => {
      const timing = hrKey ? loggingTimingByHrKeyAndDate.get(`${hrKey}|${cell.dateIso}`) ?? null : null;
      const isExcuseLabeledAv = hrKey ? avExcuseLabeledKeys.has(`${hrKey}|${cell.dateIso}`) : false;
      if (!timing && !isExcuseLabeledAv) return cell;
      return {
        ...cell,
        ...(timing ? { loggingTiming: timing } : {}),
        ...(isExcuseLabeledAv ? { isExcuseLabeledAv: true } : {}),
      };
    });
    const loggingTimingSummary = summarizeLoggingTiming(timeline);
    const customerAuthenticity = hrKey ? customerAuthenticityByHrKey.get(hrKey) ?? null : null;

    return { ...employee, crmIdentity: identity, customerAuthenticity, loggingTimingSummary, timeline };
  });

  const warnings = [...preview.warnings];
  if (unresolvedHrIds.length > 0) {
    const sample = unresolvedHrIds.slice(0, 8).join(", ");
    warnings.push({
      code: "crm_identity_unresolved",
      message:
        `${unresolvedHrIds.length} eligible employee(s) have no iReports360 CRM identity mapping ` +
        `(no crm_id / username): ${sample}${unresolvedHrIds.length > 8 ? ", …" : ""}. Their days ` +
        `cannot be verified against the visits mirror, so they are shown for review only and excluded ` +
        `from deduction candidates. Fix their CRM mapping in Visits Report to include them.`,
      severity: "warning",
    });
  }

  // Cross-check against the physical fingerprint attendance system (informational only —
  // never affects severity/status/deductions). Best-effort: a failure here downgrades to a
  // warning, it never breaks the FWC preview itself.
  const attendanceCrossCheck = await buildFieldWorkforceAttendanceCrossCheck({
    employees: employeesWithIdentity,
    month,
    year,
  });
  const employeesWithAttendanceCrossCheck = attendanceCrossCheck.crossCheckByHrKeyAndDate.size === 0
    ? employeesWithIdentity
    : employeesWithIdentity.map((employee) => {
        const hrKey = canonicalHrIdKey(employee.hrId);
        if (!hrKey) return employee;
        const timeline = employee.timeline.map((cell) => {
          const result = attendanceCrossCheck.crossCheckByHrKeyAndDate.get(`${hrKey}|${cell.dateIso}`);
          return result ? { ...cell, attendanceCrossCheck: result } : cell;
        });
        return { ...employee, timeline };
      });
  if (attendanceCrossCheck.warning) {
    warnings.push({ code: "attendance_cross_check_unavailable", message: attendanceCrossCheck.warning, severity: "warning" });
  }

  return { ...preview, employees: employeesWithAttendanceCrossCheck, warnings };
}
