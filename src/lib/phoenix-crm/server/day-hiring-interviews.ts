import { logError } from "@/lib/observability/log";
import { loadInterviewDayEntries } from "@/lib/private-calendar/interview-items";
import type { HiringCalendarInterview } from "@/lib/phoenix-crm/team-calendar";

/**
 * Phoenix CRM — one person's interviews from the HIRING calendar on one day, for the day pages the team calendar opens.
 *
 * 🔴 THE PRIVATE CALENDAR'S OWN LIST (owner, 2026-11-27: "every single entry … must appear in both calendars").
 * Read through `loadInterviewDayEntries`, the private calendar's loader, so the square, the page it opens and the
 * private calendar name the same interviews. DISPLAY ONLY: it proves no half day, moves no figure and writes nothing —
 * a rep who records an "Interviews" day still records it himself, and that record keeps its own list.
 *
 * Never in the test world (interviews belong to real people), never for a vacant seat. A failed read is SAID
 * (`unread`), never shown as a day without interviews.
 */
export async function readDayHiringInterviews(
  hrId: string | null,
  date: string,
  isTest: boolean,
): Promise<{ interviews: HiringCalendarInterview[]; unread: boolean }> {
  if (isTest || !hrId) return { interviews: [], unread: false };
  const { entries, ready } = await loadInterviewDayEntries([hrId], date, date);
  if (!ready) {
    logError("Phoenix CRM day page could not read the hiring calendar's interviews", {
      labels: { event: "phoenix_crm_day_interviews_unread" },
    });
  }
  return {
    interviews: entries.filter((entry) => entry.date === date).map(({ part, time, title }) => ({ part, time, title })),
    unread: !ready,
  };
}
