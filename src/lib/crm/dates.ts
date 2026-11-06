/** Small UTC date helpers shared by the CRM sync + read code. */

/** Today's date as YYYY-MM-DD (UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * True only for a vendor timestamp that carries a REAL time-of-day.
 *
 * iReports360's `visit_date_time` is `00:00:00` on ~100% of rows, and `crm_save_date` is midnight
 * on ~3% — a midnight value is a date-only placeholder with no usable clock, so it must be treated
 * as "no time" rather than as midnight. Vendor timestamps are stored as Cairo wall-clock (see
 * crm/vendor-row-types.ts); this inspects only the time-of-day portion of the stored string, never a timezone.
 *
 * Lives here (rather than in crm/reads.ts, which historically owned it) so that crm/checkin-match.ts
 * can use it too: reads.ts imports checkin-match.ts, so the reverse import would be circular.
 * reads.ts re-exports it, so every existing import path keeps working.
 */
export function hasRealVendorTime(value: string | null | undefined): value is string {
  if (!value) return false;
  const time = String(value).slice(11, 19); // "HH:MM:SS" of "YYYY-MM-DD[ T]HH:MM:SS…"
  return time.length === 8 && time !== "00:00:00";
}

/** `dateIso` shifted by `days` (may be negative), as YYYY-MM-DD (UTC). */
export function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD in Africa/Cairo — deliberately distinct from {@link todayIso}
 * (UTC): the live-sync window below and the NSM "CRM First Visit" compliance check
 * (nsm-crm-compliance.ts's own cairoToday) both need the Cairo CALENDAR day, which briefly runs a
 * day ahead of the UTC one (21:00-23:59 UTC = 00:00-02:59 Cairo). */
export function cairoTodayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

/** Africa/Cairo wall-clock hour/minute for `at` (defaults to now) — extracted from a formatted
 * string, never by reconstructing a `Date` from it (that would silently depend on the runtime's
 * own local timezone to re-parse correctly). Same safe pattern as nsm-command-center.tsx's
 * cairoTime. */
export function cairoHourMinute(at: Date = new Date()): { hour: number; minute: number } {
  const formatted = at.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
  const [hour, minute] = formatted.split(":").map(Number);
  return { hour, minute };
}

const CAIRO_WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Africa/Cairo day-of-week for `at` (defaults to now), 0=Sunday..6=Saturday — extracted from a
 * formatted string for the same reason as {@link cairoHourMinute}: reconstructing a Date from
 * Cairo wall-clock parts would silently depend on the runtime's own local timezone. */
export function cairoDayOfWeek(at: Date = new Date()): number {
  const short = at.toLocaleDateString("en-US", { timeZone: "Africa/Cairo", weekday: "short" });
  return CAIRO_WEEKDAY_INDEX[short] ?? new Date(at).getUTCDay();
}

