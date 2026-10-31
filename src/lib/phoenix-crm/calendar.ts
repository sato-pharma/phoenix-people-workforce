/**
 * Phoenix CRM — the calendar a plan is built on, with no I/O.
 *
 * The field week (plan-v1.ts FIELD_WORKWEEK; owner rules 2026-08-02 and 2026-09-05): Saturday to
 * Wednesday, plus Thursday morning. Never Friday. Thursday is a half day, so it holds accounts (AM)
 * only. A week is keyed by its Saturday.
 *
 * Ramadan decides which timings a customer shows. Its dates come from the Umm al-Qura calendar,
 * pinned below so every runtime agrees (tests/phoenix-crm-calendar.test.ts re-derives the table from
 * `Intl` and fails on any drift). The Super Admin can move a year's dates for the moon sighting.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { cairoOffsetMinutes } from "@/lib/format/cairo-zone";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 0 = Sunday … 6 = Saturday, read from the calendar date itself (no clock, no zone). */
export function weekdayOfIsoDay(isoDay: string): number {
  return new Date(`${isoDay}T12:00:00Z`).getUTCDay();
}

/** The Saturday that starts the field week holding this day. A Friday belongs to the week before it. */
export function fieldWeekStart(isoDay: string): string {
  const offset = (weekdayOfIsoDay(isoDay) - 6 + 7) % 7;
  return addDaysIso(isoDay, -offset);
}

export function isFieldWeekStart(value: unknown): value is string {
  return isIsoDay(value) && weekdayOfIsoDay(value) === 6;
}

/** Saturday, Sunday, Monday, Tuesday, Wednesday, Thursday — never Friday. */
export function fieldWeekDays(weekStart: string): string[] {
  return [0, 1, 2, 3, 4, 5].map((offset) => addDaysIso(weekStart, offset));
}

/** What a plan day can hold: Thursday is a morning (accounts only); Friday holds nothing. */
export function planDayListTypes(isoDay: string): PhoenixCrmDoctorListType[] {
  const weekday = weekdayOfIsoDay(isoDay);
  if (weekday === 5) return [];
  if (weekday === 4) return ["AM"];
  return ["AM", "PM"];
}

/**
 * The weeks a plan can be READ and REVIEWED in: this week while it still has a day ahead, and every
 * field-week through the end of NEXT month. Since 2026-10-01 a rep WRITES one week only —
 * `repPlanWeek` below — and this stays the reviewers' window, the overview's and the daily report's.
 *
 * Until 2026-09-29 this was "the next three weeks", and it clashed with the monthly due date: October
 * was due on Thursday 24 September, when only the weeks of 3 and 10 October could be saved — so the
 * rest of the month could not be planned by the day it was due, and "Copy last month" failed on it.
 * The horizon now reaches the last field-week of next month, so a whole month is always plannable by
 * its due date (tests/phoenix-crm-plan-board.test.ts walks every month of 2026–2028).
 */
export function plannableWeeks(cairoToday: string): string[] {
  const thisWeek = fieldWeekStart(cairoToday);
  const weeks: string[] = [];
  const thursday = addDaysIso(thisWeek, 5);
  if (thursday >= cairoToday) weeks.push(thisWeek);
  const nextMonthWeeks = fieldWeeksOfMonth(addDaysIso(monthEndOf(cairoToday), 1));
  const lastWeek = nextMonthWeeks[nextMonthWeeks.length - 1] ?? addDaysIso(thisWeek, 7 * 4);
  for (let week = addDaysIso(thisWeek, 7); week <= lastWeek; week = addDaysIso(week, 7)) weeks.push(week);
  return weeks;
}

/**
 * 🔴 THE ONE WEEK A REP MAY PLAN (owner, 2026-10-01 — "the plan is entered weekly only; I cannot enter
 * a week that passed or a week ahead; it opens on the week the plan should be entered in").
 *
 * The field week that begins on the COMING Saturday: on Thursday 1 and Friday 2 October that is the
 * week of Saturday 3 October, and on Saturday 3 October it is already the week of the 10th. Never a
 * week after the next one, and never this week — unless he never sent it, when `repWeekState` still
 * opens it, late and stamped late (owner, 2026-10-02). `plannableWeeks` stays the REVIEWERS' window; a
 * rep reads his own through `repWeekState` (plan-rules.ts), which the server enforces on every save and send.
 */
