/**
 * 🔴 EVERY PRIVATE-CALENDAR ENTRY, FOR PHOENIX CRM'S CALENDAR TOO (owner, 2026-11-27: "every single entry done must
 * be appear in both calendars").
 *
 * Phoenix CRM's team calendar draws its OWN visits, ride-alongs, recorded day activities and approved leave. Every
 * other source the private calendar shows — the approved plan, the outstation trip, the excuse, the office
 * attendance, the interview, the national holiday, a leave still waiting or a half day, and an admin-verified
 * correction — reaches it here, cut from the private calendar's OWN items, so the two calendars can never list two
 * different things. DISPLAY ONLY: an entry never enters a figure, never proves a day and is never written anywhere.
 *
 * Pure. The loader that feeds it is `loadPrivateCalendarEntriesForPhoenixCrm` in `service.ts`.
 */

import { privateCalendarSourceLabels, type PrivateCalendarItem, type PrivateCalendarSource } from "@/lib/private-calendar/logic";

/** The sources Phoenix CRM draws from its own records, so a copy here would show the same work twice. */
export const SOURCES_PHOENIX_CRM_DRAWS_ITSELF: readonly PrivateCalendarSource[] = ["field_visit", "double_visit"];

/** One private-calendar entry on one person's day, in the private calendar's own words. */
export type PrivateCalendarCrmEntry = {
  /** Null for an entry that is everyone's — a national holiday. */
  hrId: string | null;
  date: string;
  source: PrivateCalendarSource;
  /** "Approved plan", "Outstation trip", "Excuse", ... — the private calendar's own source label. */
  label: string;
  time: string;
  title: string;
  status: string;
};

function nextDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * The private calendar's items, one entry per person-day inside the window, without the two sources Phoenix CRM
 * draws itself. A trip or a leave spanning several days lands on each of them. Sorted by day, then time.
 */
export function phoenixCrmEntriesOf(
  items: readonly PrivateCalendarItem[],
  window: { start: string; end: string },
): PrivateCalendarCrmEntry[] {
  const out: PrivateCalendarCrmEntry[] = [];
  for (const item of items) {
    if (SOURCES_PHOENIX_CRM_DRAWS_ITSELF.includes(item.source)) continue;
    const first = item.startDate > window.start ? item.startDate : window.start;
    const last = (item.endDate ?? item.startDate) < window.end ? (item.endDate ?? item.startDate) : window.end;
    for (let date = first; date <= last; date = nextDay(date)) {
      out.push({
        date,
        hrId: item.source === "holiday" ? null : item.employeeHrId,
        label: item.sourceLabel || privateCalendarSourceLabels[item.source],
        source: item.source,
        status: item.status ?? "",
        time: item.time ?? "",
        title: item.title,
      });
    }
  }
  return out.sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time));
}
