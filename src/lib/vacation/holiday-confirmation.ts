// Rule #1: a national holiday's real observed date must never be silently
// trusted from the raw ministry/Google Calendar source across the app.
// Postponements are common (e.g. June 30 Revolution Day observed July 2), so
// a holiday only becomes authoritative — and gets published everywhere via
// getConfirmedNationalHolidays — once a System Admin has explicitly
// confirmed it (same day, or a different observed day) through
// /admin/attendance/holiday-calendar.
//
// This module finds official holidays landing exactly N days from today
// (Cairo local time) that have no confirmation yet, so the daily cron
// (app/api/notifications/holiday-confirmation/route.ts) can nudge a System
// Admin before the day arrives.

import { logError } from "@/lib/observability/log";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";
import { listHolidayOverridesOverlappingRange } from "@/lib/vacation/holiday-override-store";

export const HOLIDAY_CONFIRMATION_LEAD_DAYS = 3;

export type PendingHolidayConfirmation = {
  daysUntil: number;
  officialDate: string;
  name: string;
  source: "company" | "google_calendar";
};

/** Today's date in Cairo local time, as an ISO (YYYY-MM-DD) string. */
export function cairoTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthYearOf(dateIso: string): { month: number; year: number } {
  const [year, month] = dateIso.split("-").map(Number);
  return { month, year };
}

/**
 * Official (raw, unconfirmed) holidays landing exactly `daysAhead` days from
 * today that have no System-Admin-confirmed override yet. Intentionally
 * reads the RAW source (getEgyptianNationalHolidays), not
 * getConfirmedNationalHolidays — the whole point is to catch holidays that
 * have not been confirmed, so we must look at what would happen by default,
 * not the already-confirmed view.
 */
export async function getUpcomingUnconfirmedHolidays(
  daysAhead: number = HOLIDAY_CONFIRMATION_LEAD_DAYS,
): Promise<PendingHolidayConfirmation[]> {
  const targetDateIso = addDaysIso(cairoTodayIso(), daysAhead);
  const { month, year } = monthYearOf(targetDateIso);

  const raw = await getEgyptianNationalHolidays({ month, year });
  // Silence here compounds. The moving Islamic and Coptic holidays are exactly the ones that need
  // confirming AND exactly the ones a Google Calendar outage hides, so a reminder skipped during an
  // outage leaves that holiday unconfirmed — and an unconfirmed holiday is missing again from every
  // later outage, because only a confirmed one survives as an override. Say so instead of returning
  // an empty list that reads as "nothing to confirm" (owner, 2026-09-16). No notification is sent
  // from here: this is an observability record for the daily cron's own run.
  if (!raw.calendarReachable) {
    logError("Holiday confirmation reminder: Google's holiday calendar could not be read", {
      labels: { event: "holiday_confirmation_calendar_unreachable", month, targetDateIso, year },
    });
    return [];
  }
  const candidates = raw.holidays.filter((holiday) => holiday.startDate === targetDateIso);
  if (candidates.length === 0) return [];

  const overrides = await listHolidayOverridesOverlappingRange(targetDateIso, targetDateIso).catch(() => []);
  const confirmedOfficialDates = new Set(overrides.map((override) => override.officialDate));

  return candidates
    .filter((holiday) => !confirmedOfficialDates.has(holiday.startDate))
    .map((holiday) => ({
      daysUntil: daysAhead,
      name: holiday.name,
      officialDate: holiday.startDate,
      source: holiday.source,
    }));
}