export function repPlanWeek(cairoToday: string): string {
  return addDaysIso(fieldWeekStart(cairoToday), 7);
}

/**
 * Weeks whose due date the owner moved by hand — never a rule, each one a ruling with its date.
 *
 * 2026-10-03: the Delta reps' first week was planned on Thursday 1 October in the old screen, wiped
 * with everything else entered in it, and sent again on Friday 2 October. The owner ruled those
 * re-sends on time ("not late: they sent on time"), so this one week is due on the Friday.
 * `phoenix_crm_week_due_on` holds the same table; tests/phoenix-crm-plan-weekly-only.test.ts pins that
 * the two agree.
 */
export const PLAN_WEEK_DUE_OVERRIDES: Readonly<Record<string, string>> = { "2026-10-03": "2026-10-02" };

/**
 * When a week is due: the Thursday before it (owner, 2026-09-29 — "if he chooses the weekly plan it is
 * the last Thursday of every week"). A late week is accepted and stamped, never refused.
 * `phoenix_crm_week_due_on` writes the same arithmetic, overrides included.
 */
export function weeklyPlanDueOn(weekStart: string): string {
  return PLAN_WEEK_DUE_OVERRIDES[weekStart] ?? addDaysIso(weekStart, -2);
}

/**
 * The hour on the due date at which a plan is late: 23:55 Cairo (owner, 2026-10-02 — "the deadline to
 * submit the plan is thuersday 11:5pm and show themn this").
 *
 * It is a TIME, not the end of a day. Before this the test was `today > dueOn`, so the cut-off was
 * midnight and no screen ever named it — the rep was told WHICH DAY his plan was due and left to assume
 * the hour. The second half of his instruction is the half that matters: the deadline is written
 * wherever he reads the due date, so he is never guessing at it.
 *
 * A late plan is still ACCEPTED AND STAMPED, never refused (owner, 2026-09-29) — a rep who cannot plan
 * cannot work. The deadline decides the stamp and the "Overdue" badge, and nothing else.
 */
export const PLAN_DEADLINE_CAIRO_HOUR = 23;
export const PLAN_DEADLINE_CAIRO_MINUTE = 55;

/** How the deadline is written wherever anyone reads it — one wording, never a second copy. */
export const PLAN_DEADLINE_LABEL = "11:55 PM";

/**
 * The real instant 23:55 Cairo falls at on `dueOn`, from the zone table that ships with the code
 * (`cairo-zone.ts`) and never from the reader's engine — a browser built between 2014 and 2023 puts
 * Egypt an hour out for half of each year, and this value decides whether a rep is stamped late.
 *
 * Two passes, because the offset depends on the instant being solved for. The one wall time that
 * exists TWICE is 23:55 on the Thursday Egypt leaves DST (2026-10-29, which turns over at Cairo
 * midnight), and the second pass lands on the LATER of the two — the forgiving one, so a rep whose own
 * clock reads 23:55 is on time on either pass of it. `phoenix_crm_week_deadline_at` resolves that same
 * ambiguity the same way; both were measured against production rather than assumed.
 */
export function planDeadlineAt(dueOn: string): Date {
  const [year, month, day] = dueOn.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, PLAN_DEADLINE_CAIRO_HOUR, PLAN_DEADLINE_CAIRO_MINUTE);
  const first = wall - cairoOffsetMinutes(new Date(wall)) * 60000;
  return new Date(wall - cairoOffsetMinutes(new Date(first)) * 60000);
}

/**
 * Whether the deadline for `dueOn` has passed — the ONE predicate behind every "Overdue" a rep sees.
 *
 * It has to be an instant and not a date: with a date, the five minutes between 23:55 and midnight
 * would show him a week that is not yet overdue while the server stamps that very send late.
 */
