// Weekly Planning week key and deadline utilities.

/**
 * Find the Sunday on or before the given date.
 * Sunday = day 0 in JS getDay().
 */
export function getSundayOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - dayOfWeek);
  return d;
}

/**
 * Parse a date value into a UTC-anchored Date.
 * Accepts a Date object or a YYYY-MM-DD string.
 */
function toUtcDate(date: Date | string): Date {
  if (typeof date === "string") {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Format a Date as YYYY-MM-DD using UTC fields.
 */
function toDateStr(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Compute the ISO week number of a given date.
 * ISO 8601: week starts Monday; week 1 contains the first Thursday.
 */
function isoWeekNumber(date: Date): { week: number; year: number } {
  // Work in UTC to avoid DST surprises.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Set to the nearest Thursday (ISO week is identified by its Thursday).
  // Day 4 = Thursday; getUTCDay 0=Sun, 1=Mon... 6=Sat.
  const dayIndex = d.getUTCDay(); // 0=Sun
  // Convert to Mon-based index: Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
  const monBased = (dayIndex + 6) % 7;
  // Shift to the Thursday of the same ISO week.
  d.setUTCDate(d.getUTCDate() - monBased + 3);
  const year = d.getUTCFullYear();
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Monday = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const weekNum = Math.round((d.getTime() - jan4Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return { week: weekNum, year };
}

/**
 * Build the week key (YYYY-WNN) for the given date.
 * The week key is derived from the Sunday of the date's week using the ISO
 * week number of that Sunday. This keeps week keys deterministic relative to
 * our Sunday-start custom week.
 *
 * 🔴 THIS FUNCTION DEFINES THE CONVENTION — `employee_plan_headers.period_key` and
 * `phoenix_crm_plans` already hold keys it produced, so the stored data is its proof and it
 * must not change. Because isoWeekNumber shifts a Sunday back 3 days to a Thursday, the key
 * names the ISO week that ENDS on that Sunday: buildWeekKey("2026-10-11") is "2026-W41", whose
 * ISO Monday is 2026-10-05. sundayFromWeekKey inverts it as Monday(W) + 6.
 */
export function buildWeekKey(date: Date | string): string {
  const d = toUtcDate(date);
  const sunday = getSundayOfWeek(d);
  const { week, year } = isoWeekNumber(sunday);
  const weekStr = String(week).padStart(2, "0");
  return `${year}-W${weekStr}`;
}

/**
 * Return the Sunday (weekStartDate) and Thursday (weekEndDate) for the week
 * containing the given date.
 */
export function getWeekRange(date: Date | string): { weekStartDate: string; weekEndDate: string } {
  const d = toUtcDate(date);
  const sunday = getSundayOfWeek(d);
  const thursday = new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() + 4));
  return {
    weekStartDate: toDateStr(sunday),
    weekEndDate: toDateStr(thursday),
  };
}

/**
 * Derive the month key (YYYY-MM) from the week_start_date (Sunday).
 */
export function deriveMonthKey(date: Date | string): string {
  const d = toUtcDate(date);
  const sunday = getSundayOfWeek(d);
  const y = sunday.getUTCFullYear();
  const m = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Validate a week key string.
 * Valid format: YYYY-WNN where NN is 01-53.
 */
export function validateWeekKey(weekKey: string): boolean {
  return /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(weekKey);
}

/**
 * Determine if the given date is a working day.
 * Default: Sun-Thu are working days; Fri and Sat are off.
 * The optional weeklyOffPolicy may override thursday/saturday.
 */
export function isPlanWorkingDay(
  date: Date | string,
  weeklyOffPolicy?: {
    thursdayOff?: string;
    fridayOff?: string;
    saturdayOff?: string;
  },
): boolean {
  const d = toUtcDate(date);
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

  if (dayOfWeek === 5) {
    // Friday is always off.
    return false;
  }

  if (dayOfWeek === 6) {
    // Saturday: off by default unless policy says 'working'.
    return weeklyOffPolicy?.saturdayOff === "working";
  }

  if (dayOfWeek === 4) {
    // Thursday: working by default unless policy says 'full_day'.
    if (weeklyOffPolicy?.thursdayOff === "full_day") return false;
    return true;
  }

  // Sunday (0), Monday (1), Tuesday (2), Wednesday (3) are working.
  return true;
}

/**
 * Parse a week key (YYYY-WNN) and return the Sunday (UTC Date) of that week —
 * the exact inverse of buildWeekKey, so sundayFromWeekKey(buildWeekKey(d)) is
 * always getSundayOfWeek(d).
 *
 * 🔴 THE SUNDAY IS THE **LAST** DAY OF THE ISO WEEK, NOT THE DAY BEFORE ITS MONDAY.
 * buildWeekKey takes the Sunday of the date's week and labels it with the ISO week
 * that ENDS on that Sunday (isoWeekNumber shifts a Sunday back 3 days to the Thursday
 * of the Mon–Sun week it closes). So the Sunday of key W is Monday(W) + 6 days.
 * Reading it as Monday(W) - 1 put every deadline a WHOLE WEEK EARLY: 2026-W41's
 * Sunday read 2026-10-04 and its submission deadline Thursday 1 October, ten days
 * before the week it gates. Production's own plan rows define the convention —
 * employee_plan_headers has 2026-W41 running 11–15 October (read live 2026-10-12),
 * and buildWeekKey("2026-10-11") answers 2026-W41 — so buildWeekKey and the stored
 * keys are right and this function was the side that was wrong.
 */
function sundayFromWeekKey(weekKey: string): Date {
  const [yearStr, weekPart] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekPart, 10);

  // Jan 4 is always in ISO week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayIndex = jan4.getUTCDay(); // 0=Sun
  const jan4MonBased = (jan4DayIndex + 6) % 7; // Mon=0
  // Monday of week 1.
  const week1Monday = new Date(Date.UTC(year, 0, 4 - jan4MonBased));
  // Monday of target week.
  const targetMonday = new Date(Date.UTC(week1Monday.getUTCFullYear(), week1Monday.getUTCMonth(), week1Monday.getUTCDate() + (week - 1) * 7));
  // The Sunday that CLOSES this ISO week — Monday + 6 days — which is the Sunday
  // buildWeekKey derived the key from.
  const sunday = new Date(Date.UTC(targetMonday.getUTCFullYear(), targetMonday.getUTCMonth(), targetMonday.getUTCDate() + 6));
  return sunday;
}

/**
 * Compute the UTC instant corresponding to a specific Africa/Cairo wall-clock time
 * (hour:minute, on the UTC calendar date given) — DST-safe. Builds a naive UTC
 * guess, reads back what wall-clock time that guess actually displays in
 * Africa/Cairo, and corrects by the difference. Same round-trip idiom as
 * currentCairoDateParts in src/lib/i18n/format.ts, rather than a fixed UTC+2/UTC+3
 * offset that would silently drift wrong across the DST transition.
 */
function cairoWallClockUtcInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = Date.UTC(year, month, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "Africa/Cairo",
  }).formatToParts(new Date(guess));
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), 0);
  return new Date(guess - (asIfUtc - guess));
}

