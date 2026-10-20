// HR Daily & Weekly Reports — the FIELD FORCE section: one line per person per field day, from the
// CRM visits, Saturday to Thursday.
//
// TWO QUESTIONS, TWO ENGINES, NEITHER RE-WRITTEN HERE.
//   - "Was he seen at all?" is the Field Absence Calendar's question (src/lib/field-absence/): its
//     roster is the organogram's dated seat history, its evidence is every source that proves a day
//     (visits, a manager's own visits, leave, trips, punches, holidays), and `buildFieldAbsenceCalendar`
//     decides which days were judged and which were not seen. A not-seen day is the one flag here,
//     `no_field_activity`, weighed by the field-workforce weekly rule (Thursday is half a day).
//     When any evidence source is unreadable the calendar judges nobody, and so does this report.
//   - "What did he do?" is counted from the CRM visits: AM, PM and Pharmacies apart (the golden rule
//     of 2026-09-21, `visitCountBucket`), the first and last visit time, and the month to date.
//
// 🔒 A MANAGER'S OWN SINGLE VISITS COUNT IN HIS OWN ROW, AND IN NOBODY ELSE'S. The owner, 2026-10-20,
// shown a manager with six own visits on a day: "Show the 6 visits". They are read through
// `loadManagerOwnVisitRows` (the ONLY door out of phoenix_crm_manager_visits — module memory,
// phoenix-crm-manager-plan), and they fill the AM / PM / Pharmacies buckets, the first and last visit
// times and the month to date of the manager they belong to. They prove his day as well (the field
// absence evidence already reads them), so he is never flagged for a day he spent on them. They are
// NEVER credited to a rep's row and never added to any KPI, coverage or call-rate figure: this report
// is the only reader that counts them, and only on his own line. ONE switch below,
// `MANAGER_OWN_VISITS_COUNT_IN_OWN_ROW`, pinned by tests/hr-ops-reports.test.ts.
//
// Product managers and anyone else who logged a visit get a line on the days they have one, and
// are never flagged: the absence engine does not judge them.

import { CRM_DOUBLE_VISIT_TYPE_CODES, queryOwnVisitsOfDepartedAgents, resolveVisitTime, scanVisitsForRangeCreditingPartners } from "@/lib/crm/reads";
import { isPharmacyVisitRow, visitCountBucket, type VisitCountBucket } from "@/lib/crm/visit-count-buckets";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { parseListType, PHARMACY_LIST_TYPE } from "@/lib/phoenix-crm/pharmacy-call-rules";
import {
  buildFieldAbsenceCalendar,
  FIELD_ABSENCE_SOURCE_LABELS,
  FIELD_ABSENCE_TIER_LABELS,
  spanCovers,
  type FieldAbsenceCalendar,
  type FieldAbsencePerson,
  type FieldAbsenceSeatSpan,
} from "@/lib/field-absence/rules";
import { loadFieldAbsenceEvidence } from "@/lib/field-absence/server/evidence";
import { loadFieldAbsenceRoster, loadFieldAbsenceSeats } from "@/lib/field-absence/server/roster";
import { sumDetectedDeductionDayWeights } from "@/lib/field-workforce-compliance/weekend-policy";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { loadManagerOwnVisitRows } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadProductManagerRoster } from "@/lib/phoenix-crm/server/manager-plan-writers";

import { eachDay, monthStartOf } from "./periods";
import type { HrOpsFieldMetrics, HrOpsLineDraft, HrOpsSectionBuild } from "./types";

/**
 * 🔒 THE OWNER'S CHOICE, 2026-10-20 — "Show the 6 visits". A manager's own single visits count in
 * that manager's OWN row: AM / PM / Pharmacies, first and last visit time, month to date. Never in a
 * rep's row. Turning this off takes them out of his counts and leaves every other figure as it is.
 */
export const MANAGER_OWN_VISITS_COUNT_IN_OWN_ROW = true;

