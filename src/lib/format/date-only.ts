// One format for a DATE-ONLY value — a `date` column, a period key, a window bound — beside
// cairoDateTime, which is for an instant.
//
// The zone here is UTC and that is the fix, not the bug. A bare `2026-09-02` parses as UTC
// midnight, so rendering it in any other zone can move it to the day before: the value carries no
// time of day to be moved. Rendering an INSTANT in UTC is the opposite mistake — that one belongs
// in Cairo, and cairoDateTime is the function for it. Classify by the backing column, never by the
// name of the formatter.
//
// Pinning the zone also makes the output identical on the server and in the browser. Without it
// the server (UTC on Railway) and the phone (Africa/Cairo) can format the same value two ways,
// which React reports as a hydration mismatch — error #418, "server rendered text didn't match
// the client" — and repairs by throwing the server's markup away and re-rendering on the device.

/** The options, exported so a test can assert the zone is pinned rather than inferred. */
export const DATE_ONLY_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
};

/** e.g. `Sep 2, 2026`. An absent value renders as an empty string; an unparseable one is passed through. */
export function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", DATE_ONLY_FORMAT_OPTIONS).format(date);
}
