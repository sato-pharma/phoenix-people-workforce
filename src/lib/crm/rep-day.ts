/**
 * Per-rep-day visit + GPS drill-down ("click a visit day") — the one CRM read that can go to
 * the live API. Policy: **mirror-first, live fallback for recent dates**.
 *
 * - Historical days are served entirely from the synced mirror (no live call) — it holds every
 *   visit + GPS field, so this is complete and fast, and works even if the live CRM is down.
 * - Recent days (today / the last couple of days, where the mirror can lag its ~3×/day sync)
 *   prefer a live call for freshness; if that live call fails we degrade to the mirror, and only
 *   surface the CRM error when the mirror has nothing to show either.
 *
 * Either way the live call lives INSIDE the CRM module, so the "one door" rule holds. Relocated
 * from field-workforce-compliance/ireports360-source.ts, where it used to always call live.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { googleRouteThroughStops } from "@/lib/google-maps/server";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  iReports360GetCheckins,
  iReports360GetVisits,
  iReports360Login,
  type IReports360Checkin,
  type IReports360Visit,
} from "@/lib/crm/client";
import { getIReports360Config, isIReports360Configured } from "@/lib/crm/config";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { queryCheckins } from "@/lib/crm/reads";
import { CRM_VISITS_TABLE } from "@/lib/crm/tables";
import type { CrmCheckinRow } from "@/lib/crm/types";

export type IReports360RepDayVisit = IReports360Visit & {
  kind: "campaign" | "regular";
  mode: "single" | "double";
  partnerName: string | null;
  role: "primary" | "double";
};

export type IReports360DayRouteLeg = {
  distanceKm: number | null;
  durationMinutes: number | null;
};

export type IReports360DayRoute = {
  encodedPolyline: string | null;
  legs: IReports360DayRouteLeg[];
};

export type IReports360RepDayResult = {
  checkins: IReports360Checkin[];
  rep: { crmId: string | null; fullName: string | null; hrId: string } | null;
  route: IReports360DayRoute | null;
  visits: IReports360RepDayVisit[];
};

/** How recent a day must be to prefer a live CRM call over the mirror. The daily sync runs
 * ~3×/day over a 10-day lookback, so only today + the last day or two can be materially staler
 * in the mirror than the live API; older days are already fully synced. */
const REP_DAY_FRESH_LOOKBACK_DAYS = 2;

function isRecentRepDay(day: string): boolean {
  return day >= addDaysIso(todayIso(), -REP_DAY_FRESH_LOOKBACK_DAYS);
}

// In-memory cache of computed driving routes, keyed by rep + day + the exact ordered
// check-in coordinates (so corrected GPS recomputes under a new key). A historical
// rep-day's route never changes, so each unique rep-day costs at most ONE Google Routes
// API call per server process — keeping usage well inside the free monthly tier.
const routeCache = new Map<string, IReports360DayRoute>();
const ROUTE_CACHE_MAX = 5000;

function routeCacheKey(hrId: string, day: string, stops: Array<{ lat: number; lng: number }>): string {
  const coords = stops.map((stop) => `${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}`).join("|");
  return `${hrId}::${day}::${coords}`;
}

/**
 * Driving route through the day's check-ins, cached so a given rep-day hits the Google
 * Routes API at most once. Failures are NOT cached, so it retries automatically once the
 * Maps key is allowed to call the Routes API.
 */
async function getCachedDrivingRoute(
  hrId: string,
  day: string,
  stops: Array<{ lat: number; lng: number }>,
): Promise<IReports360DayRoute | null> {
  if (stops.length < 2) return null;
  const cacheKey = routeCacheKey(hrId, day, stops);
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const drivingRoute = await googleRouteThroughStops(stops);
  if (!drivingRoute) return null;

  const route: IReports360DayRoute = {
    encodedPolyline: drivingRoute.encodedPolyline,
    legs: drivingRoute.legs.map((leg) => ({
      distanceKm: leg.distanceMeters != null ? Math.round((leg.distanceMeters / 1000) * 10) / 10 : null,
      durationMinutes: leg.durationSeconds != null ? Math.round(leg.durationSeconds / 60) : null,
    })),
  };
  if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.clear();
  routeCache.set(cacheKey, route);
  return route;
}

