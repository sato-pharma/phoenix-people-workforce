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
import { checkinAgentKey, indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import {
  buildParticipantCrmIdOrFilter,
  buildParticipantHrIdOrFilter,
  collapseDuplicateVisitSubmissionsLiveShape,
  getEffectiveExcludedAgentCrmIds,
  queryCheckins,
} from "@/lib/crm/reads";
import { getCrmCutoverSetting, isOnOrAfterCrmCutover, NO_CRM_CUTOVER } from "@/lib/crm/cutover";
import { loadStartedRepWindows } from "@/lib/crm/phoenix-started-reps";
import { startedWindowCovers } from "@/lib/crm/phoenix-team-starts";
import { CRM_VISITS_UNIFIED_VIEW } from "@/lib/crm/tables";
import type { CrmCheckinRow } from "@/lib/crm/types";

export type IReports360RepDayVisit = IReports360Visit & {
  kind: "campaign" | "regular" | "other";
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

export type IReports360RepDayCheckin = IReports360Checkin & {
  /**
   * Rep name when this check-in is BORROWED — i.e. this person was the double/triple-visitor and
   * the named rep is the one who physically checked in and submitted the visit. null when the
   * person logged the check-in themselves.
   */
  via: string | null;
};

export type IReports360RepDayResult = {
  checkins: IReports360RepDayCheckin[];
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

/**
 * Whose GPS check-ins make up this person's route on a given day.
 *
 * Returns ownerCrmId -> the rep's display name when the check-in is BORROWED, or null when the
 * person logged it themselves.
 *
 * Managers (DM/TM/NSM) have no contact list and never hand-enter a CRM visit — the rep enters it
 * and tags them as the double-visitor — so a manager logs no check-in of their own. Their route is
 * therefore the check-ins of the SUBMITTERS of the visits they appear in. Their own id is always
 * included: it covers a rep who submitted their own visits, and the triple-visit case where a DM
 * submits while tagging the NSM.
 *
 * Pass visits already filtered to this person and day (and with departed agents excluded), so a
 * borrowed check-in can never originate from a visit the caller refuses to display.
 */
export function resolveRepDayCheckinOwners(
  agentId: number,
  dayVisits: Array<{ agentID: number; agentName?: string | null }>,
): Map<number, string | null> {
  const owners = new Map<number, string | null>([[agentId, null]]);
  for (const visit of dayVisits) {
    if (visit.agentID === agentId || owners.has(visit.agentID)) continue;
    owners.set(visit.agentID, cleanAgentDisplayName(visit.agentName));
  }
  return owners;
}

/**
 * The person a visit or check-in names, as one comparable key: the CRM id when the row carries a
 * real one, else `hr:<canonical hr id>`. A vendor row always carries a CRM id, so for it this is the
 * plain id comparison the drill-down always made; a native row for a rep hired after the CRM cutover
 * carries a NULL CRM id and is recognised by its hr id instead.
 */
export function repDayPersonKey(crmId: number | null | undefined, hrId: string | null | undefined): string | null {
  return checkinAgentKey(crmId != null && Number.isFinite(crmId) && crmId !== 0 ? crmId : null, hrId);
}

/**
 * resolveRepDayCheckinOwners over person keys (repDayPersonKey), so a submitter with no CRM id — a
 * rep hired after the cutover — can own a check-in. Same rule, same display names: self is always an
 * owner with a null name, every other submitter of the day's visits is a borrowed owner.
 */
export function resolveRepDayCheckinOwnerKeys(
  selfKey: string,
  dayVisits: Array<{ agentID: number | null; agentHrId?: string | null; agentName?: string | null }>,
): Map<string, string | null> {
  const owners = new Map<string, string | null>([[selfKey, null]]);
  for (const visit of dayVisits) {
    const key = repDayPersonKey(visit.agentID, visit.agentHrId);
    if (key == null || owners.has(key)) continue;
    owners.set(key, cleanAgentDisplayName(visit.agentName));
  }
  return owners;
}

/** The drilled person: his CRM id when he has one (null for a rep hired after the cutover), and his hr id. */
type RepDaySelf = { crmId: number | null; hrId: string };

/** The live client's shapes, plus the hr ids only the unified view carries (absent on a live row). */
type RepDayVisitSource = IReports360Visit & {
  agentHrId?: string | null;
  doubleHrId?: string | null;
  // The chain visit's OTHER partner — the senior above the manager, or the product manager who came
  // with him. Optional because the live vendor client has no such field and both vendor branches of
  // the door emit NULL: only a Phoenix `chain` visit fills it.
  double2HrId?: string | null;
  double2ID?: number | null;
  double2Name?: string | null;
};
type RepDayCheckinSource = IReports360Checkin & { agentHrId?: string | null };

/** Readable partner name for display: strips the "( Area / Line )" annotation and dots, keeps case. */
function cleanAgentDisplayName(name: string | null | undefined): string | null {
  const cleaned = String(name ?? "").split("(")[0].replace(/\./g, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/** Maps a stored `ireports360_checkins` row back onto the live client's check-in shape. */
function checkinFromMirrorRow(row: CrmCheckinRow): RepDayCheckinSource {
  return {
    address: row.address,
    agentHrId: row.agent_hr_id,
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
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  attendance: number | null;
  call_type: number | null;
  comment: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_contact_grade: string | null;
  crm_region_id: number | null;
  crm_region_name: string | null;
  crm_save_date: string | null;
  crm_visit_id: number;
  customer_name: string | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  double2_crm_id: number | null;
  double2_hr_id: string | null;
  double2_name: string | null;
  speciality: string | null;
  visit_date: string;
  visit_type: number;
  visit_type_description: string | null;
};

/** Maps a stored `ireports360_visits` row back onto the live client's visit shape so the same
 * annotate/route pipeline runs regardless of whether the source was live or the mirror. */
function visitFromMirrorRow(row: RepDayVisitMirrorRow): RepDayVisitSource {
  return {
    agentHrId: row.agent_hr_id,
    agentID: row.agent_crm_id,
    agentName: row.agent_name,
    ampm: row.ampm,
    attendance: row.attendance,
    callType: row.call_type,
    comment: row.comment,
    contactID: row.contact_crm_id,
    contactName: row.contact_name,
    contactGrade: row.crm_contact_grade,
    customerName: row.customer_name,
    doubleHrId: row.double_hr_id,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    double2HrId: row.double2_hr_id,
    double2ID: row.double2_crm_id,
    double2Name: row.double2_name,
    id: row.crm_visit_id,
    region: row.crm_region_name,
    regionID: row.crm_region_id,
    saveDate: row.crm_save_date,
    speciality: row.speciality,
    visitDate: row.visit_date,
    visitType: row.visit_type,
    visitTypeDescription: row.visit_type_description,
  };
}

/**
 * WHICH of an owner's check-ins are this person's route — the half `resolveRepDayCheckinOwnerKeys`
 * does not answer.
 *
 * 🔴 THE DEFECT THIS CLOSES. The owner set says whose phone may speak for this person today. Until
 * now EVERY check-in by one of those phones was attributed to him, for the whole day — so a manager
 * who rode along for two calls in the morning was drawn as having made every stop the rep made
 * afterwards, alone. The day then ended at the REP's last check-in, which is how this screen came
 * to report a manager finishing at 15:20 on a day he was with that rep until lunch.
 *
 * The rule now: a person's OWN check-ins are his whole day, unchanged. A BORROWED check-in counts
 * only when it is the fix for a call HE WAS ON — decided by {@link pickCheckinForVisit}, the one
 * canonical agent + contact + day matcher the Visits Report and the CRM master tab already use, so
 * a stop resolves the same way on every screen that shows one. A borrowed visit with no real
 * contact (campaign, meeting, leave) matches nothing, which is correct: those rows carry no GPS.
 *
 * Pure and exported for its test — the surrounding builder fetches a driving route and cannot be
 * unit-tested.
 */
export function selectRepDayCheckins<C extends RepDayCheckinSource>(input: {
  checkins: readonly C[];
  day: string;
  dayVisits: readonly RepDayVisitSource[];
  owners: ReadonlyMap<string, string | null>;
  selfKey: string;
}): Array<C & { via: string | null }> {
  const { checkins, day, dayVisits, owners, selfKey } = input;
  const ownerKeyOf = (checkin: RepDayCheckinSource) => repDayPersonKey(checkin.agentID, checkin.agentHrId) ?? "";
  const onDay = checkins.filter(
    (checkin) => owners.has(ownerKeyOf(checkin)) && String(checkin.checkDate ?? "").slice(0, 10) === day,
  );

  // The canonical matcher speaks snake_case mirror rows; these are the live client's shape. Same
  // adapter pattern as collapseDuplicateVisitSubmissionsLiveShape, and it carries the original row
  // back so the caller keeps every field it displays.
  const index = indexCheckinsByAgentContactDay(
    onDay.map((checkin) => ({
      agent_crm_id: checkin.agentID ?? null,
      agent_hr_id: checkin.agentHrId ?? null,
      check_date: checkin.checkDate ?? null,
      contact_crm_id: checkin.contactID ?? null,
      source: checkin,
    })),
  );

  const borrowed = new Set<C>();
  for (const visit of dayVisits) {
    const ownerKey = repDayPersonKey(visit.agentID, visit.agentHrId);
    // His own rows are handled below — this loop only rescues the stops he rode along on.
    if (ownerKey == null || ownerKey === selfKey) continue;
    const matched = pickCheckinForVisit(
      {
        agentCrmId: visit.agentID ?? null,
        agentHrId: visit.agentHrId ?? null,
        contactCrmId: visit.contactID ?? null,
        crmSaveDate: visit.saveDate ?? null,
        visitDay: day,
      },
      index,
    );
    if (matched) borrowed.add(matched.source);
  }

  return onDay
    .filter((checkin) => ownerKeyOf(checkin) === selfKey || borrowed.has(checkin))
    .map((checkin) => ({ ...checkin, via: owners.get(ownerKeyOf(checkin)) ?? null }))
    // Plain string comparison, not localeCompare: these are ISO timestamps, and locale collation
    // gives digits/hyphens variable weight, so the order would depend on the runtime's locale + ICU
    // data. The route legs are aligned to THIS order (leg[i] = stop[i] -> stop[i+1]).
    .sort((left, right) => {
      const a = String(left.checkDate ?? "");
      const b = String(right.checkDate ?? "");
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/**
 * Shared post-processing: keep the records where the rep is the primary agent OR the joined
 * double-visit partner, annotate each visit (kind/role/mode/partner), sort check-ins by time,
 * and compute the cached driving route through the GPS stops. Identical for the live and mirror
 * sources — they differ only in how `allVisits` / `allCheckins` were obtained.
 */
async function buildRepDayResult(
  rep: { crmId: string | null; fullName: string | null; hrId: string },
  self: RepDaySelf,
  day: string,
  allVisits: RepDayVisitSource[],
  allCheckins: RepDayCheckinSource[],
): Promise<IReports360RepDayResult> {
  // Every "is this him" test compares person keys: his CRM id when he has one — the plain id
  // comparison this always was — else his hr id. `hrId` comes from the directory, so the key exists.
  const selfKey = repDayPersonKey(self.crmId, self.hrId) ?? "";
  // Effective (static ∪ live departed) exclusion, resolved per call so a newly-resigned rep is
  // dropped without a redeploy. Applied to BOTH the live and mirror sources so this drill-down
  // stays consistent with the aggregate metric that links to it (a double visit whose PRIMARY
  // agent is excluded, with the drilled rep as partner, must not surface here).
  const excludedAgentIds = new Set<number>(await getEffectiveExcludedAgentCrmIds());
  const dayVisits = allVisits
    // Resigned/departed agents are invisible in every aggregate (agent-side exclusion), so drop
    // their rows here too — keeps this drill-down consistent with the metric it links to and makes
    // the live and mirror sources agree.
    .filter((visit) => !excludedAgentIds.has(visit.agentID))
    .filter(
      (visit) =>
        (repDayPersonKey(visit.agentID, visit.agentHrId) === selfKey ||
          repDayPersonKey(visit.doubleID, visit.doubleHrId) === selfKey ||
          // BOTH partner slots, or the widened read above achieves nothing: the row arrives and this
          // filter drops it again, and the chain's other person still reads as not having worked.
          repDayPersonKey(visit.double2ID, visit.double2HrId) === selfKey) &&
        (visit.visitDate ?? "").slice(0, 10) === day,
    );
  // Burst-duplicate collapse: every aggregate that links INTO this page (FWC day cells, portal
  // Team Calendar counts, DV analytics) already collapses the CRM mobile client's re-saves of
  // one real stop at read time — without the same collapse here, a day cell of "4" opens a
  // drill-down listing the same visit 2–8 times (confirmed in production, 2026-08-01). Applied
  // to both sources: the mirror never collapses for this caller, and the live API returns the
  // raw duplicates too.
  const visits: IReports360RepDayVisit[] = collapseDuplicateVisitSubmissionsLiveShape(dayVisits)
    .map((visit) => {
      const role: "primary" | "double" = repDayPersonKey(visit.agentID, visit.agentHrId) === selfKey ? "primary" : "double";
      // A native double visit with a partner who has no CRM id carries a NULL `double_crm_id` and
      // names the partner by `double_hr_id` alone — still a double visit.
      const hasPartner = (visit.doubleID != null && visit.doubleID !== 0) || canonicalHrIdKey(visit.doubleHrId) != null;
      const partnerName = hasPartner
        ? cleanAgentDisplayName(role === "primary" ? visit.doubleName : visit.agentName)
        : null;
      return {
        ...visit,
        // Only Regular (0) and Campaign (-8) are fieldwork; everything else (Vacation, Meeting,
        // Training, …) is "other" — labeling it "campaign" was wrong. The real vendor label still
        // shows via visitTypeDescription.
        kind: visit.visitType === 0 ? "regular" : visit.visitType === -8 ? "campaign" : "other",
        mode: hasPartner ? "double" : "single",
        partnerName,
        role,
      };
    });
  // Whose check-ins are THIS person's route today.
  //
  // Managers (DM/TM/NSM) have no contact list and never hand-enter a CRM visit — the rep enters it
  // and tags them as the double-visitor. A manager therefore logs NO check-in of their own, and
  // filtering to `checkin.agentID === agentId` left them with an EMPTY route while their visits
  // listed fine (verified in production: A-7, crm 1234, had 0 own check-ins on Jun 14 while the rep
  // he double-visited, crm 1483, had 4 mappable ones).
  //
  // The day's check-in owners are the SUBMITTERS of the visits this person appears in, plus their
  // own id — which covers a rep who submitted their own visits and the triple-visit case where a DM
  // submits while tagging the NSM. Derived from `dayVisits`, so departed-agent exclusion already
  // applies and a borrowed check-in can never come from a visit this page refuses to show.
  const checkinOwners = resolveRepDayCheckinOwnerKeys(selfKey, dayVisits);

  // Owning a phone is not the same as owning its whole day — selectRepDayCheckins narrows a
  // BORROWED phone to the calls this person was actually on. See its docblock for what that fixes.
  const checkins: IReports360RepDayCheckin[] = selectRepDayCheckins({
    checkins: allCheckins.filter((checkin) => !excludedAgentIds.has(checkin.agentID)),
    day,
    dayVisits,
    owners: checkinOwners,
    selfKey,
  });

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
  self: RepDaySelf,
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
  return buildRepDayResult(rep, self, day, allVisits, allCheckins);
}

/** Mirror-source visits + check-ins for one rep-day. Reads the synced tables directly (this
 * module is inside the CRM domain, so it owns the raw table access). */
async function fetchRepDayFromMirror(
  rep: { crmId: string | null; fullName: string | null; hrId: string },
  self: RepDaySelf,
  day: string,
): Promise<IReports360RepDayResult> {
  // By CRM id when he has one; a rep hired after the CRM cutover has none, so his day is found by
  // hr id (agent or either partner slot, every casing variant).
  //
  // THE SHARED BUILDER, never a hand-rolled expression. This read spelled its own equality pair
  // out, naming the agent column and ONE partner column — so once the visits door grew a second
  // slot (2026-10-07), a person who rode along as the chain's OTHER partner opened his own day and
  // found it empty. That is the owner's reported defect seen from the other side: Hany Saad Omar's
  // and Rasha Sabry Khalifa's October rows are all in slot 2.
  const crmId = self.crmId != null ? Number(self.crmId) : Number.NaN;
  const participantOr = Number.isFinite(crmId)
    ? buildParticipantCrmIdOrFilter([crmId])
    : buildParticipantHrIdOrFilter([self.hrId]);
  if (participantOr == null) return { checkins: [], rep, route: null, visits: [] };
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_VISITS_UNIFIED_VIEW)
    .select(
      "agent_crm_id, agent_hr_id, agent_name, ampm, attendance, call_type, comment, contact_crm_id, contact_name, " +
        "crm_contact_grade, crm_region_id, crm_region_name, crm_save_date, crm_visit_id, customer_name, " +
        "double_crm_id, double_hr_id, double_name, double2_crm_id, double2_hr_id, double2_name, " +
        "speciality, visit_date, visit_type, visit_type_description",
    )
    .eq("visit_date", day)
    .or(participantOr);
  if (error) throw new Error(error.message);
  const allVisits = ((data ?? []) as unknown as RepDayVisitMirrorRow[]).map(visitFromMirrorRow);

  // Fetch check-ins for every SUBMITTER of the day's visits, not just this person. A manager never
  // submits, so `[agentId]` alone returned nothing and their route was empty no matter how
  // buildRepDayResult filtered. The live source needs no equivalent change — it already pulls the
  // whole day's check-ins and lets buildRepDayResult decide.
  //
  // Over-fetching slightly is safe and deliberate: buildRepDayResult re-derives the owner set from
  // the exclusion-filtered visits, so a departed submitter's check-ins are dropped there.
  //
  // A submitter with no CRM id (a rep hired after the cutover) is fetched by hr id. With none of
  // those on the day, the read is the crm-id read it always was.
  const checkinAgentIds = new Set<number>(self.crmId != null ? [self.crmId] : []);
  const checkinAgentHrIds = new Set<string>(self.crmId != null ? [] : [self.hrId]);
  for (const visit of allVisits) {
    if (visit.agentID != null && Number.isFinite(visit.agentID) && visit.agentID !== 0) checkinAgentIds.add(visit.agentID);
    else if (visit.agentHrId?.trim()) checkinAgentHrIds.add(visit.agentHrId.trim());
  }

  const checkinRows = await queryCheckins<CrmCheckinRow>({
    ...(checkinAgentHrIds.size === 0
      ? { agentCrmIds: Array.from(checkinAgentIds) }
      : { agentCrmOrHrIds: { crmIds: Array.from(checkinAgentIds), hrIds: Array.from(checkinAgentHrIds) } }),
    dateFrom: day,
    dateTo: day,
    orderBy: "check_date",
    ascending: true,
    // The rep-day drill-down serves HR's field-workforce compliance and the National Sales Manager's team
    // calendar — no rep reaches it, so a started Phoenix CRM team's visits count as its check-ins here
    // (owner, 2026-10-02; src/lib/crm/phoenix-team-starts.ts lists every reader that asks).
    includePhoenixVisits: true,
  });
  const allCheckins = checkinRows.map(checkinFromMirrorRow);

  return buildRepDayResult(rep, self, day, allVisits, allCheckins);
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
    fullName: employee.displayName ?? employee.fullName ?? null,
    hrId: employee.hrId,
  };
  // A rep with no CRM id is no longer an empty day: a rep hired after the CRM cutover has none, and
  // his native visits are found by hr id. The vendor never knew him, so he is never sent live.
  const crmNumber = rep.crmId ? Number(rep.crmId) : Number.NaN;
  const self: RepDaySelf = {
    crmId: Number.isFinite(crmNumber) && crmNumber !== 0 ? crmNumber : null,
    hrId: rep.hrId,
  };

  // THE CRM CUTOVER. From the cutover date the day is Phoenix's own record, and after the vendor is
  // retired there is no live CRM to ask — both read the unified view only. An unreadable setting falls
  // back to no cutover, which is the pre-cutover behaviour and never hides a row.
  //
  // A STARTED TEAM'S DAY IS NEVER FETCHED LIVE (owner, 2026-10-02 — "from the team's start"). The global
  // cutover above is NOT that switch: a per-team start never sets `crm_cutover.cutover_date`, so this gate
  // used to let a started rep's recent day through to the vendor, and a live call that SUCCEEDS with zero
  // rows is served as the truth (the fallback below only catches a THROW). Measured on production
  // 2026-10-04: 14 of Delta (1)'s 17 people had logged Phoenix visits since their 3 October start and the
  // unified view returns no vendor row for any of the 17, so B-158's 22 Phoenix calls rendered as "no
  // visits" on HR's field-workforce-compliance drill-down and the National Sales Manager's team calendar.
  // B-120 is the sharper case: 3 of his rows are still in the raw mirror, which the view hides correctly,
  // so going around it answered with the vendor's 3 rather than his 2 Phoenix visits. The mirror path below
  // already reads the unified view with `includePhoenixVisits`, so it is the right answer for these days.
  const [cutover, startedWindows] = await Promise.all([
    getCrmCutoverSetting().catch(() => NO_CRM_CUTOVER),
    loadStartedRepWindows(),
  ]);
  const countedFromPhoenix = startedWindowCovers(startedWindows, { hrId: rep.hrId, crmId: self.crmId }, day);
  const wantLive =
    self.crmId != null &&
    (input.preferLive ?? isRecentRepDay(day)) &&
    isIReports360Configured() &&
    !countedFromPhoenix &&
    !cutover.vendorSyncRetiredAt &&
    !isOnOrAfterCrmCutover(cutover, day);
  if (wantLive) {
    try {
      return await fetchRepDayFromLive(rep, self, day);
    } catch (liveError) {
      // Recent-day live call failed — degrade to the mirror. Only surface the CRM error when
      // the mirror has nothing to show either (so a genuine outage isn't hidden as an empty day).
      const mirror = await fetchRepDayFromMirror(rep, self, day);
      if (mirror.visits.length > 0 || mirror.checkins.length > 0) return mirror;
      throw liveError;
    }
  }
  return fetchRepDayFromMirror(rep, self, day);
}
