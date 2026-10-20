import { emptyVisitCountSplit, mergeVisitCountSplits, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import type { PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";

/**
 * Phoenix CRM Wave 2 — the team calendar. The owner called it "the most important" of the three
 * reports, and on 2026-09-29 he recorded the screen he means: iReports360's `AgentsCalendar.aspx`,
 * at 7:40 of his second video.
 *
 * ## What that screen is, read off his own recording
 *
 * ONE ROW PER PERSON, one column per day of the month. The identity columns are A.Manager · TM ·
 * Line · Priv.; the day cells print the day's visit count, and the CELL'S COLOUR says which halves
 * of the day he worked: **AM only** (cyan), **PM only** (orange), **AM + PM** (green), with **Annual
 * Vacation** blue and **Campaign** pink. `F` marks a Friday in black; `N` marks a day with nothing.
 *
 * 🔴 SO THE COLOUR IS THE DAY'S SHAPE, NOT HOW BUSY IT WAS. The first cut of this module coloured by
 * a density band (none · light · steady · heavy) off AM + PM together. That was my invention, not
 * his, and it cannot answer the question the grid exists for: a rep who only ever works mornings
 * reads as an ordinary quiet rep under a density band, and jumps off the page under this one.
 *
 * 🔴 AND THE COUNT STAYS TWO FIGURES, NEVER ONE. His grid prints a single number, which on an
 * AM-only or a PM-only day is unambiguous — but on a both-halves day it is AM + PM added, and the
 * AM · PM · Pharmacies golden rule says every count of visits is reported apart. So a both-halves
 * cell carries the two figures, one above the other; a single-half cell carries the one figure the
 * colour already names. Nothing here ever adds them.
 *
 * 🔴 PHARMACIES ARE IN THE DAY'S DETAIL AND NEVER IN THE CELL (owner, 2026-09-30, asked directly and
 * answered). A pharmacy is not a contact, so a day spent on pharmacies is not the same shape of day
 * as one spent on customers, and letting it colour the cell would make the two read alike at the
 * glance a calendar is for. `dayShape` ignores `counts.pharmacies` entirely.
 *
 * Pure rules, no I/O. Leave comes from HR's own loader and is passed in — this module never decides
 * who was away, and Phoenix has no leave of its own (`day-activities.ts` says why).
 */

/**
 * What a cell says at a glance.
 *
 * `rest` is his black `F`: a Friday is not a working day here (`isFieldDay`), and a Friday that
 * reads like a missed day is the fastest way to make a manager distrust the whole grid.
 * `activity` takes the place of his pink `CP` — Phoenix retired Campaign and replaced it with the
 * seven day activities, which are a RECORD of a working day that was not a call.
 */
export type DayShape = "am" | "both" | "pm" | "activity" | "leave" | "rest" | "none";

export type TeamCalendarDay = {
  /** `YYYY-MM-DD`, the Cairo calendar day — a report reads the calendar day, never the 02:00 visit
   *  day, which belongs to the rep's own flow. */
  day: string;
  counts: VisitCountSplit;
  /**
   * Phoenix CRM visits the rep SAVED on this day that count in nothing yet, because the customer is
   * not validated. Without it a worked day reads as an empty one: on a team that has just started,
   * EVERY visit is in this state (0 of Delta (1)'s 1,551 customers were validated the day before it
   * began), so the whole row would be blank for a rep who was out all month. It is never added to
   * `counts` — the three figures stay what they are — and it is the manager's to read, never the rep's.
   */
  awaitingValidation: number;
  shape: DayShape;
  /** HR's own approved leave covering this day. A fact, never derived from a gap in the visits. */
  onLeave: boolean;
  activity: PhoenixCrmDayActivity | null;
};

export type TeamCalendarPerson = {
  seatId: string;
  /** The person in the seat, by name. Never an HR id on a screen. */
  person: string;
  /** Area · Line, which merges his four identity columns into the one a phone can carry. */
  territory: string;
  /** His A.Manager column: the name above this seat, or null at the top of the viewer's scope. */
  manager: string | null;
  /**
   * `manager` for a district, regional or national manager's own row (owner, 2026-10-19: "yes, all
   * manager levels"); absent means a rep's territory, which is what every row was before. A manager's
   * row is HIS days — his own single visits, the visits he rode with a rep, and his leave — and it is
   * never added into the month's totals: a ride-along is already on the rep's row.
   */
  kind?: "rep" | "manager";
  /**
   * A manager who holds NO organogram seat — a line's Product Manager or Group Product Manager (owner,
   * 2026-10-20: "EVERYSINGLE ROLE THATS APLLICABLE TOAPPEAR IN A MODULE FIND ANAD SHOW"). His row is keyed
   * `product-manager:<hr id>`, which is no seat, so no page can be opened on it: his cells explain the day in
   * the panel below the grid instead. Absent means the row is a seat, which is what every row was before.
   */
  seatless?: boolean;
};

export type TeamCalendarRow = TeamCalendarPerson & {
  days: TeamCalendarDay[];
  totals: VisitCountSplit;
  /** The three shape tallies — the pattern the grid exists to expose, counted rather than eyeballed. */
  amOnlyDays: number;
  pmOnlyDays: number;
  bothDays: number;
};

// `awaitingValidation` is optional, and ABSENT genuinely means NONE here — unlike `gpsCheckins`
// on a call rate, where absent means "not measured". A day with no visit waiting on a customer
// simply has none, so a fixture that leaves it out is reading the same day the server builds.
type DayInput = { seatId: string; day: string; counts: VisitCountSplit; awaitingValidation?: number };
type ActivityInput = { seatId: string; day: string; activity: PhoenixCrmDayActivity };
type LeaveInput = { seatId: string; day: string };

/** Friday, and nothing else. The same rule the exceptions board reads, kept in one sentence here. */
function isRestDay(iso: string): boolean {
  // A date-only string has no time of day to place in a zone, so it is read as UTC: that is what
  // keeps the weekday from sliding by one for anyone west of Cairo.
  return new Date(`${iso}T00:00:00Z`).getUTCDay() === 5;
}

/** Every Cairo calendar day of a `YYYY-MM` month, in order. Empty for anything that is not one. */
export function monthDays(month: string): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return [];
  // `Date.UTC(y, m + 1, 0)` is the last day of month m — the arithmetic the rest of this repo uses,
  // and the only one that is right in February and in a leap year without a table.
  const length = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const out: string[] = [];
  for (let day = 1; day <= length; day += 1) out.push(`${match[1]}-${match[2]}-${String(day).padStart(2, "0")}`);
  return out;
}

/**
 * 🔴 WHICH HALVES HE WORKED — and the precedence when more than one thing is true of a day.
 *
 * WORK COMES FIRST, always. A rep who logged a visit on a Friday, or on a day HR has him on leave,
 * WORKED: hiding that behind the `F` or the blue would be the grid quietly disagreeing with his own
 * visit rows. Only when nothing was logged does the rest of the order matter — Friday, then leave,
 * then a day activity — and each of those is a reason the day is blank, which is the whole point of
 * separating them from a plain missed day.
 *
 * Pharmacies are deliberately absent from every branch (his ruling, 2026-09-30).
 */
export function dayShape(input: {
  counts: VisitCountSplit;
  onLeave: boolean;
  activity: PhoenixCrmDayActivity | null;
  day: string;
}): DayShape {
  const { am, pm } = input.counts;
  if (am > 0 && pm > 0) return "both";
  if (am > 0) return "am";
  if (pm > 0) return "pm";
  if (isRestDay(input.day)) return "rest";
  if (input.onLeave) return "leave";
  if (input.activity) return "activity";
  return "none";
}

/**
 * The month's grid: one row per person in the viewer's scope, every day of the month on every row.
 *
 * A calendar that omits its empty days is not a calendar — a manager reads the GAPS as much as the
 * work, and a grid that silently skips the 12th makes a quiet week look like a busy one. The same
 * goes for a person with nothing at all: his row is the finding, so he is never dropped.
 */
export function buildTeamCalendar(
  month: string,
  people: readonly TeamCalendarPerson[],
  input: {
    visits?: readonly DayInput[];
    activities?: readonly ActivityInput[];
    leave?: readonly LeaveInput[];
  } = {},
): TeamCalendarRow[] {
  const days = monthDays(month);
  if (days.length === 0) return [];
  const inMonth = new Set(days);
  const key = (seatId: string, day: string) => `${seatId}|${day}`;

  const counts = new Map<string, VisitCountSplit>();
  // Kept beside the three figures rather than inside them: a visit waiting on its customer is work
  // the rep did, and it is counted in nothing until that customer is validated.
  const waiting = new Map<string, number>();
  for (const row of input.visits ?? []) {
    if (!inMonth.has(row.day)) continue;
    const at = key(row.seatId, row.day);
    const found = counts.get(at);
    if (found) mergeVisitCountSplits(found, row.counts);
    else counts.set(at, { ...row.counts });
    const rowWaiting = row.awaitingValidation ?? 0;
    if (rowWaiting > 0) waiting.set(at, (waiting.get(at) ?? 0) + rowWaiting);
  }

  const activities = new Map<string, PhoenixCrmDayActivity>();
  for (const row of input.activities ?? []) {
    if (inMonth.has(row.day)) activities.set(key(row.seatId, row.day), row.activity);
  }

  const leave = new Set<string>();
  for (const row of input.leave ?? []) {
    if (inMonth.has(row.day)) leave.add(key(row.seatId, row.day));
  }

  return people.map((person) => {
    const totals = emptyVisitCountSplit();
    let amOnlyDays = 0;
    let bothDays = 0;
    let pmOnlyDays = 0;
    const rowDays = days.map((day) => {
      const at = key(person.seatId, day);
      const dayCounts = counts.get(at) ?? emptyVisitCountSplit();
      const activity = activities.get(at) ?? null;
      const onLeave = leave.has(at);
      const dayWaiting = waiting.get(at) ?? 0;
      const shape = dayShape({ activity, counts: dayCounts, day, onLeave });
      mergeVisitCountSplits(totals, dayCounts);
      if (shape === "am") amOnlyDays += 1;
      else if (shape === "pm") pmOnlyDays += 1;
      else if (shape === "both") bothDays += 1;
      return { activity, awaitingValidation: dayWaiting, counts: dayCounts, day, onLeave, shape };
    });
    return { ...person, amOnlyDays, bothDays, days: rowDays, pmOnlyDays, totals };
  });
}

/**
 * The whole month's totals, still three figures apart.
 *
 * 🔴 REPS' ROWS ALONE. A manager's row repeats the visits he rode with a rep, which are already on that
 * rep's row, so adding it would count one visit twice — and his own single visits count in no figure
 * at all (`manager-visits.ts`).
 */
export function teamCalendarTotals(rows: readonly TeamCalendarRow[]): VisitCountSplit {
  const total = emptyVisitCountSplit();
  for (const row of rows) if (row.kind !== "manager") mergeVisitCountSplits(total, row.totals);
  return total;
}
