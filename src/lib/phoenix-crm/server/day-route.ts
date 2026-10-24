import { cairoWallClock } from "@/lib/format/cairo-zone";
import { logError } from "@/lib/observability/log";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { readsLocationDetail, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, dedupeIds, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — a day's visits as a ROUTE, for the admin day page's map (owner, 2026-10-24: a square on the
 * admin calendar should open the day "in a new admin tab with a route map", like Workforce Compliance's).
 *
 * 🔴 THE POINTS ARE THE SUPER ADMIN'S AND THE SFE MANAGER'S ALONE — `readsLocationDetail`, asked BEFORE any read.
 * A map of where a rep stood is the raw reading behind every distance, and the owner's three tiers (2026-10-02)
 * give the raw reading to those two readers only: a district manager, an RSM, the NSM and the CEO read the
 * distance and nothing behind it, and the rep reads nothing at all (Golden Rule #1). Anyone else gets `null`,
 * which the page draws as no map — never an empty one, which would read as "he went nowhere".
 *
 * It is read here and not carried on the day views, because `VisitRow` and `ManagerDayVisit` deliberately hold
 * no coordinates (a visit row says `hasPin`, never where): the point travels only to the one page that draws it.
 *
 * A visit with no usable point — the Super Admin's own "missed visit", entered with no location by design — is
 * left off the map, never placed at a made-up point.
 */

/** One stop, in the shape `FieldWorkforceRouteMap` draws: `checkDate` is a CAIRO WALL CLOCK tagged `Z`. */
export type DayRouteStop = {
  id: string;
  contactName: string | null;
  address: string | null;
  checkDate: string;
  lat: number;
  lon: number;
};

/** A visit the page already holds, and which table its point lives in. */
export type DayRouteVisit = {
  table: "visits" | "manager_visits";
  rowId: string;
  customerName: string | null;
  address: string | null;
};

type Row = Record<string, unknown>;

async function readPoints(table: "phoenix_crm_visits" | "phoenix_crm_manager_visits", ids: string[]): Promise<Row[]> {
  const parts = await Promise.all(
    chunk(dedupeIds(ids), 100).map(async (part) => {
      const { data, error } = await getSupabaseAdmin().from(table).select("id, lat, lon, captured_at").in("id", part);
      throwIfError(error);
      return (data ?? []) as Row[];
    }),
  );
  return parts.flat();
}

/** The day's stops in the order they were logged, or null when this viewer may not see where anybody stood. */
export async function loadDayRoute(viewer: PhoenixCrmViewer, visits: ReadonlyArray<DayRouteVisit>): Promise<DayRouteStop[] | null> {
  if (!readsLocationDetail(viewer)) return null;
  const ids = (table: DayRouteVisit["table"]) => visits.filter((visit) => visit.table === table).map((visit) => visit.rowId);
  const [repRows, managerRows] = await Promise.all([
    ids("visits").length > 0 ? readPoints("phoenix_crm_visits", ids("visits")) : Promise.resolve([]),
    ids("manager_visits").length > 0 ? readPoints("phoenix_crm_manager_visits", ids("manager_visits")) : Promise.resolve([]),
  ]);
  const pointOf = new Map<string, Row>();
  for (const row of repRows) pointOf.set(`visits:${String(row.id)}`, row);
  for (const row of managerRows) pointOf.set(`manager_visits:${String(row.id)}`, row);

  const stops: DayRouteStop[] = [];
  const seen = new Set<string>();
  for (const visit of visits) {
    const key = `${visit.table}:${visit.rowId}`;
    // A chain visit names two managers, so a manager's day can hold the same ride twice: one stop each.
    if (seen.has(key)) continue;
    seen.add(key);
    const row = pointOf.get(key);
    const lat = numberOrNull(row?.lat);
    const lon = numberOrNull(row?.lon);
    const at = typeof row?.captured_at === "string" ? new Date(row.captured_at) : null;
    if (lat === null || lon === null || !isUsableFix(lat, lon) || !at || Number.isNaN(at.getTime())) continue;
    stops.push({
      id: key,
      contactName: visit.customerName,
      address: visit.address,
      checkDate: cairoWallClock(at).toISOString(),
      lat,
      lon,
    });
  }
  return stops.sort((left, right) => left.checkDate.localeCompare(right.checkDate));
}

/** What the admin day page draws its map from. `routeUnread` is said on the page, never drawn as an empty map. */
export type DayRouteLoad = { route: DayRouteStop[] | null; routeUnread: boolean };

/**
 * The route, or the fact that it could not be read. Only ever an addition to the day: a failed read loses the
 * map and keeps the page, exactly as the day's other annotations do.
 */
export async function loadDayRouteSafely(viewer: PhoenixCrmViewer, visits: ReadonlyArray<DayRouteVisit>): Promise<DayRouteLoad> {
  try {
    return { route: await loadDayRoute(viewer, visits), routeUnread: false };
  } catch (error) {
    logError("Phoenix CRM day page could not read the route", { error, labels: { event: "phoenix_crm_day_route_unread" } });
    return { route: null, routeUnread: readsLocationDetail(viewer) };
  }
}

/**
 * Which table a manager-day visit's point lives in, read off the id the manager-day loader minted for it —
 * `own:<id>` for his own single visit, `rep:<id>` and `ride:<id>:<person>` for a visit a rep logged.
 */
export function dayRouteVisitOf(id: string): Pick<DayRouteVisit, "table" | "rowId"> | null {
  const [kind, rowId] = id.split(":");
  if (!rowId) return null;
  if (kind === "own") return { table: "manager_visits", rowId };
  if (kind === "rep" || kind === "ride") return { table: "visits", rowId };
  return null;
}
