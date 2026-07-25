// Shared boundary helper for attendance range queries — replaces byte-identical private copies
// of `utcBoundaryForLocalDate` that used to live independently in punch-minutes.ts and
// fingerprint-report.ts. The old implementation (`new Date(y, m-1, d+offset).toISOString()`)
// built a LOCAL-constructor Date and serialized it — on the production runtime (no TZ set,
// defaults to UTC) that produces UTC-midnight of the date string, not Cairo-midnight. Off by
// Cairo's actual UTC offset (2-3h), the [start, end) range built from it drops real
// early-Cairo-morning punches from the first day of any requested range and bleeds in the next
// day's early punches at the end.

const DEFAULT_ATTENDANCE_TIME_ZONE = "Africa/Cairo";

/**
 * The real UTC instant for local midnight of `dateIso` (+ `dayOffset` days) in `timeZone`.
 * DST-safe: derives the zone's actual UTC offset at that calendar instant by formatting a
 * guessed instant in the zone and reading its wall-clock components back as if they were UTC —
 * the same Intl.DateTimeFormat + formatToParts round-trip idiom already used elsewhere in this
 * codebase for localDateKey/localMinutesOfDay — rather than assuming a fixed +2h/+3h offset.
 */
export function cairoMidnightUtcIso(
  dateIso: string,
  dayOffset = 0,
  timeZone: string = process.env.ATTENDANCE_REPORT_TIME_ZONE || DEFAULT_ATTENDANCE_TIME_ZONE,
): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day + dayOffset);

  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(guess));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));

  return new Date(guess - (asIfUtc - guess)).toISOString();
}
