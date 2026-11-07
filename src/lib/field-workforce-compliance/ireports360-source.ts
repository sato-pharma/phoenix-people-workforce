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
 *   - Annual Vacation (-4)               -> "AV" (leave / absence signal)
 *   - Campaign (-8), Conference (-1),
 *     Group Meeting (-2), Training (-9),
 *     Meeting (-11), Traveling (-12),
 *     Health Day (-15)                   -> "CP" (worked day, non-numeric activity)
 *   - eligible working day with no record -> "N" (no-activity candidate)
 *   - Friday                              -> left blank (classifier ignores Fridays)
 *   - future day (current month)          -> left blank (not yet occurred)
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { buildManagersAboveByHrId } from "@/lib/org/manager-filter";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { collapseDuplicateVisitSubmissions, scanVisitsForRangeCreditingPartners } from "@/lib/crm/reads";
import { isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import {
  loadPhoenixWorkEvidenceDays,
  phoenixWorkedDayKeySet,
} from "@/lib/crm/phoenix-work-evidence";
import { crmVisitTypeMeaningLenient } from "@/lib/crm/visit-type-meaning";
import { classifyVisit } from "@/lib/crm/visit-types";
import { addBucketToSplit, emptyVisitCountSplit, visitCountBucket, type VisitCountBucket, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
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
import type { IReports360Visit } from "@/lib/crm/vendor-row-types";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility";
import { buildFieldWorkforceAttendanceCrossCheck } from "@/lib/field-workforce-compliance/attendance-cross-check";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { loadFieldLeaveDaysFromHr } from "@/lib/crm/hr-leave-days";
import { loadManagerOwnVisitDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";

type DirectoryRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/*
 * Non-regular visit types -> compliance status (AV = leave, CP = worked, not a regular visit) is
 * decided by the single table in src/lib/crm/visit-type-meaning.ts. This matrix reads it through
 * the LENIENT lookup: a code the table does not list counts as a worked day ("CP"), exactly as the
 * old `?? "CP"` default here did. Regular (0) is handled as a count and never looked up.
 */

/**
 * Visit types iReports360 also uses to log EXCUSES — there is no dedicated
 * excuse visit_type (see EXCUSE_COMMENT_PATTERN below).
 *
 * Deliberately its own set rather than derived from the visit-type meaning table:
 * excuse detection has always considered both -4 and -15, and must keep doing
 * so now that -15 classifies as CP instead of AV. Deriving it from the status
 * map would have silently stopped excuse-labelled health days being held back
 * from the fingerprint-contradiction recommendation.
 */
const EXCUSE_CAPABLE_VISIT_TYPES = new Set<number>([-4, -15]);

/** Subset of the employee directory that the matrix builder reads. */
export type FieldWorkforceEmployeeInput = Pick<
  DirectoryRow,
  | "crmId"
  | "crmUsername"
  | "displayName"
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

/** Maps a single agent-day's visit records to a compliance cell value.
 *
 * Priority: regular visit count > CP (campaign/special activity) > AV (leave).
 * A "mixed" day (regular visits AND a campaign activity) now COUNTS its regular visits
 * (returns the numeric count, i.e. VISITS) rather than collapsing to CP — the campaign is
 * preserved separately as a display/metric overlay (see mixedDayHasCampaign +
 * campaignOverlayKeys) so the grid shows a split square and campaignDays stays
 * accurate. Owner decision 2026-07-20: a rep's real regular visits must never be hidden or
 * dropped from the total just because a campaign also happened that day. Only a pure-campaign
 * day (no regular visit) still classifies as CP.
 */
function dayCellValue(visits: IReports360Visit[]): number | "AV" | "CP" {
  let regularCount = 0;
  let hasCp = false;
  let hasAv = false;

  for (const visit of visits) {
    if (visit.visitType === 0) {
      regularCount++;
    } else {
      const mapped = crmVisitTypeMeaningLenient(visit.visitType);
      if (mapped === "AV") hasAv = true;
      else hasCp = true;
    }
  }

  if (regularCount > 0) return regularCount;
  if (hasCp) return "CP";
  if (hasAv) return "AV";
  return "CP";
}

/** True for a "mixed" day: at least one regular (type 0) visit AND at least one campaign-class
 * activity. Such a day now counts as VISITS (see dayCellValue) but must still surface its
 * campaign — this drives the grid's two-color split square and keeps the campaignDays metric
 * from silently dropping mixed days once they no longer classify as CP. */
function mixedDayHasCampaign(visits: IReports360Visit[]): boolean {
  let regularCount = 0;
  let hasCp = false;
  for (const visit of visits) {
    if (visit.visitType === 0) regularCount++;
    else if (crmVisitTypeMeaningLenient(visit.visitType) === "CP") hasCp = true;
  }
  return regularCount > 0 && hasCp;
}

/** CRM comment pattern for a visit that is actually an excuse (e.g. "Afternoon
 * Excuse", "Morning Excuse"), not real vacation. iReports360 has no separate visit_type for
 * excuses — they are logged under types -4/-15, distinguished only by this free-text
 * comment. */
const EXCUSE_COMMENT_PATTERN = /excuse/i;

/** True when ANY excuse-capable visit that day carries an excuse-labeled comment. Used only to
 * exclude excuse days from the fingerprint-contradiction recommendation — never affects the
 * base AV/CP classification/severity, which stays visit_type-driven as before. Keyed on
 * EXCUSE_CAPABLE_VISIT_TYPES (-4/-15) rather than on the AV status, so it still catches an
 * excuse logged as -15 now that health days classify as CP. */
function dayHasExcuseLabeledAv(visits: IReports360Visit[]): boolean {
  return visits.some((visit) =>
    EXCUSE_CAPABLE_VISIT_TYPES.has(visit.visitType) &&
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
  /** Slot 2 — a chain visit's SECOND manager, who is on the same Phoenix row rather than a second
   * vendor one. His working day lives on this row exactly as slot 1's does, so leaving it unread is
   * the same defect the comment in the loader describes: a manager who rode along all day reads as
   * having done nothing, and this matrix is what a payroll deduction candidate is drawn from.
   *
   * There is no `double2ID`: Phoenix carries the hr id and often no CRM account at all, which is why
   * the credit below is gated on the hr id and not on a CRM id like slot 1's. */
  double2HrId?: string | null;
  double2Name?: string | null;
  /** This row's AGENT has left the company and is excluded from every live CRM read, so ONLY the
   * double-visit partner may be credited from it — see `scanVisitsForRangeCreditingPartners`. The
   * row is here at all because the partner's own working day depends on it. */
  partnerCreditOnly?: boolean;
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
/**
 * The AM · PM · Pharmacies bucket a visit row counts in, or null for a row that is no customer or pharmacy call (a
 * campaign, a meeting, leave). Through `visitCountBucket`, the golden rule's one helper — never a second copy of it.
 */
export function splitBucketOf(visit: Pick<IReports360Visit, "ampm" | "comment" | "speciality" | "visitType" | "visitTypeDescription">): VisitCountBucket | null {
  const bucket = visitCountBucket({
    ampm: visit.ampm,
    comment: visit.comment,
    speciality: visit.speciality,
    visit_type: visit.visitType,
    visit_type_description: visit.visitTypeDescription,
  });
  if (bucket === "Pharmacies") return bucket;
  // A field call — Regular, or the vendor's unlabelled field visit — counts; a campaign, training or admin row does not.
  return classifyVisit(visit.visitType, visit.comment, visit.visitTypeDescription).bucket === "regular" ? bucket : null;
}

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
  /** Canonicalized (canonicalHrIdKey) HR-ID keys of employees actively enrolled on a
   * fingerprint device — Head Office / office-based staff who don't have a field-eligible
   * title still get a row so their office attendance can be cross-checked against CRM
   * activity. Optional/defaults empty so existing callers are unaffected. */
  deviceMappedHrKeys?: Set<string>;
  /** `${canonicalHrIdKey}|${YYYY-MM-DD}` days HR approved as leave, from the day iReports360 was retired
   * (crm/hr-leave-days.ts). A day with no visit and no worked proof in this set is "AV", never "N". Optional,
   * defaults empty, so the archive's own -4 alone answers before that day. */
  hrLeaveKeys?: ReadonlySet<string>;
  month: number;
  /** `${canonicalHrIdKey}|${YYYY-MM-DD}` pairs Phoenix CRM proves worked. A day with no mirror
   * visit but in this set is "CP" (worked, non-numeric), never "N". Optional, defaults empty. */
  phoenixWorkedKeys?: ReadonlySet<string>;
  todayIso?: string | null;
  visits: FieldWorkforceMatrixVisit[];
  year: number;
}): {
  avExcuseLabeledKeys: Set<string>;
  campaignOverlayKeys: Set<string>;
  customerAuthenticityByHrKey: Map<string, FieldWorkforceCustomerAuthenticity>;
  identityByHrKey: Map<string, FieldWorkforceCrmIdentity>;
  loggingTimingByHrKeyAndDate: Map<string, FieldWorkforceLoggingTiming>;
  matrix: unknown[][];
  ownRegularCountByHrKeyAndDate: Map<string, number>;
  ownSplitByHrKeyAndDate: Map<string, VisitCountSplit>;
  rideAlongSplitByHrKeyAndDate: Map<string, VisitCountSplit>;
  visitPeriodByHrKeyAndDate: Map<string, "AM" | "PM" | "MIXED">;
} {
  const { employees, month, visits, year } = input;
  const deviceMappedHrKeys = input.deviceMappedHrKeys ?? new Set<string>();
  const todayIso = input.todayIso ?? null;
  const phoenixWorkedKeys = input.phoenixWorkedKeys ?? new Set<string>();
  const hrLeaveKeys = input.hrLeaveKeys ?? new Set<string>();
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
  // Per (hrKey|day) count of the employee's OWN (primary-agent) regular visits — tracked
  // separately from the ride-along (double-visit) credit below. A manager who only rides along
  // as the double partner has 0 own visits on that day even though the day still classifies as a
  // worked "VISITS" day. The employee-portal Team Calendar reads this (via cell.ownVisitCount) to
  // show each person's own visit count and to mark a pure ride-along day as a "DV" coaching day,
  // so a manager's row never duplicates the visit counts of the reps they rode along with. The
  // admin matrix/preview is unchanged — this is an additional, purely informational signal.
  const ownRegularCountByHrKeyAndDate = new Map<string, number>();
  // The same day's visits AM · PM · Pharmacies apart (owner, 2026-10-23): the person's own, and — for a manager — the
  // ones he joined as a partner. Display only, read by the portal Team Calendar's square.
  const ownSplitByHrKeyAndDate = new Map<string, VisitCountSplit>();
  const rideAlongSplitByHrKeyAndDate = new Map<string, VisitCountSplit>();
  const addToSplit = (splits: Map<string, VisitCountSplit>, key: string, bucket: VisitCountBucket) => {
    const split = splits.get(key) ?? emptyVisitCountSplit();
    addBucketToSplit(split, bucket);
    splits.set(key, split);
  };
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
    const double2SyncKey = canonicalHrIdKey(visit.double2HrId ?? "");
    if (double2SyncKey) syncResolvedHrKeys.add(double2SyncKey);

    // A row rescued for its PARTNER's sake credits the partner and nobody else: its agent has left
    // and is excluded from every live CRM read. `agentHrId` is already nulled by the read door, but
    // resolveHrKey would otherwise find the departed rep through `agentID` and put a resigned person
    // back on the matrix — the one thing the exclusion exists to prevent.
    const agentKey = visit.partnerCreditOnly === true ? null : resolveHrKey(visit.agentID, visit.agentHrId);
    credit(agentKey, visit);
    if (agentKey && visit.visitType === 0) {
      const ownKey = `${agentKey}|${dayIso}`;
      ownRegularCountByHrKeyAndDate.set(ownKey, (ownRegularCountByHrKeyAndDate.get(ownKey) ?? 0) + 1);
    }
    // A customer or pharmacy call, through the golden rule's one helper — a campaign, meeting or leave row is in no figure.
    const bucket = splitBucketOf(visit);
    if (bucket && agentKey) addToSplit(ownSplitByHrKeyAndDate, `${agentKey}|${dayIso}`, bucket);
    // Slot 1 reaches its partner by HR ID too, not only by CRM id (re-audit, 2026-10-22): a Phoenix
    // double visit's manager may have no CRM account — every hire since the vendor stopped issuing them,
    // and Nahed Tarek's five October double visits — and the old `doubleID != null` gate left that
    // manager's ride-along day uncredited. A CRM id equal to the agent's is still the agent himself.
    let doubleKey: string | null = null;
    if (visit.doubleID == null || visit.doubleID !== visit.agentID) {
      doubleKey = resolveHrKey(visit.doubleID, visit.doubleHrId);
      if (doubleKey && doubleKey !== agentKey) {
        credit(doubleKey, visit);
        if (bucket) addToSplit(rideAlongSplitByHrKeyAndDate, `${doubleKey}|${dayIso}`, bucket);
      }
    }
    // Slot 2, gated on the HR ID and not on a CRM id: a Phoenix chain visit's second manager often has
    // no CRM account, so `resolveHrKey(null, …)` is the only form that reaches him. Nobody's figure
    // moves — `credit` appends the row to that manager's own day, and a day is worked or it is not, so
    // the rep's own count and slot 1's are untouched. Slot 2 can never be filled while slot 1 is empty,
    // so the two keys are always two different people — and the `!== doubleKey` guard makes that a
    // GUARANTEE rather than a reading of the data, because this row lands on a person's day list and a
    // duplicate would count a visit twice for them.
    const double2Key = resolveHrKey(null, visit.double2HrId);
    if (double2Key && double2Key !== agentKey && double2Key !== doubleKey) {
      credit(double2Key, visit);
      if (bucket) addToSplit(rideAlongSplitByHrKeyAndDate, `${double2Key}|${dayIso}`, bucket);
    }
  }

  const header: unknown[] = ["TM", "HR ID", "Hiring Date", "Month", "Year", ...dateIsos];
  const matrix: unknown[][] = [header];
  const identityByHrKey = new Map<string, FieldWorkforceCrmIdentity>();
  const loggingTimingByHrKeyAndDate = new Map<string, FieldWorkforceLoggingTiming>();
  const customerAuthenticityByHrKey = new Map<string, FieldWorkforceCustomerAuthenticity>();
  const avExcuseLabeledKeys = new Set<string>();
  const campaignOverlayKeys = new Set<string>();
  const visitPeriodByHrKeyAndDate = new Map<string, "AM" | "PM" | "MIXED">();

  const eligible = employees
    // Eligible by field-visit title (Medical Rep, DSM, RSM, NSM, PM, GPM, Marketing/Training/SFE
    // Manager) OR by being actively enrolled on a fingerprint device — Head Office staff who
    // don't have a field-eligible title (HR Manager, Admin Assistant, ...) still get a row so
    // their physical office attendance can be cross-checked against CRM "N" days (see
    // attendance-cross-check.ts's punch_no_visits). Device-mapping-only eligibility is purely
    // informational: recommendations.ts's payroll-deduction gate requires title-eligibility on
    // top of this, so a device-mapped-only employee can never generate a deduction candidate.
    .filter((employee) => {
      const hrKey = canonicalHrIdKey(employee.hrId);
      return isFieldWorkforceComplianceEligibleTitle(employee.jobTitle, employee.positionTitle) ||
        (hrKey != null && deviceMappedHrKeys.has(hrKey));
    })
    // Employees who have left the company (resigned/terminated/historical payroll records/
    // system placeholders) are not rendered in the monthly report. Uses the same canonical
    // classifier the rest of the app uses to decide who's active (see isActiveDirectoryEmployee
    // in employee-directory.ts) instead of a bespoke status-string check, so this stays correct
    // as new employment_status values are introduced.
    .filter((employee) => classifyEmployeeNode(employee).eligible_for_headcount)
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
        if (mixedDayHasCampaign(dayVisits)) campaignOverlayKeys.add(`${hrKey}|${dayIso}`);
        const period = computeVisitPeriod(dayVisits);
        if (period) visitPeriodByHrKeyAndDate.set(`${hrKey}|${dayIso}`, period);
      }
      customerAuthenticityByHrKey.set(hrKey, computeCustomerAuthenticitySignals(agentVisits));
    }

    const dayCells = dateIsos.map((dateIso) => {
      const dayVisits = byDay.get(dateIso);
      if (dayVisits && dayVisits.length > 0) return dayCellValue(dayVisits);
      if (isFridayIso(dateIso)) return null;
      if (todayIso && dateIso > todayIso) return null;
      // The mirror view hides Phoenix CRM work until the rep's team is started, so a day Phoenix
      // proves worked is a worked day, not a no-activity candidate.
      if (hrKey && phoenixWorkedKeys.has(`${hrKey}|${dateIso}`)) return "CP";
      // Approved HR leave is the leave record once iReports360 stopped writing its -4 (6 Nov 2026): a leave
      // day, never a no-activity candidate. Worked proof above still wins the day.
      if (hrKey && hrLeaveKeys.has(`${hrKey}|${dateIso}`)) return "AV";
      // Today has not ended: a rep with nothing logged yet is not a no-activity day, so it stays
      // blank like a future day and is never judged (owner, 2026-10-26).
      if (todayIso && dateIso === todayIso) return null;
      return "N";
    });

    matrix.push([
      employee.displayName ?? "",
      employee.hrId,
      employee.hireDate ? String(employee.hireDate).slice(0, 10) : "",
      month,
      year,
      ...dayCells,
    ]);
  }

  return { avExcuseLabeledKeys, campaignOverlayKeys, customerAuthenticityByHrKey, identityByHrKey, loggingTimingByHrKeyAndDate, matrix, ownRegularCountByHrKeyAndDate, ownSplitByHrKeyAndDate, rideAlongSplitByHrKeyAndDate, visitPeriodByHrKeyAndDate };
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

