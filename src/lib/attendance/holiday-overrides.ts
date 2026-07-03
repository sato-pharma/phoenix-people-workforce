// Bulk holiday calendar: admin-configured observed/postponed dates for
// official holidays, layered on top of the raw Google/company holiday
// source (national-holidays.ts) used by buildAttendanceCalendarContext.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { validationError } from "@/lib/http/api-errors";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";

// Local ISO-date check (not imported from working-days.ts) to avoid a
// circular import: working-days.ts applies these overrides onto the
// calendar context it builds.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(value: string | null | undefined): value is string {
  return ISO_DATE_PATTERN.test(String(value ?? ""));
}

export type HolidayOverride = {
  id: number;
  officialDate: string;
  observedDate: string;
  holidayName: string;
  notes: string | null;
};

export type HolidayOverrideInput = {
  officialDate: string;
  observedDate: string;
  holidayName: string;
  notes?: string | null;
};

/**
 * Overrides whose official OR observed date falls in the requested range —
 * a shift can move a holiday's real off-day in or out of a window relative
 * to its official date, so both ends must be checked.
 */
export async function listHolidayOverridesOverlappingRange(dateFromIso: string, dateToIso: string): Promise<HolidayOverride[]> {
  if (!isIsoDate(dateFromIso) || !isIsoDate(dateToIso)) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_holiday_overrides")
    .select("id,official_date,observed_date,holiday_name,notes")
    .or(
      `and(official_date.gte.${dateFromIso},official_date.lte.${dateToIso}),and(observed_date.gte.${dateFromIso},observed_date.lte.${dateToIso})`,
    );
  if (error) throw error;
  return ((data ?? []) as Array<{ id: number; official_date: string; observed_date: string; holiday_name: string; notes: string | null }>).map(
    (row) => ({
      holidayName: row.holiday_name,
      id: row.id,
      notes: row.notes,
      observedDate: row.observed_date,
      officialDate: row.official_date,
    }),
  );
}

export async function listHolidayOverridesForYear(year: number): Promise<HolidayOverride[]> {
  return listHolidayOverridesOverlappingRange(`${year}-01-01`, `${year}-12-31`);
}

/**
 * Applies observed/postponed overrides onto an already-built holiday map
 * (mutates in place): the official date reverts to a normal working day
 * (unless it happens to be a weekend/other holiday) and the observed date
 * becomes the one that carries the holiday name.
 */
export function applyHolidayOverrides(holidaysByDate: Map<string, string>, overrides: HolidayOverride[]): void {
  for (const override of overrides) {
    holidaysByDate.delete(override.officialDate);
    holidaysByDate.set(override.observedDate, override.holidayName);
  }
}

function assertValidEntry(entry: HolidayOverrideInput) {
  if (!isIsoDate(entry.officialDate)) throw validationError("Each holiday needs a valid official date.");
  if (!isIsoDate(entry.observedDate)) throw validationError("Each holiday needs a valid observed date.");
  if (!entry.holidayName?.trim()) throw validationError("Each holiday needs a name.");
}

/**
 * Bulk upsert (by official_date) — the "bulk holiday calendar" admin action:
 * review a whole year's computed holidays in one pass and save every
 * observed-date confirmation/correction in a single call.
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
        official_date: entry.officialDate,
        updated_at: nowIso,
      })),
      { onConflict: "official_date" },
    );
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: actorHrId ?? "system",
    entityId: "bulk",
    entityType: "attendance_holiday_override",
    newValues: { count: entries.length },
    summary: `Bulk-saved ${entries.length} attendance holiday observed-date override(s)`,
  });

  return { saved: entries.length };
}

export type HolidayCalendarYearRow = {
  officialDate: string;
  /** Defaults to officialDate until an admin override is saved. */
  observedDate: string;
  holidayName: string;
  source: "company" | "google_calendar";
  notes: string | null;
  hasOverride: boolean;
};

/**
 * The whole year's computed holidays (Google + company), each pre-filled
 * with its saved observed-date override if one exists — the row set the
 * bulk holiday calendar admin UI reviews and edits in one pass.
 */
export async function buildHolidayCalendarYearView(year: number): Promise<{ rows: HolidayCalendarYearRow[]; sourceConnected: boolean }> {
  const monthResults = await Promise.all(
    Array.from({ length: 12 }, (_, index) => getEgyptianNationalHolidays({ month: index + 1, year }).catch(() => null)),
  );

  const byOfficialDate = new Map<string, HolidayCalendarYearRow>();
  let sourceConnected = true;
  for (const result of monthResults) {
    if (!result) {
      sourceConnected = false;
      continue;
    }
    if (!result.connected) sourceConnected = false;
    for (const holiday of result.holidays) {
      if (byOfficialDate.has(holiday.startDate)) continue;
      byOfficialDate.set(holiday.startDate, {
        hasOverride: false,
        holidayName: holiday.name,
        notes: null,
        observedDate: holiday.startDate,
        officialDate: holiday.startDate,
        source: holiday.source,
      });
    }
  }

  const overrides = await listHolidayOverridesForYear(year).catch(() => []);
  for (const override of overrides) {
    const existing = byOfficialDate.get(override.officialDate);
    byOfficialDate.set(override.officialDate, {
      hasOverride: true,
      holidayName: override.holidayName,
      notes: override.notes,
      observedDate: override.observedDate,
      officialDate: override.officialDate,
      source: existing?.source ?? "company",
    });
  }

  return {
    rows: Array.from(byOfficialDate.values()).sort((left, right) => left.officialDate.localeCompare(right.officialDate)),
    sourceConnected,
  };
}
