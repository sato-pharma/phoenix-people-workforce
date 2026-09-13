// Hiring month — how HR finds the new hires who still need cards.
//
// A hire date is a date only (no time, no zone), so it is read by its own digits and never passed
// through `new Date()` in the viewer's zone, which could move the 1st of a month into the one before.

/** The option value for people whose record has no hiring date. */
export const NO_HIRE_MONTH = "none";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTHS_SHORT = MONTHS.map((month) => month.slice(0, 3));

function parts(hireDate: string | null | undefined): { day: number; month: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec((hireDate ?? "").trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { day: Number(match[3] ?? 0), month, year: Number(match[1]) };
}

/** `2026-09` for a 2026-09-03 hire; `none` when the record has no usable date. */
export function hireMonthKey(hireDate: string | null | undefined): string {
  const date = parts(hireDate);
  return date ? `${date.year}-${String(date.month).padStart(2, "0")}` : NO_HIRE_MONTH;
}

/** `September 2026`, or `No hiring date`. */
export function hireMonthLabel(key: string): string {
  const date = parts(key);
  return date ? `${MONTHS[date.month - 1]} ${date.year}` : "No hiring date";
}

/** `3 Sep 2026` for a card's header; empty when there is no date. */
export function formatHireDate(hireDate: string | null | undefined): string {
  const date = parts(hireDate);
  if (!date) return "";
  return date.day ? `${date.day} ${MONTHS_SHORT[date.month - 1]} ${date.year}` : `${MONTHS_SHORT[date.month - 1]} ${date.year}`;
}

export type HireMonthOption = { count: number; key: string; label: string };

/** Every hiring month on the staff list, newest first, with how many people joined in it. No date last. */
export function hireMonthOptions(people: ReadonlyArray<{ hireDate: string | null }>): HireMonthOption[] {
  const counts = new Map<string, number>();
  for (const person of people) {
    const key = hireMonthKey(person.hireDate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a === NO_HIRE_MONTH ? 1 : b === NO_HIRE_MONTH ? -1 : b.localeCompare(a)))
    .map(([key, count]) => ({ count, key, label: hireMonthLabel(key) }));
}