export function planDeadlinePassed(dueOn: string, now: Date = new Date()): boolean {
  return now.getTime() > planDeadlineAt(dueOn).getTime();
}

/** "Week 1", "Week 2"… — a field-week's place in the month its Saturday falls in. */
export function weekNumberInMonth(weekStart: string): number {
  return fieldWeeksOfMonth(weekStart).indexOf(weekStart) + 1;
}

// ── The visit day ───────────────────────────────────────────────────────────────────────────────

/**
 * The visit day turns over at 02:00 Cairo, not at midnight (owner, 2026-09-29): "the visits of today
 * are entered today, maximum 2 AM — at 2:01 I cannot enter a visit I missed". A visit logged at 01:30
 * on Tuesday is Monday's; one at 02:00 is Tuesday's.
 */
export const VISIT_DAY_CUTOFF_HOURS = 2;

const CAIRO_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/**
 * The Cairo visit day an instant belongs to: the Cairo date of (instant − 2 hours).
 *
 * The SAME arithmetic as `phoenix_crm_save_visit`'s `((captured_at - interval '2 hours') at time zone
 * 'Africa/Cairo')::date`, so the page and the database always agree which day a visit is filed under.
 * The subtraction is on the absolute instant, so a clock-change night moves the cutoff with the clock.
 */
export function cairoBusinessDay(instant: Date, cutoffHours = VISIT_DAY_CUTOFF_HOURS): string {
  return CAIRO_DAY_FORMAT.format(new Date(instant.getTime() - cutoffHours * 60 * 60 * 1000));
}

/** The days of a week a rep may still change: today onward. A day that has passed is fixed. */
export function editablePlanDays(weekStart: string, cairoToday: string): string[] {
  if (!isFieldWeekStart(weekStart)) return [];
  return fieldWeekDays(weekStart).filter((day) => day >= cairoToday);
}

// ── Ramadan ─────────────────────────────────────────────────────────────────────────────────────

export type RamadanRange = { hijriYear: number; startsOn: string; endsOn: string };

/**
 * Umm al-Qura Ramadan, first and last day, by Hijri year (derived from `Intl` islamic-umalqura on
 * 2026-09-16). 1448 is the first one this module meets: 8 February – 8 March 2027.
 */
export const UMM_AL_QURA_RAMADAN: readonly RamadanRange[] = [
  { hijriYear: 1447, startsOn: "2026-02-18", endsOn: "2026-03-19" },
  { hijriYear: 1448, startsOn: "2027-02-08", endsOn: "2027-03-08" },
  { hijriYear: 1449, startsOn: "2028-01-28", endsOn: "2028-02-25" },
  { hijriYear: 1450, startsOn: "2029-01-16", endsOn: "2029-02-13" },
  { hijriYear: 1451, startsOn: "2030-01-05", endsOn: "2030-02-03" },
  { hijriYear: 1452, startsOn: "2030-12-26", endsOn: "2031-01-23" },
  { hijriYear: 1453, startsOn: "2031-12-16", endsOn: "2032-01-13" },
  { hijriYear: 1454, startsOn: "2032-12-04", endsOn: "2033-01-02" },
  { hijriYear: 1455, startsOn: "2033-11-23", endsOn: "2033-12-22" },
  { hijriYear: 1456, startsOn: "2034-11-12", endsOn: "2034-12-11" },
  { hijriYear: 1457, startsOn: "2035-11-01", endsOn: "2035-11-30" },
  { hijriYear: 1458, startsOn: "2036-10-21", endsOn: "2036-11-18" },
  { hijriYear: 1459, startsOn: "2037-10-10", endsOn: "2037-11-08" },
  { hijriYear: 1460, startsOn: "2038-09-30", endsOn: "2038-10-28" },
];

const PINNED_FIRST_DAY = UMM_AL_QURA_RAMADAN[0].startsOn.slice(0, 4);
const PINNED_LAST_DAY = UMM_AL_QURA_RAMADAN[UMM_AL_QURA_RAMADAN.length - 1].endsOn;

