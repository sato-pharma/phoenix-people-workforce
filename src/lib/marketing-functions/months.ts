// Marketing Functions — month arithmetic. Pure: the caller passes "today" (Cairo), nothing reads a
// clock here, so every rule below can be tested with a fixed date.

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-11" for a Cairo date "2026-11-10". */
export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY.test(value);
}

/** The month a request names, or today's month when it names none or a malformed one. */
export function resolveMonthKey(value: unknown, todayIso: string): string {
  return isMonthKey(value) ? value : monthKeyOf(todayIso);
}

/** The stored `month` column: the first day of the month. */
export function monthStartDate(monthKey: string): string {
  return `${monthKey}-01`;
}

export function shiftMonthKey(monthKey: string, delta: number): string {
  const match = MONTH_KEY.exec(monthKey);
  if (!match) return monthKey;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** "November 2026". */
export function monthTitle(monthKey: string): string {
  const match = MONTH_KEY.exec(monthKey);
  if (!match) return monthKey;
  return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

/** The last day of the month, "2026-11-30". */
export function monthEndDate(monthKey: string): string {
  const match = MONTH_KEY.exec(monthKey);
  if (!match) return `${monthKey}-28`;
  const days = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return `${monthKey}-${String(days).padStart(2, "0")}`;
}

/** A due date belongs to the sheet only when it falls inside or after its month's first day. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** "10 Nov 2026" — a date-only value, so no timezone is involved. */
export function shortDateLabel(isoDate: string | null | undefined): string {
  if (!isoDate || !isIsoDate(isoDate)) return "";
  const [year, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTH_NAMES[Number(month) - 1].slice(0, 3)} ${year}`;
}

/** The months a picker offers, newest first: from November 2026 (when the sheets started) to next month. */
export function pickerMonthKeys(todayIso: string, from = "2026-11"): string[] {
  const last = shiftMonthKey(monthKeyOf(todayIso), 1);
  const keys: string[] = [];
  for (let key = from; key <= last && keys.length < 60; key = shiftMonthKey(key, 1)) keys.push(key);
  return keys.reverse();
}
