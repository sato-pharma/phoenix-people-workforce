/**
 * Field Absence Calendar — the rule, pure.
 *
 * The owner, 2026-10-18: *"On every day of a working day that the system did not see a rep or a
 * district manager or any title in the field force, it shows his name … no submit vacation, no
 * records for this day, or double visit or anything. We didn't see him at all."* Asked the four
 * questions that change the outcome, he answered the same day:
 *
 *   - WHO: everyone on a field seat — rep, acting DM, DM and RSM — and, by his follow-up the same
 *     day, the National Sales Managers too: *"he punched, then this means that he came to office …
 *     show his name if no field work, no punch, no vacation, no anything."* So a fingerprint punch is
 *     a record like any other, for everyone on the calendar.
 *   - THURSDAY: listed, tagged as a half day (his 2026-08-02 rule: Thursday morning is worked).
 *   - TODAY: shown as "so far", final the next morning.
 *   - NO ALERT: the page only, nothing is sent to anyone.
 *
 * A name appears on a day only when ALL of these hold:
 *
 *   1. He held a field seat that day (the EU organogram's dated occupancy, half-open [from, to)) and
 *      was employed (hire date to last working date). A joiner, a leaver and a transfer are judged
 *      only on the days they really held the seat.
 *   2. It was a working day FOR HIM: not a national holiday, and not his weekly day off through
 *      `isFieldWorkforceWeeklyOff` — the one home of that rule — which takes Friday for everyone and
 *      Saturday as well for anyone who is not a rep or a district manager. The seat, never the
 *      free-text job title, decides which of those he is.
 *   3. It is not a future day.
 *   4. No source recorded anything for him that day. The sources are fused into `evidence.seen` by
 *      the server half; this file only asks whether the day is in it.
 *
 * 🔴 AN UNREADABLE SOURCE LISTS NOBODY. If the CRM, the vacation table or the trip tables could not
 * be read, every name on the page would be an accusation the system cannot back, so the calendar is
 * returned unjudged — the screen says which source failed instead of drawing a company of absentees.
 *
 * Date-only throughout: every date here is a calendar day, walked at UTC midnight. Do not "fix" this
 * file to Africa/Cairo — the Cairo day is decided once, by the caller, in `today`.
 */

import {
  isFieldWorkforceThursday,
  isFieldWorkforceWeeklyOff,
} from "@/lib/field-workforce-compliance/weekend-policy";

export const FIELD_ABSENCE_TIERS = ["REP", "ACTING_DM", "DM", "RSM", "NSM"] as const;
export type FieldAbsenceTier = (typeof FIELD_ABSENCE_TIERS)[number];

export const FIELD_ABSENCE_TIER_LABELS: Record<FieldAbsenceTier, string> = {
  ACTING_DM: "Acting DM",
  DM: "DM",
  NSM: "NSM",
  REP: "Rep",
  RSM: "RSM",
};

/**
 * The title the weekly-off rule reads, taken from the SEAT. `isFieldWorkforceWeeklyOff` keys the
 * Saturday decision on a rep or district-manager title; an acting DM sits on a rep's terms (her job
 * title is Medical Representative), and the Regional and National Sales Managers are off on Saturday.
 */
const WEEKLY_OFF_TITLE: Record<FieldAbsenceTier, string> = {
  ACTING_DM: "Medical Representative",
  DM: "District Manager",
  NSM: "National Sales Manager",
  REP: "Medical Representative",
  RSM: "Regional Sales Manager",
};

export function isFieldAbsenceTier(value: unknown): value is FieldAbsenceTier {
  return typeof value === "string" && (FIELD_ABSENCE_TIERS as readonly string[]).includes(value);
}

/** One dated stretch of one field seat. */
export type FieldAbsenceSeatSpan = {
  seatId: string;
  tier: FieldAbsenceTier;
  lineCode: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  /** Whoever sat above him at the end of the stretch (or today), for the screen only. */
  managerName: string | null;
  /** First day held, inclusive. */
  from: string;
  /** First day NO LONGER held — half-open, as the organogram dates it. Null while still held. */
  to: string | null;
};