/** The visit columns this section reads from the CRM door — every one of them read below. */
export const FIELD_VISIT_COLUMNS =
  "id, visit_date, agent_hr_id, double_hr_id, double2_hr_id, ampm, speciality, visit_type, visit_type_description, comment, source, crm_visit_id, contact_crm_id, crm_save_date";

type CrmVisitRow = {
  id?: string | null;
  visit_date?: string | null;
  agent_hr_id?: string | null;
  double_hr_id?: string | null;
  double2_hr_id?: string | null;
  ampm?: string | null;
  speciality?: string | null;
  visit_type?: number | null;
  visit_type_description?: string | null;
  comment?: string | null;
  source?: string | null;
  crm_visit_id?: number | null;
  crm_save_date?: string | null;
};

/** One counted visit, already resolved to whom it credits. */
export type CountedVisit = {
  date: string;
  bucket: VisitCountBucket;
  /** Cairo wall-clock "HH:MM", or null when the visit recorded no real time. */
  time: string | null;
  /** The person keys (canonical, upper case) this visit counts for. */
  creditKeys: string[];
  /** True for a manager's own single visit — it counts for that manager alone. */
  own: boolean;
};

export type FieldDirectoryEntry = {
  name: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  managerName: string | null;
};

const personKey = (hrId: string | null | undefined): string | null => canonicalHrIdForDisplay(hrId);

/** A CRM visit counts when it is a real visit (regular or double) or a pharmacy visit. */
export function isCountedCrmVisit(row: Pick<CrmVisitRow, "visit_type" | "ampm" | "speciality" | "comment" | "visit_type_description" | "source" | "crm_visit_id">): boolean {
  const type = row.visit_type;
  if (type !== null && type !== undefined && (CRM_DOUBLE_VISIT_TYPE_CODES as readonly number[]).includes(Number(type))) return true;
  return isPharmacyVisitRow(row);
}

/**
 * The CRM save time as the clock printed it. `crm_save_date` is already Cairo wall-clock, so it is
 * read as stored and NEVER shifted by a timezone — doing so moves every visit two or three hours.
 */
export function wallClockTime(value: string | null | undefined): string | null {
  const resolved = resolveVisitTime({ crmSaveDate: value ?? null }).time;
  const match = /[T ](\d{2}):(\d{2})/.exec(String(resolved ?? ""));
  return match ? `${match[1]}:${match[2]}` : null;
}

const CAIRO_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo" });

/** A true instant (a manager's own visit `loggedAt`) printed on the Cairo clock. */
export function cairoClockTime(instant: string | null | undefined): string | null {
  if (!instant) return null;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  return CAIRO_TIME.format(parsed);
}

/** The CRM rows, merged, counted and resolved to the people they credit. */
export function countCrmVisits(rows: readonly CrmVisitRow[]): CountedVisit[] {
  const out: CountedVisit[] = [];
  for (const row of rows) {
    const date = String(row.visit_date ?? "").slice(0, 10);
    if (!date || !isCountedCrmVisit(row)) continue;
    const creditKeys = [...new Set([row.agent_hr_id, row.double_hr_id, row.double2_hr_id].map(personKey).filter((key): key is string => Boolean(key)))];
    if (creditKeys.length === 0) continue;
    out.push({ bucket: visitCountBucket(row), creditKeys, date, own: false, time: wallClockTime(row.crm_save_date) });
  }
  return out;
}

/** A manager's own visits, as counted visits that credit him and nobody else. */
export function countOwnVisits(rows: ReadonlyArray<{ managerHrId: string; date: string; bucket: string; loggedAt: string | null }>): CountedVisit[] {
  const out: CountedVisit[] = [];
  for (const row of rows) {
    const key = personKey(row.managerHrId);
    if (!key || !row.date) continue;
    // The one list_type parser: a pharmacy is a third list, never swallowed into AM or PM.
    const listType = parseListType(row.bucket);
    const bucket: VisitCountBucket = listType === PHARMACY_LIST_TYPE ? "Pharmacies" : listType;
    out.push({ bucket, creditKeys: [key], date: row.date.slice(0, 10), own: true, time: cairoClockTime(row.loggedAt) });
  }
  return out;
}

