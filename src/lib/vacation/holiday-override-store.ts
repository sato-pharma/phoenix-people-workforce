// Admin-confirmed observed/postponed dates for official national holidays,
// layered on top of the raw Google/company holiday source
// (national-holidays.ts). Lives in the vacation domain (not attendance/) and
// has zero dependency on national-holidays.ts so that national-holidays.ts
// can safely import from here to apply overrides to every consumer
// (calendars, weekly/monthly plans, vacation, attendance, field workforce
// compliance) without a circular import.
//
// Rule: a national holiday's real observed date is only authoritative once a
// System Admin has explicitly confirmed it here (see the T-3-day reminder in
// national-holiday-confirmation.ts) — the raw ministry/Google Calendar date is
// a provisional default, not a substitute for that confirmation, because
// postponements are common (e.g. June 30 Revolution Day observed July 2).
//
// The confirmed observed period is a RANGE (observedDate..observedEndDate),
// not a single day — some national vacations span more than one day.
// observedEndDate === observedDate for an ordinary single-day confirmation.

import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateCompanyVacationReportCache } from "@/lib/dashboard/invalidation";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { validationError } from "@/lib/http/api-errors";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(value: string | null | undefined): value is string {
  return ISO_DATE_PATTERN.test(String(value ?? ""));
}

export type HolidayOverride = {
  id: number;
  officialDate: string;
  observedDate: string;
  observedEndDate: string;
  holidayName: string;
  notes: string | null;
};

export type HolidayOverrideInput = {
  officialDate: string;
  observedDate: string;
  /** Defaults to observedDate (single day) when omitted. */
  observedEndDate?: string;
  holidayName: string;
  notes?: string | null;
};

/**
 * THE WHOLE TABLE, CACHED — this read used to be the single most-called query in the system.
 *
 * getConfirmedNationalHolidays() is the one chokepoint every calendar, plan, attendance, vacation
 * and compliance surface goes through, and it is called ONE MONTH AT A TIME, so a nine-month
 * range is nine calls and a per-employee sweep multiplies that again. Its raw Google/company half
 * has been cached in national-holidays.ts since it was written (holidayCache, 10 min) — but this
 * half, the database half, was not, so every one of those calls still crossed to Supabase even on
 * a cache hit. Measured on production 2026-09-29: **199,148 requests in 24 hours**, 16% of all
 * Supabase traffic on the instance and the single busiest path, to read a table holding **2 rows**
 * that had not changed in six weeks.
 *
 * So the whole table is loaded once and range-filtered in memory. It is a tiny admin-confirmation
 * table — one row per postponed national holiday per year — and one entry serves every caller and
 * every month, where a per-range query shared nothing.
 *
 * The TTL matches holidayCache's deliberately: both halves of getConfirmedNationalHolidays now go
 * stale on the same clock, so a confirmation cannot appear in one half and not the other. Writes
 * here drop the entry immediately (see bulkUpsertHolidayOverrides), so the TTL only bounds how
 * long ANOTHER instance can serve a stale copy — the same window the Google half already had.
 */
const HOLIDAY_OVERRIDE_CACHE_TTL_MS = 10 * 60 * 1000;
let holidayOverrideCache: { expiresAt: number; rows: readonly HolidayOverride[] } | null = null;

/** Drop the cached table. Called on every write; exported so tests can start from a clean slate. */
export function invalidateHolidayOverrideCache(): void {
  holidayOverrideCache = null;
}

async function loadAllHolidayOverrides(): Promise<readonly HolidayOverride[]> {
  if (holidayOverrideCache && holidayOverrideCache.expiresAt > Date.now()) return holidayOverrideCache.rows;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_holiday_overrides")
    .select("id,official_date,observed_date,observed_end_date,holiday_name,notes");
  // Never cache a failure: a transient read error must not pin an empty calendar for 10 minutes.
  if (error) throw error;
  const rows = ((data ?? []) as Array<{
    id: number;
    official_date: string;
    observed_date: string;
    observed_end_date: string | null;
    holiday_name: string;
    notes: string | null;
  }>).map((row) => Object.freeze({
    holidayName: row.holiday_name,
    id: row.id,
    notes: row.notes,
    observedDate: row.observed_date,
    observedEndDate: row.observed_end_date ?? row.observed_date,
    officialDate: row.official_date,
  }));
  // Frozen because the array is shared by every caller for the life of the entry — a consumer
  // that mutated a row in place would otherwise poison the cache for everyone.
  holidayOverrideCache = { expiresAt: Date.now() + HOLIDAY_OVERRIDE_CACHE_TTL_MS, rows: Object.freeze(rows) };
  return holidayOverrideCache.rows;
}