/** The Ramadan ranges in force: the pinned calendar, with the Super Admin's moved years in its place. */
export function effectiveRamadanRanges(overrides: readonly RamadanRange[] = []): RamadanRange[] {
  const byYear = new Map<number, RamadanRange>(UMM_AL_QURA_RAMADAN.map((range) => [range.hijriYear, range]));
  for (const override of overrides) {
    if (isIsoDay(override.startsOn) && isIsoDay(override.endsOn) && override.endsOn >= override.startsOn) {
      byYear.set(override.hijriYear, override);
    }
  }
  return [...byYear.values()].sort((left, right) => left.startsOn.localeCompare(right.startsOn));
}

/** Hijri month by `Intl`, for a day outside the pinned table. Null when the runtime lacks the calendar. */
function intlHijriMonth(isoDay: string): number | null {
  try {
    const format = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: "UTC", month: "numeric" });
    if (format.resolvedOptions().calendar !== "islamic-umalqura") return null;
    const month = format.formatToParts(new Date(`${isoDay}T12:00:00Z`)).find((part) => part.type === "month");
    return month ? Number(month.value) : null;
  } catch {
    return null;
  }
}

export function isRamadanDay(isoDay: string, overrides: readonly RamadanRange[] = []): boolean {
  const ranges = effectiveRamadanRanges(overrides);
  if (ranges.some((range) => isoDay >= range.startsOn && isoDay <= range.endsOn)) return true;
  if (isoDay.slice(0, 4) >= PINNED_FIRST_DAY && isoDay <= PINNED_LAST_DAY) return false;
  return intlHijriMonth(isoDay) === 9;
}

/** The next Ramadan that has not ended by `isoDay` (for the settings screen). */
export function nextRamadan(isoDay: string, overrides: readonly RamadanRange[] = []): RamadanRange | null {
  return effectiveRamadanRanges(overrides).find((range) => range.endsOn >= isoDay) ?? null;
}

// ── Month helpers ───────────────────────────────────────────────────────────────────────────────