/** One day's regular (customer, visitType 0) visit period from ampm tags: "AM" if every
 * tagged regular visit that day is AM, "PM" if every one is PM, "MIXED" if both appear, or
 * null when there are no regular visits that day or none carry a recognized ampm tag — never
 * guessed from an untagged visit. Non-regular (AV/CP) visits are excluded since they don't
 * drive the "VISITS" status this coloring signal is attached to. */
function computeVisitPeriod(dayVisits: FieldWorkforceMatrixVisit[]): "AM" | "PM" | "MIXED" | null {
  const tags = dayVisits
    .filter((visit) => visit.visitType === 0)
    .map((visit) => normalizeAmpm(visit.ampm))
    .filter((value): value is "AM" | "PM" => value !== null);
  if (tags.length === 0) return null;
  const hasAm = tags.includes("AM");
  const hasPm = tags.includes("PM");
  if (hasAm && hasPm) return "MIXED";
  return hasAm ? "AM" : "PM";
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

function toEmployeeReference(
  employee: DirectoryRow,
  managersAboveByHrId?: ReadonlyMap<string, string[]>,
): FieldWorkforceEmployeeReference {
  return {
    areaName: employee.areaName,
    departmentName: employee.departmentName,
    employmentStatus: employee.employmentStatus,
    fullName: employee.displayName,
    hireDate: employee.hireDate,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lastWorkingDate: employee.lastWorkingDate,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    managerName: employee.managerName,
    managersAbove: managersAboveByHrId?.get(canonicalHrIdKey(employee.hrId) ?? "") ?? null,
    regionName: employee.regionName,
    roleName: employee.positionTitle ?? employee.jobTitle,
    teamName: employee.teamName,
  };
}

async function loadHolidays(month: number, year: number): Promise<{
  calendarReachable: boolean;
  connected: boolean;
  holidays: FieldWorkforceHoliday[];
  message: string | null;
  sourceLabel: string;
}> {
  try {
    const result = await getConfirmedNationalHolidays({ month, year });
    return {
      calendarReachable: result.calendarReachable,
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
      // A thrown lookup is the most degraded state of all — no holidays at all.
      calendarReachable: false,
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
  /** Set by the read door on a row whose agent has left: credit the partner only. */
  partner_credit_only?: boolean;
  agent_name: string | null;
  ampm?: string | null;
  comment?: string | null;
  contact_crm_id?: number | null;
  contact_name?: string | null;
  crm_save_date?: string | null;
  double_crm_id: number | null;
  double_hr_id?: string | null;
  double_name: string | null;
  double2_hr_id?: string | null;
  double2_name?: string | null;
  visit_date: string;
  visit_type: number | null;
};

/** Maps a mirror row (ireports360_visits) onto the matrix-builder visit shape. Carries the
 * mirror's already-resolved agent_hr_id / double_hr_id (visits-report's sync-time
 * override->crm_id->username resolution) so the matrix builder can trust them for identity.
 * The `comment` is carried through because the excuse-labeled-AV detector (dayHasExcuseLabeledAv)
 * reads it to tell a real vacation apart from an "Afternoon Excuse"; other unused CRM fields are
 * left null. visit_type is never null
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
    comment: row.comment ?? null,
    contactID: row.contact_crm_id ?? null,
    contactName: row.contact_name ?? null,
    contactGrade: null,
    customerName: null,
    doubleHrId: row.double_hr_id ?? null,
    double2HrId: row.double2_hr_id ?? null,
    double2Name: row.double2_name ?? null,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    id: 0,
    partnerCreditOnly: row.partner_credit_only === true,
    region: null,
    regionID: null,
    saveDate: row.crm_save_date ?? null,
    speciality: null,
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
  //
  // CREDITING PARTNERS, not the plain scan: a manager's fieldwork lives on the REP's row as its
  // double, so dropping a departed rep's rows outright erased the MANAGER's working day too and
  // charged him a no-activity deduction for it (owner report 2026-10-07). The rescued rows carry
  // `partner_credit_only`, and the credit loop below skips their agent side — so the departed rep
  // is still invisible, exactly as the exclusion intends.
  const rows = await scanVisitsForRangeCreditingPartners<VisitsMirrorRow>({
    dateFrom: startDate,
    dateTo: endDate,
    columns:
      "agent_crm_id, agent_hr_id, agent_name, ampm, comment, contact_crm_id, contact_name, crm_save_date, " +
      "double_crm_id, double_hr_id, double_name, double2_hr_id, double2_name, visit_date, visit_type",
  });
  // scanVisitsForRange (unlike crm/reads' getDoubleVisitRows) returns EVERY visit, single and
  // double alike, so the collapse is applied here rather than inside the shared scanner. It keys
  // on the CONTACT (see collapseDuplicateVisitSubmissions) — one rep, one contact, one day, one
  // visit type is one real stop — so it applies to single-agent rows too, and rows naming
  // different contacts are always kept as the separate real visits they are.
  return collapseDuplicateVisitSubmissions(rows);
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

  // Best-effort here, unlike the deduction connectors: this matrix is a review surface and the
  // connectors apply their own Phoenix suppressor before any money moves. A failed read degrades
  // to a warning that says "N" days may include Phoenix work, never to a silent empty answer.
  let phoenixWorkedKeys = new Set<string>();
  let phoenixEvidenceWarning: { code: string; message: string; severity: "warning" } | null = null;
  try {
    phoenixWorkedKeys = phoenixWorkedDayKeySet(
      await loadPhoenixWorkEvidenceDays({ end: endDate, start: startDate }),
      (hrId) => canonicalHrIdKey(hrId),
    );
  } catch (error) {
    phoenixEvidenceWarning = {
      code: "phoenix_work_evidence_unavailable",
      message: `Phoenix CRM work could not be read this month: ${error instanceof Error ? error.message : "read failed"}. A no-activity day may be a day worked in Phoenix CRM.`,
      severity: "warning",
    };
  }

  // A MANAGER'S OWN SINGLE VISITS are a worked day too (owner, 2026-10-19: "proof he worked the day"). They
  // sit in phoenix_crm_manager_visits, outside the mirror and the work-evidence read. Best-effort, like the
  // Phoenix read above: a failure says so and never empties the Phoenix days already read.
  let managerOwnVisitWarning: { code: string; message: string; severity: "warning" } | null = null;
  try {
    for (const day of await loadManagerOwnVisitDays({ end: endDate, start: startDate })) {
      const hrKey = day.visits > 0 ? canonicalHrIdKey(day.hrId) : null;
      if (hrKey) phoenixWorkedKeys.add(`${hrKey}|${day.date}`);
    }
  } catch (error) {
    managerOwnVisitWarning = {
      code: "manager_own_visits_unavailable",
      message: `A manager's own Phoenix CRM visits could not be read this month: ${error instanceof Error ? error.message : "read failed"}. A no-activity day may be a day of the manager's own visits.`,
      severity: "warning",
    };
  }

  // APPROVED HR LEAVE, from the day iReports360 was retired (crm/hr-leave-days.ts) — the leave record once
  // nothing writes the -4 code. Read for the directory's people, so the read is batched.
  let hrLeaveKeys = new Set<string>();
  let hrLeaveWarning: { code: string; message: string; severity: "warning" } | null = null;
  try {
    const { days } = await loadFieldLeaveDaysFromHr({
      employeeHrIds: directory.map((employee) => employee.hrId).filter((hrId): hrId is string => Boolean(hrId)),
      end: endDate,
      start: startDate,
    });
    hrLeaveKeys = new Set(
      [...days].flatMap(([hrId, dates]) => {
        const hrKey = canonicalHrIdKey(hrId);
        return hrKey ? [...dates].map((date) => `${hrKey}|${date}`) : [];
      }),
    );
  } catch (error) {
    hrLeaveWarning = {
      code: "hr_leave_unavailable",
      message: `Approved HR leave could not be read this month: ${error instanceof Error ? error.message : "read failed"}. A no-activity day from 6 Nov 2026 may be an approved leave day.`,
      severity: "warning",
    };
  }

  // Head Office / office-based staff earn a Team Calendar row via fingerprint device
  // enrollment rather than a field-eligible title (see the `eligible` filter comment in
  // buildIReports360FieldWorkforceMatrix). Best-effort: loadActiveDeviceMappedHrIds normalizes
  // via a different helper than canonicalHrIdKey, so its output is re-canonicalized before use
  // (same pattern as attendance-cross-check.ts / head-office-attendance.ts). A failure here
  // degrades to a warning rather than breaking the whole preview.
  let deviceMappedHrKeys = new Set<string>();
  let deviceMappedWarning: { code: string; message: string; severity: "warning" } | null = null;
  try {
    const rawDeviceMapped = await loadActiveDeviceMappedHrIds();
    deviceMappedHrKeys = new Set(
      [...rawDeviceMapped].map((id) => canonicalHrIdKey(id)).filter((key): key is string => Boolean(key)),
    );
  } catch (error) {
    deviceMappedWarning = {
      code: "device_mapped_eligibility_unavailable",
      message: `Head Office fingerprint-based eligibility could not be loaded this month: ${error instanceof Error ? error.message : "device mapping lookup failed"}. Office staff without a field-eligible title may be temporarily missing from the Team Calendar.`,
      severity: "warning",
    };
  }

  const { avExcuseLabeledKeys, campaignOverlayKeys, customerAuthenticityByHrKey, identityByHrKey, loggingTimingByHrKeyAndDate, matrix, ownRegularCountByHrKeyAndDate, ownSplitByHrKeyAndDate, rideAlongSplitByHrKeyAndDate, visitPeriodByHrKeyAndDate } = buildIReports360FieldWorkforceMatrix({
    deviceMappedHrKeys,
    employees: directory,
    hrLeaveKeys,
    month,
    phoenixWorkedKeys,
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
    // The whole reporting chain, so the Manager filter reaches a National Sales Manager (owner, 2026-10-20).
    employeeReferences: (() => {
      const managersAboveByHrId = buildManagersAboveByHrId(directory, canonicalHrIdKey);
      return directory.map((employee) => toEmployeeReference(employee, managersAboveByHrId));
    })(),
    holidayCalendarReachable: holidays.calendarReachable,
    holidayConnected: holidays.connected,
    holidayMessage: holidays.message,
    holidaySourceLabel: holidays.sourceLabel,
    holidays: holidays.holidays,
    parsed,
    todayIso: input.todayIso ?? null,
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
      const visitPeriod = hrKey ? visitPeriodByHrKeyAndDate.get(`${hrKey}|${cell.dateIso}`) ?? null : null;
      const campaignOverlay = hrKey ? campaignOverlayKeys.has(`${hrKey}|${cell.dateIso}`) : false;
      // Own (primary-agent) regular-visit count for a worked "VISITS" day: 0 means the day is
      // classified as VISITS purely from ride-along (double-visit) credit. Only meaningful on a
      // VISITS day; left undefined elsewhere so it never widens a non-VISITS cell. The portal
      // Team Calendar reads it; the admin surface ignores it (see FieldWorkforceDayCell.ownVisitCount).
      const ownVisitCount = hrKey && cell.status === "VISITS"
        ? ownRegularCountByHrKeyAndDate.get(`${hrKey}|${cell.dateIso}`) ?? 0
        : undefined;
      const ownVisitSplit = hrKey && cell.status === "VISITS" ? ownSplitByHrKeyAndDate.get(`${hrKey}|${cell.dateIso}`) ?? emptyVisitCountSplit() : undefined;
      const rideAlongSplit = hrKey && cell.status === "VISITS" ? rideAlongSplitByHrKeyAndDate.get(`${hrKey}|${cell.dateIso}`) : undefined;
      if (!timing && !isExcuseLabeledAv && !visitPeriod && !campaignOverlay && ownVisitCount === undefined) return cell;
      return {
        ...cell,
        ...(ownVisitSplit ? { ownVisitSplit } : {}),
        ...(rideAlongSplit ? { rideAlongSplit } : {}),
        ...(timing ? { loggingTiming: timing } : {}),
        ...(isExcuseLabeledAv ? { isExcuseLabeledAv: true } : {}),
        ...(visitPeriod ? { visitPeriod } : {}),
        ...(campaignOverlay ? { campaignOverlay: true } : {}),
        ...(ownVisitCount !== undefined ? { ownVisitCount } : {}),
      };
    });
    const loggingTimingSummary = summarizeLoggingTiming(timeline);
    const customerAuthenticity = hrKey ? customerAuthenticityByHrKey.get(hrKey) ?? null : null;
    // campaignDays is computed by the classifier BEFORE campaignOverlay is attached above, so a
    // mixed day (now VISITS + overlay) would otherwise be dropped from it. Recompute here on the
    // enriched timeline with the same rule as the classifier (pure CP OR mixed-with-overlay).
    const campaignDays = timeline.filter((cell) => !cell.ignored && (cell.status === "CP" || cell.campaignOverlay === true)).length;

    return { ...employee, campaignDays, crmIdentity: identity, customerAuthenticity, loggingTimingSummary, timeline };
  });

  const warnings = [...preview.warnings];
  if (deviceMappedWarning) warnings.push(deviceMappedWarning);
  if (phoenixEvidenceWarning) warnings.push(phoenixEvidenceWarning);
  if (managerOwnVisitWarning) warnings.push(managerOwnVisitWarning);
  if (hrLeaveWarning) warnings.push(hrLeaveWarning);
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
