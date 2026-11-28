/**
 * The Far-visit week page's one read, shared by the admin page and the portal copy: the weeks asked for (one or
 * several, owner 28 Nov 2026), with the filters, and the day opened from a cell when the address names one. A day
 * outside the chosen weeks, or a territory outside the reader's scope or the filters, opens nothing: the page simply
 * leaves the detail out.
 */
import { parseFarVisitWeekFilter } from "@/lib/phoenix-crm/far-visit-week-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  loadFarVisitWeekDay,
  loadFarVisitWeeksReport,
  type FarVisitWeekDayItem,
  type FarVisitWeeksReport,
} from "@/lib/phoenix-crm/server/far-visit-week-report";

export type FarVisitWeekSelected = { seatId: string; date: string; repName: string; items: FarVisitWeekDayItem[] };

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function all(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

export async function loadFarVisitWeekPage(
  viewer: PhoenixCrmViewer,
  params: Record<string, string | string[] | undefined>,
): Promise<{ report: FarVisitWeeksReport; selected: FarVisitWeekSelected | null }> {
  const report = await loadFarVisitWeeksReport(viewer, all(params.week), parseFarVisitWeekFilter((name) => first(params[name])));
  const seatId = first(params.seat);
  const date = first(params.date);
  // Only a row the report itself drew (after the filters), in a week it holds, can open — so a territory outside the
  // reader's scope is never asked for.
  const week = report.weeks.find((entry) => entry.week.days.includes(date));
  const row = week?.rows.find((entry) => entry.seatId === seatId);
  if (!week || !row) return { report, selected: null };
  const items = await loadFarVisitWeekDay(viewer, week, seatId, date);
  return { report, selected: { seatId, date, repName: row.repName, items } };
}