/**
 * Submission deadline: Thursday 17:00 Africa/Cairo of the PRIOR week.
 * Submit next week's plan by the Thursday before it starts.
 * Returns the correct UTC instant for that Cairo wall-clock time (DST-safe via
 * cairoWallClockUtcInstant), not a flat "17:00 UTC" approximation.
 */
export function submissionDeadlineForWeek(weekKey: string): Date {
  const sunday = sundayFromWeekKey(weekKey);
  // Prior Thursday = Sunday - 3 days.
  const thursday = new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() - 3));
  return cairoWallClockUtcInstant(thursday.getUTCFullYear(), thursday.getUTCMonth(), thursday.getUTCDate(), 17, 0);
}

/**
 * The DEDUCTION grace deadline: the END of the given Monday in Africa/Cairo — 23:59:59.999.
 *
 * Owner, 2026-10-19: the deadline is the end of the day, 23:59:59, so anything sent before midnight
 * Cairo is on time. Until then it was 23:59:00 exactly, and the loader's `submittedAt > deadline`
 * test called a plan sent at 23:59:30 late — a day's pay for the last minute of the day.
 *
 * Owner, 2026-10-12: "if not submitted a weekly plan till monday of this week a 1 day deduction".
 * Deliberately LATER and more forgiving than `submissionDeadlineForWeek` above (Thursday 17:00 of
 * the PRIOR week), which is the planning module's own on-time rule: being late there is a planning
 * flag, while missing THIS one costs a day's pay. Two different questions, so two deadlines — never
 * collapse them into one.
 *
 * 🔴 IT TAKES THE MONDAY DATE, NOT A WEEK KEY, ON PURPOSE. The caller already holds the Monday it
 * is charging — src/lib/daily-deductions/no-weekly-plan.ts derives both the Monday and its week key
 * from one calendar walk — so a week key here would mean deriving the date back out again. That
 * round trip was a real defect and not merely redundant: `sundayFromWeekKey`, which the three
 * deadline helpers above use, was a whole week out until #5768 made it a true inverse of
 * `buildWeekKey`, and going through it would have charged the day on the Monday of the WRONG week.
 *
 * DST-safe through cairoWallClockUtcInstant.
 */
export function planDeductionGraceDeadlineForMonday(mondayIso: string): Date {
  const [year, month, day] = mondayIso.split("-").map(Number);
  // cairoWallClockUtcInstant resolves to the whole minute, so the last 59.999 seconds are added here.
  return new Date(cairoWallClockUtcInstant(year, month - 1, day, 23, 59).getTime() + 59_999);
}

/**
 * Manager approval deadline: Saturday 12:00 noon Africa/Cairo of the prior week.
 * Saturday = Sunday of the plan's week - 1 day. Returns the correct UTC instant for
 * that Cairo wall-clock time (DST-safe via cairoWallClockUtcInstant).
 */
export function managerApprovalDeadlineForWeek(weekKey: string): Date {
  const sunday = sundayFromWeekKey(weekKey);
  const saturday = new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() - 1));
  return cairoWallClockUtcInstant(saturday.getUTCFullYear(), saturday.getUTCMonth(), saturday.getUTCDate(), 12, 0);
}

/**
 * CEO approval deadline: Sunday 10:00 AM Africa/Cairo of the plan's working week.
 * Returns the correct UTC instant for that Cairo wall-clock time (DST-safe via
 * cairoWallClockUtcInstant).
 */
export function ceoApprovalDeadlineForWeek(weekKey: string): Date {
  const sunday = sundayFromWeekKey(weekKey);
  return cairoWallClockUtcInstant(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate(), 10, 0);
}