export type FieldAbsencePerson = {
  /** The canonical HR id (trimmed, upper-case, aliases folded) — the key every source is matched on. */
  key: string;
  name: string;
  hireDate: string | null;
  lastWorkingDate: string | null;
  /** False once his employment status is no longer active (resigned, terminated …), even while he
   * still serves his notice on the seat. The CRM's default read hides every visit such a person filed
   * himself, so the evidence reads his own visits separately (`server/evidence.ts`). */
  employmentActive: boolean;
  spans: FieldAbsenceSeatSpan[];
};

export type FieldAbsenceSource = "crm" | "leave" | "trips" | "punch";

export const FIELD_ABSENCE_SOURCE_LABELS: Record<FieldAbsenceSource, string> = {
  crm: "CRM visits (the old CRM and Phoenix CRM, double visits and a manager's own single visits included)",
  leave: "vacation requests",
  trips: "business trips",
  punch: "fingerprint punches",
};

export type FieldAbsenceEvidence = {
  /** Person key → day → what the system recorded for him that day (the first label kept). */
  seen: Map<string, Map<string, string>>;
  /** Sources that could not be read. Any entry here leaves the calendar unjudged. */
  unreadable: FieldAbsenceSource[];
  holidays: ReadonlySet<string>;
  /** False when the national-holiday calendar could not be read in full. */
  holidaysComplete: boolean;
};

export type FieldAbsenceDayKind = "working" | "weekly-off" | "holiday" | "future";

export type FieldAbsenceEntry = {
  key: string;
  name: string;
  tier: FieldAbsenceTier;
  tierLabel: string;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  managerName: string | null;
  /** Not seen on ANY working day of the period — see `WHOLE_PERIOD_MIN_DAYS`. */
  wholePeriod: boolean;
};

export type FieldAbsenceDay = {
  date: string;
  kind: FieldAbsenceDayKind;
  /** Thursday — worked in the morning only, by the owner's 2026-08-02 rule. */
  halfDay: boolean;
  /** Today: names can still drop off as records arrive. */
  provisional: boolean;
  /** People the day was judged for (on a seat, employed, not on their weekly off). */
  expected: number;
  notSeen: FieldAbsenceEntry[];
};

export type FieldAbsencePersonSummary = Omit<FieldAbsenceEntry, "wholePeriod"> & {
  wholePeriod: boolean;
  /** FINISHED working days he was judged on. Today has not ended, so it is never one of them. */
  expectedDays: number;
  /** The same days, by date — so a screen that hides one person can take him out of each day's count. */
  judgedDates: string[];
  /** Finished working days with nothing recorded; today is never one of them. */
  notSeenDates: string[];
  /** Today is a working day for him — it sits in today's box as "so far", outside the counts above. */
  expectedToday: boolean;
  /** Nothing recorded for him so far today. Never part of notSeenDates (owner, 2026-10-26). */
  notSeenToday: boolean;
  /** Every day in the period the system recorded something for him while he held a seat on this
   * calendar and was employed, working day or not — a day on another line's seat, or after he left,
   * is not this calendar's to show. */
  seenDates: string[];
  /** The longest run of FINISHED working days in a row with nothing recorded. */
  longestRun: number;
  lastSeen: string | null;
  /** What the system recorded on `lastSeen` — "CRM visit", "Annual Vacation", "Fingerprint punch at 09:14". */
  lastSeenLabel: string | null;
};

export type FieldAbsenceCalendar = {
  start: string;
  end: string;
  today: string;
  /** False when a source was unreadable — then nobody is listed anywhere. */
  judged: boolean;
  unreadable: FieldAbsenceSource[];
  holidaysComplete: boolean;
  days: FieldAbsenceDay[];
  /** Everyone judged on at least one day, most days not seen first. */
  people: FieldAbsencePersonSummary[];
};