function spanOn(person: FieldAbsencePerson, day: string): FieldAbsenceSeatSpan | null {
  let found: FieldAbsenceSeatSpan | null = null;
  for (const span of person.spans) {
    if (spanCovers(span, day) && (!found || span.from >= found.from)) found = span;
  }
  return found;
}

type DayTally = { am: number; pm: number; pharmacies: number; own: number; first: string | null; last: string | null };

export type FieldLinesInput = {
  start: string;
  end: string;
  /** The Cairo day the report is built on — a day not yet over is never flagged. */
  today: string;
  people: readonly FieldAbsencePerson[];
  calendar: Pick<FieldAbsenceCalendar, "judged" | "people">;
  /** Person key → day → what the evidence recorded for him (for the line's "seen as"). */
  seen: ReadonlyMap<string, ReadonlyMap<string, string>>;
  productManagerKeys: ReadonlySet<string>;
  directory: ReadonlyMap<string, FieldDirectoryEntry>;
  /** Every counted visit from the first of the month of `start` through `end`. */
  visits: readonly CountedVisit[];
  /** Defaults to the owner's switch; a test passes it to pin both sides. */
  managerOwnVisitsCountInOwnRow?: boolean;
};

/** The field lines. Pure — the loader below gathers the facts. */
export function buildFieldLines(input: FieldLinesInput): HrOpsLineDraft[] {
  const countOwn = input.managerOwnVisitsCountInOwnRow ?? MANAGER_OWN_VISITS_COUNT_IN_OWN_ROW;
  const window = new Set(eachDay(input.start, input.end));
  const tallies = new Map<string, Map<string, DayTally>>();
  const perDayCount = new Map<string, Map<string, number>>();

  for (const visit of input.visits) {
    if (visit.own && !countOwn) continue;
    // A manager's own visit credits exactly the manager it belongs to — countOwnVisits builds it with
    // one key, and this guard keeps it so whatever a caller hands in.
    const keys = visit.own ? visit.creditKeys.slice(0, 1) : visit.creditKeys;
    for (const key of keys) {
      const counts = perDayCount.get(key) ?? new Map<string, number>();
      counts.set(visit.date, (counts.get(visit.date) ?? 0) + 1);
      perDayCount.set(key, counts);
      if (!window.has(visit.date)) continue;
      const byDay = tallies.get(key) ?? new Map<string, DayTally>();
      const tally = byDay.get(visit.date) ?? { am: 0, first: null, last: null, own: 0, pharmacies: 0, pm: 0 };
      if (visit.bucket === "AM") tally.am += 1;
      else if (visit.bucket === "PM") tally.pm += 1;
      else tally.pharmacies += 1;
      if (visit.own) tally.own += 1;
      if (visit.time) {
        if (!tally.first || visit.time < tally.first) tally.first = visit.time;
        if (!tally.last || visit.time > tally.last) tally.last = visit.time;
      }
      byDay.set(visit.date, tally);
      tallies.set(key, byDay);
    }
  }

  const monthToDate = (key: string, day: string): number => {
    const counts = perDayCount.get(key);
    if (!counts) return 0;
    const from = monthStartOf(day);
    let total = 0;
    for (const [date, count] of counts) if (date >= from && date <= day) total += count;
    return total;
  };

  const summaries = new Map(input.calendar.people.map((person) => [person.key, person]));
  const lines: HrOpsLineDraft[] = [];

  const lineFor = (key: string, day: string, who: {
    name: string;
    tierLabel: string | null;
    jobTitle: string | null;
    lineName: string | null;
    areaName: string | null;
    managerName: string | null;
  }, absent: boolean): HrOpsLineDraft | null => {
    const hrKey = canonicalHrIdKey(key);
    if (!hrKey) return null;
    const tally = tallies.get(key)?.get(day) ?? null;
    const notes: string[] = [];
    const seenAs = input.seen.get(key)?.get(day) ?? null;
    if (tally && tally.own > 0) {
      notes.push(`Includes ${tally.own} of the manager's own single ${tally.own === 1 ? "visit" : "visits"} — counted in this row only.`);
    }
    const total = tally ? tally.am + tally.pm + tally.pharmacies : 0;
    const metrics: HrOpsFieldMetrics = {
      am: tally?.am ?? 0,
      firstVisit: tally?.first ?? null,
      kind: "field",
      lastVisit: tally?.last ?? null,
      monthToDate: monthToDate(key, day),
      monthToDateFrom: monthStartOf(day),
      notes,
      ownVisits: tally?.own ?? 0,
      pharmacies: tally?.pharmacies ?? 0,
      pm: tally?.pm ?? 0,
      seenAs: total > 0 ? null : seenAs,
      tierLabel: who.tierLabel,
      total,
    };
    return {
      areaName: who.areaName,
      employeeName: who.name,
      flags: absent ? ["no_field_activity"] : [],
      hrId: key,
      hrKey,
      jobTitle: who.jobTitle,
      lineName: who.lineName,
      managerName: who.managerName,
      metrics,
      section: "field",
      // Thursday is half a field day; every other surviving day is a whole one.
      suggestedDays: absent ? sumDetectedDeductionDayWeights([day]) : null,
      workDate: day,
    };
  };

  const covered = new Set<string>();
  for (const person of input.people) {
    covered.add(person.key);
    const summary = summaries.get(person.key);
    const judgedDates = new Set(summary?.judgedDates ?? []);
    const notSeen = new Set(summary?.notSeenDates ?? []);
    const directoryEntry = input.directory.get(person.key);
    for (const day of window) {
      const hasVisits = (tallies.get(person.key)?.get(day) ?? null) !== null;
      if (!judgedDates.has(day) && !hasVisits) continue;
      const span = spanOn(person, day);
      const absent = input.calendar.judged && notSeen.has(day) && day < input.today;
      const line = lineFor(person.key, day, {
        areaName: span?.areaName ?? directoryEntry?.areaName ?? null,
        jobTitle: directoryEntry?.jobTitle ?? null,
        lineName: span?.lineName ?? directoryEntry?.lineName ?? null,
        managerName: span?.managerName ?? directoryEntry?.managerName ?? null,
        name: person.name,
        tierLabel: span ? FIELD_ABSENCE_TIER_LABELS[span.tier] : null,
      }, absent);
      if (line) {
        if (!input.calendar.judged && judgedDates.has(day)) line.metrics.notes.push("Not judged: a source the absence check needs could not be read.");
        lines.push(line);
      }
    }
  }

  // Product managers and every other visitor: a line on each day they have a visit, never a flag.
  for (const [key, byDay] of tallies) {
    if (covered.has(key)) continue;
    const entry = input.directory.get(key);
    for (const day of byDay.keys()) {
      const line = lineFor(key, day, {
        areaName: entry?.areaName ?? null,
        jobTitle: entry?.jobTitle ?? null,
        lineName: entry?.lineName ?? null,
        managerName: entry?.managerName ?? null,
        name: entry?.name ?? key,
        tierLabel: input.productManagerKeys.has(key) ? "Product manager" : null,
      }, false);
      if (line) lines.push(line);
    }
  }

  return lines.sort((left, right) =>
    left.workDate.localeCompare(right.workDate)
    || (left.lineName ?? "").localeCompare(right.lineName ?? "")
    || left.employeeName.localeCompare(right.employeeName));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the field lines for `start` .. `end`. The visit counts are the section: when the CRM visits
 * cannot be read the section is left empty with the reason named, never printed as a field force of
 * zeroes. Every other source degrades alone, and says so.
 */
export async function buildFieldSection(input: { start: string; end: string; today: string }): Promise<HrOpsSectionBuild> {
  const warnings: string[] = [];
  const scanFrom = monthStartOf(input.start);

  let people: FieldAbsencePerson[] = [];
  try {
    const seats = await loadFieldAbsenceSeats();
    people = await loadFieldAbsenceRoster({ end: input.end, seats, start: input.start, today: input.today });
  } catch (error) {
    warnings.push(`Field force: the organogram seats could not be read (${errorText(error)}), so nobody was judged for absence.`);
  }
  const departed = people.filter((person) => !person.employmentActive).map((person) => person.key);

  const [evidenceResult, scanResult, departedResult, productManagersResult, directoryResult] = await Promise.allSettled([
    loadFieldAbsenceEvidence({ departedHrIds: departed, end: input.end, hrIds: people.map((person) => person.key), start: input.start }),
    scanVisitsForRangeCreditingPartners<CrmVisitRow>({ columns: FIELD_VISIT_COLUMNS, dateFrom: scanFrom, dateTo: input.end }),
    queryOwnVisitsOfDepartedAgents<CrmVisitRow>({ columns: FIELD_VISIT_COLUMNS, dateFrom: scanFrom, dateTo: input.end, hrIds: departed }),
    loadProductManagerRoster(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  if (scanResult.status !== "fulfilled") {
    return { lines: [], warnings: [...warnings, `Field force: the CRM visits could not be read (${errorText(scanResult.reason)}), so this section is empty.`] };
  }

  // A departed agent's own rows come back beside the partner-crediting scan, which carries the same
  // row with the agent stripped — keep one copy, the one that still names him.
  const byId = new Map<string, CrmVisitRow>();
  const anonymous: CrmVisitRow[] = [];
  for (const row of scanResult.value) {
    if (row.id) byId.set(row.id, row);
    else anonymous.push(row);
  }
  if (departedResult.status === "fulfilled") {
    for (const row of departedResult.value) {
      if (row.id) byId.set(row.id, row);
      else anonymous.push(row);
    }
  } else {
    warnings.push("Field force: the visits of people who have since left could not be read, so their own visits may be missing.");
  }
  const visits = countCrmVisits([...byId.values(), ...anonymous]);

  const productManagerKeys = new Set(
    (productManagersResult.status === "fulfilled" ? productManagersResult.value : [])
      .map((planner) => personKey(planner.hrId))
      .filter((key): key is string => Boolean(key)),
  );

  if (MANAGER_OWN_VISITS_COUNT_IN_OWN_ROW) {
    const managerKeys = [...new Set([...people.map((person) => person.key), ...productManagerKeys])];
    try {
      visits.push(...countOwnVisits(await loadManagerOwnVisitRows({ end: input.end, managerHrIds: managerKeys, start: scanFrom })));
    } catch (error) {
      warnings.push(`Field force: managers' own single visits could not be read (${errorText(error)}), so they are missing from the managers' rows.`);
    }
  }

  const directory = new Map<string, FieldDirectoryEntry>();
  if (directoryResult.status === "fulfilled") {
    // Names, titles and places only — nothing else of the directory row is copied.
    for (const row of directoryResult.value) {
      const key = personKey(row.hrId);
      if (!key) continue;
      directory.set(key, {
        areaName: row.areaName ?? null,
        jobTitle: row.jobTitle ?? null,
        lineName: row.lineName ?? null,
        managerName: row.managerName ?? null,
        name: row.displayName || row.fullName || key,
      });
    }
  } else {
    warnings.push("Field force: the employee directory could not be read, so some names and titles are missing.");
  }

  let calendar: Pick<FieldAbsenceCalendar, "judged" | "people"> = { judged: false, people: [] };
  let seen: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();
  if (evidenceResult.status === "fulfilled") {
    const evidence = evidenceResult.value;
    seen = evidence.seen;
    calendar = buildFieldAbsenceCalendar({ end: input.end, evidence, people, start: input.start, today: input.today });
    if (!calendar.judged) {
      const labels = evidence.unreadable.map((source) => FIELD_ABSENCE_SOURCE_LABELS[source]).join(", ");
      warnings.push(`Field force: ${labels} could not be read, so nobody was flagged for absence.`);
    }
  } else if (people.length > 0) {
    warnings.push(`Field force: the absence evidence could not be read (${errorText(evidenceResult.reason)}), so nobody was flagged for absence.`);
  }

  return {
    lines: buildFieldLines({ calendar, directory, end: input.end, people, productManagerKeys, seen, start: input.start, today: input.today, visits }),
    warnings,
  };
}
