import { logError } from "@/lib/observability/log";
import { privateCalendarSourceLabels } from "@/lib/private-calendar/logic";
import { loadPrivateCalendarEntriesForPhoenixCrm } from "@/lib/private-calendar/service";
import type { PrivateCalendarEntry } from "@/lib/phoenix-crm/team-calendar";

/**
 * Phoenix CRM — one person's PRIVATE-CALENDAR entries on one day, for the day pages the team calendar opens.
 *
 * 🔴 THE PRIVATE CALENDAR'S OWN ENTRIES (owner, 2026-11-27: "every single entry done must be appear in both
 * calendars"). The approved plan, the outstation trip, the excuse, the office attendance, the interview, the national
 * holiday, the leave and the admin-verified correction — read through `loadPrivateCalendarEntriesForPhoenixCrm`, the
 * private calendar's own loaders, so the square, the page it opens and the private calendar name the same entries.
 * DISPLAY ONLY: it proves no day, moves no figure and writes nothing.
 *
 * Never in the test world (these belong to real people), never for a vacant seat. A source that could not be read is
 * SAID (`unread`, its label), never shown as a day without its entries.
 */
export async function readDayPrivateCalendarEntries(
  hrId: string | null,
  date: string,
  isTest: boolean,
): Promise<{ entries: PrivateCalendarEntry[]; unread: string[] }> {
  if (isTest || !hrId) return { entries: [], unread: [] };
  try {
    const { entries, unreadable } = await loadPrivateCalendarEntriesForPhoenixCrm([hrId], date, date);
    if (unreadable.length > 0) {
      logError("Phoenix CRM day page could not read a private-calendar source", {
        labels: { event: "phoenix_crm_day_private_sources_unread", sources: unreadable.join(",") },
      });
    }
    return {
      entries: entries
        .filter((entry) => entry.date === date)
        .map(({ label, source, status, time, title }) => ({ label, source, status, time, title })),
      unread: unreadable.map((source) => privateCalendarSourceLabels[source]),
    };
  } catch (error) {
    logError("Phoenix CRM day page could not read the private calendar", { error, labels: { event: "phoenix_crm_day_private_sources_unread" } });
    return { entries: [], unread: ["Private calendar"] };
  }
}

