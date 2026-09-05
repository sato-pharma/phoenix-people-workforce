import { toDateOnlyString } from "@/lib/date-only";
import { currentCairoDateParts } from "@/lib/i18n/format";

// NOT swapped for @/lib/date-only's parseDateOnly: that version accepts any calendar rollover
// (e.g. "2026-02-30" silently becomes March 2) where this one rejects it — the year/month/day
// must round-trip through the constructed Date exactly, or it returns null. Contract start
// dates drive renewal math that HR and payroll both read, so the stricter reject-don't-shift
// behavior stays here on purpose.
function parseDateOnly(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function anniversaryForYear(start: Date, year: number) {
  const month = start.getMonth();
  const day = start.getDate();
  const anniversary = new Date(year, month, day);

  if (anniversary.getMonth() !== month) {
    return new Date(year, month + 1, 0);
  }

  return anniversary;
}

// Resolves which CALENDAR DAY `reference` falls on in Africa/Cairo — not the server's own
// clock, which is UTC on Railway and disagrees with Cairo for a few hours every night — then
// builds a Date for that day using the same local-constructor convention parseDateOnly above
// uses, so the two stay directly comparable via getTime(). Same house pattern as
// probation/date.ts's cairoCalendarDayAsLocalDate and lifecycle-risk/metrics.ts's startOfToday;
// duplicated here rather than shared because none of the three modules are exported for reuse.
function cairoCalendarDayAsLocalDate(reference: Date): Date {
  const { year, month, day } = currentCairoDateParts(reference);
  return new Date(year, month - 1, day);
}

export function nextContractAnniversary(
  startDate: string | null | undefined,
  today: Date = new Date(),
) {
  const start = parseDateOnly(startDate);
  if (!start) return null;

  const normalizedToday = cairoCalendarDayAsLocalDate(today);
  let year = Math.max(normalizedToday.getFullYear(), start.getFullYear() + 1);
  let candidate = anniversaryForYear(start, year);

  while (candidate.getTime() < normalizedToday.getTime()) {
    year += 1;
    candidate = anniversaryForYear(start, year);
  }

  return toDateOnlyString(candidate);
}

export function isDateOnlyBefore(left: string | null | undefined, right: string | null | undefined) {
  const leftDate = parseDateOnly(left);
  const rightDate = parseDateOnly(right);
  if (!leftDate || !rightDate) return false;
  return leftDate.getTime() < rightDate.getTime();
}
