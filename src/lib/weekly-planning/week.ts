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
 * Parse a week key (YYYY-WNN) and return the Sunday (UTC Date) of that week.
 * Week key uses ISO week numbers; the Sunday is computed by finding the
 * Monday of that ISO week and subtracting 1 day.
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
  // Sunday is 1 day before Monday.
  const sunday = new Date(Date.UTC(targetMonday.getUTCFullYear(), targetMonday.getUTCMonth(), targetMonday.getUTCDate() - 1));
  return sunday;
}

/**
 * Submission deadline: Thursday 17:00 of the PRIOR week.
 * Submit next week's plan by the Thursday before it starts.
 * Returns a Date (UTC midnight-anchored arithmetic; 17:00 is set as UTC hours
 * since the platform treats deadlines in Africa/Cairo ~ UTC+2, but for pure
 * arithmetic correctness we store as UTC+0 17:00 and callers should display
 * in local time).
 */
export function submissionDeadlineForWeek(weekKey: string): Date {
  const sunday = sundayFromWeekKey(weekKey);
  // Prior Thursday = Sunday - 3 days.
  const thursday = new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() - 3));
  thursday.setUTCHours(17, 0, 0, 0);
  return thursday;
}

/**
 * Manager approval deadline: Saturday 12:00 noon of the prior week.
 * Saturday = Sunday of the plan's week - 1 day.
 */
export function managerApprovalDeadlineForWeek(weekKey: string): Date {
  const sunday = sundayFromWeekKey(weekKey);
  const saturday = new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate() - 1));
  saturday.setUTCHours(12, 0, 0, 0);
  return saturday;
}

/**
 * CEO approval deadline: Sunday 10:00 AM of the plan's working week.
 */
export function ceoApprovalDeadlineForWeek(weekKey: string): Date {
  const sunday = sundayFromWeekKey(weekKey);
  const deadline = new Date(sunday);
  deadline.setUTCHours(10, 0, 0, 0);
  return deadline;
}