/**
 * How many FINISHED working days must pass before "not seen on any of them" means something. On the
 * second of a month a person missing one day is not a pattern, and naming him as "not seen at all
 * this period" would be the loudest label on the page resting on a single day.
 */
export const WHOLE_PERIOD_MIN_DAYS = 3;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Every day from `start` to `end` inclusive. Capped so a malformed pair cannot run away. */
export function eachDay(start: string, end: string): string[] {
  if (!isIsoDay(start) || !isIsoDay(end) || end < start) return [];
  const out: string[] = [];
  for (let day = start; day <= end && out.length < 62; day = addDays(day, 1)) out.push(day);
  return out;
}

function weekday(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

/** The Saturday that opens the week holding `dateIso` — Egypt's working week starts on Saturday. */
export function fieldAbsenceWeekStart(dateIso: string): string {
  return addDays(dateIso, -((weekday(dateIso) + 1) % 7));
}

/**
 * Someone who DECLINED THE OFFER never started work, so a seat stretch the organogram still carries
 * for him is not a day he failed to show up. The same status `hires-in-window.ts` and the half-day
 * deduction connector skip. A decline HR chose to pay is filed as `terminated` instead, and is
 * judged on the days he held the seat like any other leaver.
 */
export function fieldAbsenceNeverStarted(employmentStatus: string | null | undefined): boolean {
  return String(employmentStatus ?? "").trim().toLowerCase() === "declined_offer";
}

export function spanCovers(span: Pick<FieldAbsenceSeatSpan, "from" | "to">, day: string): boolean {
  return span.from <= day && (span.to === null || day < span.to);
}

function spanOn(person: FieldAbsencePerson, day: string): FieldAbsenceSeatSpan | null {
  // The LATEST stretch wins when two touch the same day: a seat change closes and reopens on one day,
  // and half-open dating already keeps them apart, so this is only a guard against a doubled row.
  let found: FieldAbsenceSeatSpan | null = null;
  for (const span of person.spans) {
    if (spanCovers(span, day) && (!found || span.from >= found.from)) found = span;
  }
  return found;
}

function employedOn(person: FieldAbsencePerson, day: string): boolean {
  if (person.hireDate && isIsoDay(person.hireDate) && day < person.hireDate) return false;
  if (person.lastWorkingDate && isIsoDay(person.lastWorkingDate) && day > person.lastWorkingDate) return false;
  return true;
}

/** What the calendar box itself is, before anyone is judged in it. */
export function fieldAbsenceDayKind(day: string, today: string, holidays: ReadonlySet<string>): FieldAbsenceDayKind {
  if (day > today) return "future";
  if (holidays.has(day)) return "holiday";
  // Friday is off for every field title; Saturday is decided per person below.
  if (weekday(day) === 5) return "weekly-off";
  return "working";
}

function entryFor(person: FieldAbsencePerson, span: FieldAbsenceSeatSpan): Omit<FieldAbsenceEntry, "wholePeriod"> {
  return {
    areaName: span.areaName,
    key: person.key,
    lineName: span.lineName,
    managerName: span.managerName,
    name: person.name,
    regionName: span.regionName,
    tier: span.tier,
    tierLabel: FIELD_ABSENCE_TIER_LABELS[span.tier],
  };
}

function byLineThenName(left: { lineName: string | null; name: string }, right: { lineName: string | null; name: string }) {
  return (left.lineName ?? "").localeCompare(right.lineName ?? "") || left.name.localeCompare(right.name);
}

export function buildFieldAbsenceCalendar(input: {
  people: readonly FieldAbsencePerson[];
  evidence: FieldAbsenceEvidence;
  start: string;
  end: string;
  today: string;
}): FieldAbsenceCalendar {
  const { evidence, today } = input;
  const judged = evidence.unreadable.length === 0;
  const days = eachDay(input.start, input.end);

  type Tally = {
    entry: Omit<FieldAbsenceEntry, "wholePeriod">;
    expectedDays: number;
    expectedToday: boolean;
    notSeenToday: boolean;
    finalDays: number;
    finalSeen: number;
    judgedDates: string[];
    notSeenDates: string[];
    run: number;
    longestRun: number;
  };
  const tallies = new Map<string, Tally>();
  const dayRows: Array<FieldAbsenceDay & { pending: Array<Omit<FieldAbsenceEntry, "wholePeriod">> }> = [];

  for (const day of days) {
    const kind = fieldAbsenceDayKind(day, today, evidence.holidays);
    const provisional = kind === "working" && day === today;
    const row = {
      date: day,
      expected: 0,
      halfDay: kind === "working" && isFieldWorkforceThursday(day),
      kind,
      notSeen: [] as FieldAbsenceEntry[],
      pending: [] as Array<Omit<FieldAbsenceEntry, "wholePeriod">>,
      provisional,
    };
    if (kind === "working") {
      for (const person of input.people) {
        const span = spanOn(person, day);
        if (!span || !employedOn(person, day)) continue;
        if (isFieldWorkforceWeeklyOff({ dateIso: day, title: WEEKLY_OFF_TITLE[span.tier] })) continue;
        row.expected += 1;
        const entry = entryFor(person, span);
        const tally: Tally = tallies.get(person.key) ?? {
          entry,
          expectedDays: 0,
          expectedToday: false,
          finalDays: 0,
          finalSeen: 0,
          judgedDates: [],
          longestRun: 0,
          notSeenDates: [],
          notSeenToday: false,
          run: 0,
        };
        // The person's row names the seat he held LAST in the period.
        tally.entry = entry;
        const seen = evidence.seen.get(person.key)?.has(day) ?? false;
        // Today has not ended: it shows in its own day box as "so far" (row.pending below), but it
        // is never a judged day, so the month tiles and the Detail rows count finished days only.
        if (provisional) tally.expectedToday = true;
        if (!provisional) {
          tally.expectedDays += 1;
          tally.judgedDates.push(day);
          tally.finalDays += 1;
          if (seen) {
            tally.finalSeen += 1;
            tally.run = 0;
          } else {
            tally.run += 1;
            tally.longestRun = Math.max(tally.longestRun, tally.run);
          }
        }
        if (!seen && judged) {
          if (provisional) tally.notSeenToday = true;
          else tally.notSeenDates.push(day);
          row.pending.push(entry);
        }
        tallies.set(person.key, tally);
      }
    }
    dayRows.push(row);
  }

  const wholePeriod = (tally: Tally) => judged && tally.finalDays >= WHOLE_PERIOD_MIN_DAYS && tally.finalSeen === 0;

  const personByKey = new Map(input.people.map((person) => [person.key, person]));
  const people: FieldAbsencePersonSummary[] = [...tallies.entries()].map(([key, tally]) => {
    const person = personByKey.get(key);
    const seenDates = [...(evidence.seen.get(key)?.keys() ?? [])]
      .filter((day) => day >= input.start && day <= input.end && day <= today)
      .filter((day) => person !== undefined && spanOn(person, day) !== null && employedOn(person, day))
      .sort();
    const lastSeen = seenDates.at(-1) ?? null;
    return {
      ...tally.entry,
      expectedDays: tally.expectedDays,
      expectedToday: tally.expectedToday,
      judgedDates: tally.judgedDates,
      lastSeen,
      lastSeenLabel: lastSeen ? (evidence.seen.get(key)?.get(lastSeen) ?? null) : null,
      longestRun: judged ? tally.longestRun : 0,
      notSeenDates: tally.notSeenDates,
      notSeenToday: tally.notSeenToday,
      seenDates,
      wholePeriod: wholePeriod(tally),
    };
  });
  people.sort((left, right) => right.notSeenDates.length - left.notSeenDates.length || byLineThenName(left, right));

  const wholePeriodKeys = new Set(people.filter((person) => person.wholePeriod).map((person) => person.key));
  const outDays: FieldAbsenceDay[] = dayRows.map(({ pending, ...row }) => ({
    ...row,
    notSeen: pending
      .map((entry) => ({ ...entry, wholePeriod: wholePeriodKeys.has(entry.key) }))
      .sort(byLineThenName),
  }));

  return {
    days: outDays,
    end: input.end,
    holidaysComplete: evidence.holidaysComplete,
    judged,
    people,
    start: input.start,
    today,
    unreadable: [...evidence.unreadable],
  };
}

/** Record that the system saw `key` on `day`. The first label for a day is kept. */
export function addSeen(seen: Map<string, Map<string, string>>, key: string | null, day: string, label: string): void {
  if (!key || !isIsoDay(day)) return;
  const days = seen.get(key) ?? new Map<string, string>();
  if (!days.has(day)) days.set(day, label);
  seen.set(key, days);
}

// ── What the page receives ─────────────────────────────────────────────────────────────────────────

/** Everything both doors hand the screen — plain data, so it crosses to the client as it is. */
export type FieldAbsencePageData = {
  calendar: FieldAbsenceCalendar;
  period: FieldAbsencePeriod;
  /** "none" when a National Sales Manager holds no NSM seat: he reaches nobody, and the page says why. */
  scope: "company" | "line" | "none";
  /** The lines this viewer may filter by, in name order. */
  lines: Array<{ code: string; name: string }>;
  /** The line filter in force, or null for every line in scope. */
  line: string | null;
  /**
   * The viewer's own key when he is ON the calendar he is reading — a National Sales Manager on his
   * own line (owner, 2026-10-18: *"he sees himself, but he may have a toggle to hide himself and show
   * his scope"*). Null for everyone else.
   */
  viewerKey: string | null;
};

// ── The period the page shows ─────────────────────────────────────────────────────────────────────

export type FieldAbsenceView = "month" | "week" | "detail";

export type FieldAbsencePeriod = {
  view: FieldAbsenceView;
  /** `YYYY-MM` the month and detail views show, and the month the week view sits in. */
  month: string;
  /** The Saturday that opens the week view. */
  weekStart: string;
  start: string;
  end: string;
  /** Query values for the previous and next period of the same view. */
  previous: { month: string; week: string };
  next: { month: string; week: string };
};

function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthBounds(month: string): { start: string; end: string } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { end: `${month}-${String(last).padStart(2, "0")}`, start: `${month}-01` };
}

