/**
 * Phoenix CRM — the Visit report's result filters: narrow an applied report to one person, one day,
 * planned or unplanned visits, or one position against the place (owner, 2026-10-16).
 *
 * 🔴 ONE MATCHER FOR THE SCREEN AND THE FILE. The table, the map and the dashboard narrow through
 * `narrowVisitReportView`, and the workbook route reads the same four parameters and narrows through the
 * same function, so a narrowed screen and the file downloaded from it hold the same visits and the same
 * figures. No server imports and no I/O: the page and the route both run it.
 *
 * The filters only ever REMOVE visits from an answer the loader already shaped for the reader, so they can
 * never show a field, a person or a position the reader was not already given.
 */

import { buildVisitReportDashboard, countVisitReportFilled, visitReportDays } from "@/lib/phoenix-crm/visit-report-dashboard";
import type { VisitReportField, VisitReportRow, VisitReportView } from "@/lib/phoenix-crm/visit-report-fields";

export type VisitReportPlannedFilter = "planned" | "unplanned";

export type VisitReportFilter = {
  /** Who visited, by name, exactly as the rows carry it — ANY person on the visit, not only the one it is credited to. */
  who: string | null;
  /** One visit day, YYYY-MM-DD. */
  day: string | null;
  planned: VisitReportPlannedFilter | null;
  /** One position against the place, exactly as the rows word it, or `NO_POSITION`. */
  position: string | null;
};

export const EMPTY_VISIT_REPORT_FILTER: VisitReportFilter = { day: null, planned: null, position: null, who: null };

/** The filter's own words for a visit that carries no position against a place. */
export const NO_POSITION = "No position recorded";

const FAR = "Far from the place";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 200;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= TEXT_MAX ? text : null;
}

/** A filter read from anything with a `get` — the route's search parameters, or the page's. */
export function readVisitReportFilter(get: (key: string) => string | null): VisitReportFilter {
  const day = cleanText(get("day"));
  const planned = get("planned");
  return {
    day: day && DAY.test(day) ? day : null,
    planned: planned === "planned" || planned === "unplanned" ? planned : null,
    position: cleanText(get("position")),
    who: cleanText(get("who")),
  };
}

/** The filter as query parameters — only the parts that are set, so an unfiltered link stays as it was. */
export function visitReportFilterParams(filter: VisitReportFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.who) params.who = filter.who;
  if (filter.day) params.day = filter.day;
  if (filter.planned) params.planned = filter.planned;
  if (filter.position) params.position = filter.position;
  return params;
}

export function isVisitReportFilterEmpty(filter: VisitReportFilter): boolean {
  return !filter.who && !filter.day && !filter.planned && !filter.position;
}

function positionOf(row: VisitReportRow): string {
  return row.locationFlag ?? NO_POSITION;
}

/**
 * Everyone on the visit, by name (owner, 2026-10-20: "when filter by manager u find no manager"). "Who visited"
 * used to offer and match the person a visit is CREDITED to alone, so the district, regional or national manager
 * on a double or chain visit, and the product manager the rep ticked, could never be chosen. A row that carries no
 * list — one built before the field existed — still answers for the person it is credited to.
 */
export function visitReportParticipants(row: Pick<VisitReportRow, "participants" | "repName">): string[] {
  return Array.isArray(row.participants) && row.participants.length > 0 ? row.participants : [row.repName];
}

export function matchesVisitReportFilter(row: VisitReportRow, filter: VisitReportFilter): boolean {
  if (filter.who && !visitReportParticipants(row).includes(filter.who)) return false;
  if (filter.day && row.visitDate !== filter.day) return false;
  if (filter.planned === "planned" && !row.planned) return false;
  if (filter.planned === "unplanned" && row.planned) return false;
  if (filter.position && positionOf(row) !== filter.position) return false;
  return true;
}

export type VisitReportFilterOptions = { who: string[]; days: string[]; positions: string[] };

/**
 * What a reader may narrow to: only the values the applied report holds, so no choice ever empties the
 * page. "Far from the place" leads the positions — it is the one the owner asked to find — then the rest
 * by how many visits carry them, with a blank position last.
 */
export function visitReportFilterOptions(rows: ReadonlyArray<VisitReportRow>): VisitReportFilterOptions {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(positionOf(row), (counts.get(positionOf(row)) ?? 0) + 1);
  const rank = (position: string): number => (position === FAR ? 0 : position === NO_POSITION ? 2 : 1);
  const positions = [...counts.keys()].sort(
    (left, right) => rank(left) - rank(right) || (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left.localeCompare(right),
  );
  return {
    days: visitReportDays(rows),
    positions,
    who: [...new Set(rows.flatMap((row) => visitReportParticipants(row)))].sort((left, right) => left.localeCompare(right)),
  };
}

function dayText(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
  return `${Number(day.slice(8, 10))} ${month} ${day.slice(0, 4)}`;
}

/** The filter in words, for the screen and the workbook's subtitle; empty when nothing is narrowed. */
export function describeVisitReportFilter(filter: VisitReportFilter): string {
  const parts: string[] = [];
  if (filter.who) parts.push(filter.who);
  if (filter.day) parts.push(dayText(filter.day));
  if (filter.planned) parts.push(filter.planned === "planned" ? "planned visits" : "unplanned visits");
  if (filter.position) parts.push(filter.position);
  return parts.join(" · ");
}

/**
 * The applied report narrowed by the filter: its visits, its count, its days, its "recorded on X of Y"
 * counts and its dashboard, all worked out again from the visits that are left. An empty filter returns
 * the report untouched, so the server's own figures stand.
 */
export function narrowVisitReportView(view: VisitReportView, filter: VisitReportFilter, fields: ReadonlyArray<VisitReportField>): VisitReportView {
  if (isVisitReportFilterEmpty(filter)) return view;
  const rows = view.rows.filter((row) => matchesVisitReportFilter(row, filter));
  const days = visitReportDays(rows);
  const filled = countVisitReportFilled(rows, fields);
  return {
    ...view,
    dashboard: buildVisitReportDashboard({ days, fields, filled, rows }),
    days,
    filled,
    rows,
    total: rows.length,
  };
}