/** Readable partner name for display: strips the "( Area / Line )" annotation and dots, keeps case. */
function cleanAgentDisplayName(name: string | null | undefined): string | null {
  const cleaned = String(name ?? "").split("(")[0].replace(/\./g, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/** Maps a stored `ireports360_checkins` row back onto the live client's check-in shape. */
function checkinFromMirrorRow(row: CrmCheckinRow): IReports360Checkin {
  return {
    address: row.address,
    agentID: row.agent_crm_id,
    checkDate: row.check_date,
    contactID: row.contact_crm_id,
    contactName: row.contact_name,
    id: row.crm_checkin_id,
    lat: row.lat,
    lon: row.lon,
  };
}

type RepDayVisitMirrorRow = {
  agent_crm_id: number;
  agent_name: string | null;
  ampm: string | null;
  attendance: number | null;
  call_type: number | null;
  comment: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_save_date: string | null;
  crm_visit_id: number;
  customer_name: string | null;
  double_crm_id: number | null;
  double_name: string | null;
  visit_date: string;
  visit_type: number;
  visit_type_description: string | null;
};

/** Maps a stored `ireports360_visits` row back onto the live client's visit shape so the same
 * annotate/route pipeline runs regardless of whether the source was live or the mirror. */
function visitFromMirrorRow(row: RepDayVisitMirrorRow): IReports360Visit {
  return {
    agentID: row.agent_crm_id,
    agentName: row.agent_name,
    ampm: row.ampm,
    attendance: row.attendance,
    callType: row.call_type,
    comment: row.comment,
    contactID: row.contact_crm_id,
    contactName: row.contact_name,
    customerName: row.customer_name,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    id: row.crm_visit_id,
    saveDate: row.crm_save_date,
    visitDate: row.visit_date,
    visitType: row.visit_type,
    visitTypeDescription: row.visit_type_description,
  };
}

/**
 * Shared post-processing: keep the records where the rep is the primary agent OR the joined
 * double-visit partner, annotate each visit (kind/role/mode/partner), sort check-ins by time,
 * and compute the cached driving route through the GPS stops. Identical for the live and mirror
 * sources — they differ only in how `allVisits` / `allCheckins` were obtained.
 */
async function buildRepDayResult(
  rep: { crmId: string | null; fullName: string | null; hrId: string },
  agentId: number,
  day: string,
  allVisits: IReports360Visit[],
  allCheckins: IReports360Checkin[],
): Promise<IReports360RepDayResult> {
  const visits: IReports360RepDayVisit[] = allVisits
    .filter(
      (visit) =>
        (visit.agentID === agentId || visit.doubleID === agentId) &&
        (visit.visitDate ?? "").slice(0, 10) === day,
    )
    .map((visit) => {
      const role: "primary" | "double" = visit.agentID === agentId ? "primary" : "double";
      const hasPartner = visit.doubleID != null && visit.doubleID !== 0;
      const partnerName = hasPartner
        ? cleanAgentDisplayName(role === "primary" ? visit.doubleName : visit.agentName)
        : null;
      return {
        ...visit,
        kind: visit.visitType === 0 ? "regular" : "campaign",
        mode: hasPartner ? "double" : "single",
        partnerName,
        role,
      };
    });
  const checkins = allCheckins
    .filter((checkin) => checkin.agentID === agentId && (checkin.checkDate ?? "").slice(0, 10) === day)
    .sort((left, right) => String(left.checkDate).localeCompare(String(right.checkDate)));

  // Cached Google driving route through the coordinate-bearing check-ins (in time order),
  // aligned to the same filter+sort the map uses so leg[i] is stop[i] -> stop[i+1].
  const stops = checkins
    .filter((checkin) => Number.isFinite(checkin.lat) && Number.isFinite(checkin.lon))
    .map((checkin) => ({ lat: checkin.lat as number, lng: checkin.lon as number }));
  const route = await getCachedDrivingRoute(rep.hrId, day, stops);

  return { checkins, rep, route, visits };
}

/** Live-source visits + check-ins for one rep-day (one login, both fetched in parallel). */
async function fetchRepDayFromLive(
  rep: { crmId: string | null; fullName: string | null; hrId: string },
  agentId: number,
  day: string,
): Promise<IReports360RepDayResult> {
  const config = getIReports360Config();
  const token = await iReports360Login(config);
  // Visits are required for this page; GPS check-ins are a best-effort overlay, so a
  // check-ins API problem must never break the core visit drill-down.
  const [allVisits, allCheckins] = await Promise.all([
    iReports360GetVisits(config, token, day, day),
    iReports360GetCheckins(config, token, day, day).catch(() => [] as IReports360Checkin[]),
  ]);
  return buildRepDayResult(rep, agentId, day, allVisits, allCheckins);
}

/** Mirror-source visits + check-ins for one rep-day. Reads the synced tables directly (this
 * module is inside the CRM domain, so it owns the raw table access). */
async function fetchRepDayFromMirror(
  rep: { crmId: string | null; fullName: string | null; hrId: string },
  agentId: number,
  day: string,
): Promise<IReports360RepDayResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_VISITS_TABLE)
    .select(
      "agent_crm_id, agent_name, ampm, attendance, call_type, comment, contact_crm_id, contact_name, crm_save_date, crm_visit_id, customer_name, double_crm_id, double_name, visit_date, visit_type, visit_type_description",
    )
    .eq("visit_date", day)
    .or(`agent_crm_id.eq.${agentId},double_crm_id.eq.${agentId}`);
  if (error) throw new Error(error.message);
  const allVisits = ((data ?? []) as unknown as RepDayVisitMirrorRow[]).map(visitFromMirrorRow);

  const checkinRows = await queryCheckins<CrmCheckinRow>({
    agentCrmIds: [agentId],
    dateFrom: day,
    dateTo: day,
    orderBy: "check_date",
    ascending: true,
  });
  const allCheckins = checkinRows.map(checkinFromMirrorRow);

  return buildRepDayResult(rep, agentId, day, allVisits, allCheckins);
}