export function shiftMonth(month: string, delta: number): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/**
 * The period from the query string. Anything malformed falls back to the period holding today —
 * never to an error page, because a stale bookmark should still open the calendar.
 */
export function resolveFieldAbsencePeriod(input: {
  view?: string | null;
  month?: string | null;
  week?: string | null;
  today: string;
}): FieldAbsencePeriod {
  const view: FieldAbsenceView = input.view === "week" || input.view === "detail" ? input.view : "month";
  if (view === "week") {
    const anchor = isIsoDay(input.week) ? input.week : input.today;
    const weekStart = fieldAbsenceWeekStart(anchor);
    return {
      end: addDays(weekStart, 6),
      month: weekStart.slice(0, 7),
      next: { month: addDays(weekStart, 7).slice(0, 7), week: addDays(weekStart, 7) },
      previous: { month: addDays(weekStart, -7).slice(0, 7), week: addDays(weekStart, -7) },
      start: weekStart,
      view,
      weekStart,
    };
  }
  const month = isMonthKey(input.month) ? input.month : input.today.slice(0, 7);
  const { end, start } = monthBounds(month);
  const previousMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  return {
    end,
    month,
    next: { month: nextMonth, week: fieldAbsenceWeekStart(`${nextMonth}-01`) },
    previous: { month: previousMonth, week: fieldAbsenceWeekStart(`${previousMonth}-01`) },
    start,
    view,
    // The week view opened from a month lands on the week holding today when today is in that month,
    // and on the month's first week otherwise.
    weekStart: fieldAbsenceWeekStart(input.today.slice(0, 7) === month ? input.today : start),
  };
}
