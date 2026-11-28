/**
 * The Far-visit week page's one read, shared by the admin page and the portal copy: the week asked for, and the
 * day opened from a cell when the address names one. A day outside the week, or a territory outside the reader's
 * scope, opens nothing: the page simply leaves the detail out.
 */
import { parseFarVisitWeekFilter } from "@/lib/phoenix-crm/far-visit-week-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadFarVisitWeekDay, loadFarVisitWeekReport, type FarVisitWeekDayItem, type FarVisitWeekReport } from "@/lib/phoenix-crm/server/far-visit-week-report";

export type FarVisitWeekSelected = { seatId: string; date: string; repName: string; items: FarVisitWeekDayItem[] };

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export async function loadFarVisitWeekPage(
  viewer: PhoenixCrmViewer,
  params: Record<string, string | string[] | undefined>,
): Promise<{ report: FarVisitWeekReport; selected: FarVisitWeekSelected | null }> {
  const report = await loadFarVisitWeekReport(viewer, first(params.week) || null, parseFarVisitWeekFilter((name) => first(params[name])));
  const seatId = first(params.seat);
  const date = first(params.date);
  // Only a row the report itself drew (after the filters) can open, so a territory outside the reader's scope is never asked for.
  const row = report.rows.find((entry) => entry.seatId === seatId);
  if (!row || !report.week.days.includes(date)) return { report, selected: null };
  const items = await loadFarVisitWeekDay(viewer, report, seatId, date);
  return { report, selected: { seatId, date, repName: row.repName, items } };
}