/**
 * Read-only drill-down for the "click a visit day" page: the visit records AND the GPS
 * check-ins one rep logged on one day. Resolves the rep's crm_id from the directory, then serves
 * from the mirror (historical) or live (recent, freshest) per the module policy above.
 */
export async function getIReports360RepDayVisits(input: {
  date: string;
  hrId: string;
  preferLive?: boolean;
}): Promise<IReports360RepDayResult> {
  const day = input.date.slice(0, 10);
  // Historical drill-down: include inactive so a rep who has since departed still resolves
  // their name/crm_id for a past day instead of the page rendering blank. This is a single-rep
  // lookup, not a visibility scope gate.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const key = canonicalHrIdKey(input.hrId);
  const employee = directory.find((row) => canonicalHrIdKey(row.hrId) === key) ?? null;
  if (!employee) return { checkins: [], rep: null, route: null, visits: [] };

  const rep = {
    crmId: employee.crmId == null ? null : String(employee.crmId),
    fullName: employee.fullName ?? null,
    hrId: employee.hrId,
  };
  if (!rep.crmId) return { checkins: [], rep, route: null, visits: [] };
  const agentId = Number(rep.crmId);

  const wantLive = (input.preferLive ?? isRecentRepDay(day)) && isIReports360Configured();
  if (wantLive) {
    try {
      return await fetchRepDayFromLive(rep, agentId, day);
    } catch (liveError) {
      // Recent-day live call failed — degrade to the mirror. Only surface the CRM error when
      // the mirror has nothing to show either (so a genuine outage isn't hidden as an empty day).
      const mirror = await fetchRepDayFromMirror(rep, agentId, day);
      if (mirror.visits.length > 0 || mirror.checkins.length > 0) return mirror;
      throw liveError;
    }
  }
  return fetchRepDayFromMirror(rep, agentId, day);
}