/**
 * Does this override touch [dateFromIso, dateToIso]?
 *
 * Byte-for-byte the predicate the SQL used to apply, kept pure so the parity is testable with no
 * database:
 *   or( and(official_date >= from, official_date <= to),
 *       and(observed_date <= to, observed_end_date >= from) )
 *
 * ISO yyyy-mm-dd strings compare correctly with `<`/`>`, which is why this needs no date parsing.
 * `observed_end_date` is NOT NULL in the schema, so the `?? observedDate` fallback applied when
 * the row is mapped is defensive only and cannot make the two forms disagree.
 */
export function holidayOverrideOverlapsRange(
  override: Pick<HolidayOverride, "officialDate" | "observedDate" | "observedEndDate">,
  dateFromIso: string,
  dateToIso: string,
): boolean {
  const officialInRange = override.officialDate >= dateFromIso && override.officialDate <= dateToIso;
  const observedOverlaps = override.observedDate <= dateToIso && override.observedEndDate >= dateFromIso;
  return officialInRange || observedOverlaps;
}

/**
 * Overrides whose official date OR observed range overlaps the requested
 * range — a shift can move a holiday's real off-day(s) in or out of a window
 * relative to its official date, so both ends must be checked.
 */
export async function listHolidayOverridesOverlappingRange(dateFromIso: string, dateToIso: string): Promise<HolidayOverride[]> {
  if (!isIsoDate(dateFromIso) || !isIsoDate(dateToIso)) return [];
  const all = await loadAllHolidayOverrides();
  return all.filter((override) => holidayOverrideOverlapsRange(override, dateFromIso, dateToIso));
}

export async function listHolidayOverridesForYear(year: number): Promise<HolidayOverride[]> {
  return listHolidayOverridesOverlappingRange(`${year}-01-01`, `${year}-12-31`);
}

function isoDatesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Applies observed/postponed overrides onto an already-built date->name map
 * (mutates in place): the official date reverts to a normal working day
 * (unless it happens to be a weekend/other holiday) and every day in the
 * confirmed observed range carries the (possibly admin-edited) name.
 */
export function applyHolidayOverrides(holidaysByDate: Map<string, string>, overrides: HolidayOverride[]): void {
  for (const override of overrides) {
    holidaysByDate.delete(override.officialDate);
    for (const dateIso of isoDatesInRange(override.observedDate, override.observedEndDate)) {
      holidaysByDate.set(dateIso, override.holidayName);
    }
  }
}

function assertValidEntry(entry: HolidayOverrideInput) {
  if (!isIsoDate(entry.officialDate)) throw validationError("Each holiday needs a valid official date.");
  if (!isIsoDate(entry.observedDate)) throw validationError("Each holiday needs a valid observed date.");
  if (entry.observedEndDate !== undefined) {
    if (!isIsoDate(entry.observedEndDate)) throw validationError("Each holiday needs a valid observed end date.");
    if (entry.observedEndDate < entry.observedDate) throw validationError("The observed end date can't be before the observed start date.");
  }
  if (!entry.holidayName?.trim()) throw validationError("Each holiday needs a name.");
}

/**
 * Bulk upsert (by official_date) — the "confirm this holiday" action, used by
 * both the Bulk Holiday Calendar admin page (review a whole year in one pass)
 * and the single-holiday T-3-day confirmation CTA (one entry at a time,
 * same-day confirmation writes observed_date === official_date as a
 * confirmation record).
 */
export async function bulkUpsertHolidayOverrides(entries: HolidayOverrideInput[], actorHrId: string | null): Promise<{ saved: number }> {
  if (entries.length === 0) return { saved: 0 };
  entries.forEach(assertValidEntry);

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("attendance_holiday_overrides")
    .upsert(
      entries.map((entry) => ({
        created_by_hr_id: actorHrId,
        holiday_name: entry.holidayName.trim(),
        notes: entry.notes?.trim() || null,
        observed_date: entry.observedDate,
        observed_end_date: entry.observedEndDate ?? entry.observedDate,
        official_date: entry.officialDate,
        updated_at: nowIso,
      })),
      { onConflict: "official_date" },
    );
  if (error) throw error;

  // Before the audit log, not after: a confirmation the admin just saved must never be read back
  // from a stale cache on this instance, and writeAuditLog is another round trip that could throw.
  invalidateHolidayOverrideCache();
  // The Company Vacation Report caches its holiday dates for 6 h under its own tag (cache audit, 2026-10-26).
  invalidateCompanyVacationReportCache("holiday calendar overrides saved");

  await writeAuditLog({
    actorLoginId: actorHrId ?? "system",
    entityId: "bulk",
    entityType: "attendance_holiday_override",
    newValues: { count: entries.length },
    summary: `Bulk-saved ${entries.length} attendance holiday observed-date override(s)`,
  });

  return { saved: entries.length };
}