/** "2026-09-16" → "2026-09-01". */
export function monthStartOf(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`;
}

/** The last day of the month holding this day. */
export function monthEndOf(isoDay: string): string {
  const [year, month] = isoDay.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** "2026-09-16" → "2026-09". */
export function monthKeyOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

/**
 * The field-weeks of a month: every Saturday (a week's `week_start`) whose own date falls in the
 * calendar month. A field-week belongs to the month its Saturday falls in — one month per week, no
 * double-count — so a week that straddles a month edge sits wholly in the month its Saturday is in.
 * `monthStart` is any day of the month; the first of the month is used.
 */
export function fieldWeeksOfMonth(monthStart: string): string[] {
  const day1 = monthStartOf(monthStart);
  const monthKey = monthKeyOf(day1);
  const firstSaturday = weekdayOfIsoDay(day1) === 6 ? day1 : addDaysIso(fieldWeekStart(day1), 7);
  const weeks: string[] = [];
  for (let saturday = firstSaturday; monthKeyOf(saturday) === monthKey; saturday = addDaysIso(saturday, 7)) {
    weeks.push(saturday);
  }
  return weeks;
}

/**
 * 🔴 THE FIELD DAYS A MONTH OPENS WITH THAT ITS OWN WEEKS DO NOT HOLD (owner, 2026-10-01: "show the
 * first days of a month on that month's plan board").
 *
 * A week belongs to the month its Saturday falls in, so a month that does not start on a Saturday
 * opens with days the PREVIOUS month's last week carries. 1 October 2026 is a Thursday and lives in
 * the week of Saturday 26 September — which is why October's board did not show it at all, and why a
 * rep who planned October, sent it, and walked out on the 1st found his own stops in a draft he never
 * knew he had left behind.
 *
 * 🔴 THIS CHANGES NO FILING. The week's plan row, its status, its due date, the monthly cascade and
 * `fieldWeeksOfMonth` are all untouched: the week is still September's and is still sent on its own.
 * All this answers is which days a month OPENS with, so the board can show them.
 *
 * `[]` when the month starts on a Saturday (nothing leads it) or when the leading week holds no field
 * day inside the month at all — a month starting on a Friday, which is never a field day.
 */
export function leadingFieldDaysOfMonth(monthStart: string): string[] {
  const day1 = monthStartOf(monthStart);
  if (weekdayOfIsoDay(day1) === 6) return [];
  const monthKey = monthKeyOf(day1);
  return fieldWeekDays(fieldWeekStart(day1)).filter((day) => monthKeyOf(day) === monthKey);
}

/** The Saturday of the week those leading days belong to, or null when nothing leads the month. */
export function leadingFieldWeekOfMonth(monthStart: string): string | null {
  if (leadingFieldDaysOfMonth(monthStart).length === 0) return null;
  return fieldWeekStart(monthStartOf(monthStart));
}

/**
 * The week a month's BOARD opens with: the leading week above, else — on the month of the rep's open
 * week only — the RUNNING week, when it still has a day ahead and is not one of the month's own weeks.
 *
 * Needed since the rep plans one week at a time (owner, 2026-10-01): his board opens on the month of
 * `repPlanWeek`, and the week he is in the middle of has to stay reachable from it, because that is
 * where its "Ask to edit this week" button lives. A month that starts on a Friday or a Saturday has no
 * leading week, so without this its running week would be on no board at all.
 */
export function boardLeadingWeek(monthStart: string, cairoToday: string): string | null {
  const leading = leadingFieldWeekOfMonth(monthStart);
  if (leading) return leading;
  if (monthStartOf(repPlanWeek(cairoToday)) !== monthStartOf(monthStart)) return null;
  const running = fieldWeekStart(cairoToday);
  if (fieldWeeksOfMonth(monthStart).includes(running)) return null;
  return addDaysIso(running, 5) >= cairoToday ? running : null;
}

/**
 * 🔴 WHETHER THE WEEK A BOARD OPENS WITH IS THE WEEK THE REP IS IN — then the board calls it "This
 * week", never "First days" (2026-10-31, Alexandria CNS: "submitted weekly plans and got approval on it
 * now they cannot see it").
 *
 * It is the running week whenever its Saturday is today's field week — the month's own leading week
 * included. Saturday 31 October 2026 is both: November starts on a Sunday, so its leading week IS the
 * running week, and the board filed the week the reps had just sent and had approved under "First days",
 * beside an empty Week 1 it opened on. Asked only of `boardLeadingWeek`'s answer.
 */
export function boardLeadingWeekIsRunning(leadingWeek: string | null, cairoToday: string): boolean {
  return leadingWeek !== null && leadingWeek === fieldWeekStart(cairoToday);
}

/**
 * When a month's plan is due: the last Thursday of the month BEFORE it (owner, 2026-09-26).
 *
 * Nothing in the module refuses a plan after this date — he ruled a late month is ACCEPTED and
 * STAMPED, never blocked, so a rep is never left unable to plan. The date is a fact the rep's card and
 * the manager's board both show; `phoenix_crm_monthly_plans.submitted_late` records the verdict from
 * the SERVER's clock at submit. The same arithmetic lives in `phoenix_crm_open_monthly_plan`, written
 * in isodow; tests/phoenix-crm-monthly-plan.test.ts walks a month starting on each weekday.
 */
export function monthlyPlanDueOn(monthStart: string): string {
  const lastDayBefore = addDaysIso(monthStartOf(monthStart), -1);
  // getUTCDay puts Thursday at 4, so this steps back to the Thursday on or before that day.
  return addDaysIso(lastDayBefore, -((weekdayOfIsoDay(lastDayBefore) - 4 + 7) % 7));
}

/**
 * The months a rep can plan: the month of each week the rep can still plan (calendar.ts
 * `plannableWeeks`), so month and week stay in step — a month is plannable exactly when it holds a
 * plannable week. Today's month while it has a week ahead, and always the next.
 */
export function plannableMonths(cairoToday: string): string[] {
  const months: string[] = [];
  for (const week of plannableWeeks(cairoToday)) {
    const monthStart = monthStartOf(week);
    if (!months.includes(monthStart)) months.push(monthStart);
  }
  return months;
}
