/**
 * Who each person was recorded in the field WITH, per day.
 *
 * `getRepTripVisitWorkload` already answers "how much did this person work", and it counts a
 * visit where the person is the double-visit PARTNER as well as where they are the agent. What it
 * does not expose is the counterpart's identity: `RepVisitDetail.role` says "agent" or "partner"
 * but never who the other person was. The outstation manager rollup needs exactly that — a
 * National Sales Manager's workload includes the rep visits under the DM HE WAS WITH, on the days
 * he was with him, which is unanswerable without the pairing.
 *
 * Deliberately a SEPARATE module rather than a widened return type on visit-workload.ts. That
 * function feeds the live outstation decision engine, and its own documentation warns that its two
 * workload sources must not be conflated (doing so breaks the campaign-cap rule in both
 * directions). Adding a field there means re-testing a rule that pays people; reading the pairing
 * independently costs one extra query and risks nothing.
 *
 * Read-only and best-effort: a failure yields an empty map, which the rollup then treats as "this
 * person was alone", never as an error that blocks an expense.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { queryVisits, visitPartnerHrIds } from "@/lib/crm/reads";
import { logError } from "@/lib/observability/log";

/** person HR ID -> date (YYYY-MM-DD) -> the HR IDs they were recorded out with that date. */
export type VisitPartnersByPersonDate = Record<string, Record<string, string[]>>;

type PairRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  /** The chain's OTHER person — the senior above the manager, or the product manager who came with
   * him. Null on every vendor row, which records one partner. A chain is three people in one room, so
   * every PAIR among them is recorded: without this a senior manager on a chain was invisible to his
   * own trip rollup, and so was the rep he was actually standing beside. */
  double2_crm_id: number | null;
  double2_hr_id: string | null;
  /** EVERYONE on a Phoenix rep visit besides the rep (2026-10-27, "Everything is applicable"): the two
   * slots above hold only the first two, so a third or fourth companion — a product manager beside a
   * district and a regional manager, a training manager — is named only here. Null on vendor rows. */
  companion_hr_ids?: string[] | null;
  visit_date: string | null;
};

/** Every date from start to end inclusive. Capped — an outstation trip is a handful of days. */
function eachDateInclusive(startIso: string, endIso: string): string[] {
  const start = startIso.slice(0, 10);
  const end = endIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return /^\d{4}-\d{2}-\d{2}$/.test(start) ? [start] : [];
  }
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  for (let guard = 0; cursor <= last && guard < 400; guard += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Both directions of the CRM id <-> HR id mapping, from the employee directory, plus every person's
 * directory hr id by its canonical key — the only identity a rep hired after the CRM cutover has. */
async function loadCrmIdentityMaps(): Promise<{
  crmByHr: Map<string, number>;
  hrByCrm: Map<number, string>;
  hrByKey: Map<string, string>;
}> {
  const crmByHr = new Map<string, number>();
  const hrByCrm = new Map<number, string>();
  const hrByKey = new Map<string, string>();
  // Inactive people included on purpose: a rep who has since left still did the visits that
  // justify a manager's trip, and dropping them would silently under-count a real day.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  for (const row of directory) {
    const crmId = row.crmId == null ? null : Number(row.crmId);
    const hrKey = canonicalHrIdKey(row.hrId);
    if (hrKey && !hrByKey.has(hrKey)) hrByKey.set(hrKey, row.hrId);
    if (!hrKey || crmId == null || Number.isNaN(crmId)) continue;
    crmByHr.set(hrKey, crmId);
    // First writer wins: a CRM slot reused by a second person would otherwise resolve to
    // whoever the directory happened to list last. See the CRM reused-slot memory.
    if (!hrByCrm.has(crmId)) hrByCrm.set(crmId, row.hrId);
  }
  return { crmByHr, hrByCrm, hrByKey };
}

/**
 * One side of a visit, as a person: resolved through the CRM id when the row carries one — the exact
 * resolution every vendor row has always had — else through the row's own hr id, which is how a
 * native visit names a person with no CRM id. `key` is what the hop frontier tracks.
 */
function personOnVisit(
  crmValue: number | null,
  hrValue: string | null,
  maps: { hrByCrm: Map<number, string>; hrByKey: Map<string, string> },
): { crmId: number | null; hrId: string; hrKey: string | null; key: string } | null {
  const crmId = crmValue == null ? null : Number(crmValue);
  if (crmId != null && !Number.isNaN(crmId) && crmId !== 0) {
    const hrId = maps.hrByCrm.get(crmId);
    return hrId ? { crmId, hrId, hrKey: null, key: `crm:${crmId}` } : null;
  }
  const hrKey = canonicalHrIdKey(hrValue);
  const hrId = hrKey ? maps.hrByKey.get(hrKey) : undefined;
  return hrKey && hrId ? { crmId: null, hrId, hrKey, key: `hr:${hrKey}` } : null;
}

/**
 * Expand outward from a set of people, `hops` times, collecting who each was out with per day.
 *
 * One query per hop rather than one per person: a hop asks "for everyone discovered so far, who
 * else appears on their visits" and the `or(agent.in, double.in)` filter answers that in a single
 * round trip. For an NSM (1 hop) that is two queries for the whole trip.
 */
export async function getTripVisitPartnersByDate(input: {
  hops: number;
  rootHrIds: readonly string[];
  tripEndDate: string;
  tripStartDate: string;
}): Promise<VisitPartnersByPersonDate> {
  const partners: VisitPartnersByPersonDate = {};
  const hops = Math.max(0, Math.trunc(input.hops));
  if (hops === 0) return partners;

  const dates = eachDateInclusive(input.tripStartDate, input.tripEndDate);
  if (dates.length === 0) return partners;

  try {
    const maps = await loadCrmIdentityMaps();
    const { crmByHr } = maps;
    const start = dates[0];
    const end = dates[dates.length - 1];

    // Two frontiers: people by CRM id, and — for a person hired after the CRM cutover, who has no
    // CRM id — by canonical hr id. A root with a CRM id is walked by it exactly as before.
    let frontierCrm = new Set<number>();
    let frontierHr = new Set<string>();
    for (const hrId of input.rootHrIds) {
      const hrKey = canonicalHrIdKey(hrId);
      const crmId = crmByHr.get(hrKey ?? "");
      if (crmId != null) frontierCrm.add(crmId);
      else if (hrKey) frontierHr.add(hrKey);
    }
    if (frontierCrm.size === 0 && frontierHr.size === 0) return partners;

    const queriedCrm = new Set<number>();
    const queriedHr = new Set<string>();

    for (let hop = 0; hop < hops; hop += 1) {
      const toQuery = Array.from(frontierCrm).filter((crmId) => !queriedCrm.has(crmId));
      const toQueryHr = Array.from(frontierHr).filter((hrKey) => !queriedHr.has(hrKey));
      if (toQuery.length === 0 && toQueryHr.length === 0) break;
      for (const crmId of toQuery) queriedCrm.add(crmId);
      for (const hrKey of toQueryHr) queriedHr.add(hrKey);

      // Through the CRM read door: agent OR double-visit partner in the frontier, a double partner
      // present (NOT NULL only — the `0` sentinel is discarded below as before), no departed-agent
      // exclusion (a rep who has since left still did the visits that justify a manager's trip).
      // The door keyset-pages, so no hop is cut off at PostgREST's 1,000-row response cap.
      //
      // A hop with no hr-id frontier is the exact read it always was. With one, the partner test
      // becomes `doubleOnly` — a resolved `double_hr_id` or a real `double_crm_id` — because a native
      // double visit with a partner who has no CRM id carries a NULL `double_crm_id`, which
      // `requireDoubleCrmId` would drop. The `0` sentinel rows it also drops were discarded below anyway.
      //
      // A frontier person WITH a CRM id is asked by hr id too (2026-10-27): on a native visit with three
      // or more companions, the third and later stand in neither slot, only in `companion_hr_ids`, which
      // the hr half of the participant filter is the one to search.
      const crmFrontierHrIds = toQuery
        .map((crmId) => maps.hrByCrm.get(crmId))
        .filter((hrId): hrId is string => Boolean(hrId));
      const rows = await queryVisits<PairRow>({
        columns:
          "agent_crm_id, agent_hr_id, double_crm_id, double_hr_id, double2_crm_id, double2_hr_id, companion_hr_ids, visit_date",
        dateFrom: start,
        dateTo: end,
        includeResignedAgents: true,
        participantCrmIds: toQuery,
        // The directory's own spelling of each hr id, not the canonical key: the door expands casing
        // variants from it, and a legacy alias spelling is only reachable from the raw value.
        ...(toQueryHr.length > 0 || crmFrontierHrIds.length > 0
          ? {
              participantHrIds: toQueryHr.map((hrKey) => maps.hrByKey.get(hrKey) ?? hrKey).concat(crmFrontierHrIds),
              doubleOnly: true,
            }
          : { requireDoubleCrmId: true }),
      });

      const discoveredCrm = new Set<number>();
      const discoveredHr = new Set<string>();
      for (const row of rows) {
        const day = String(row.visit_date ?? "").slice(0, 10);
        if (!dates.includes(day)) continue;

        // Everybody the row names, in the order the rep's own form puts them: him, the manager or
        // product manager beside him, and on a chain the senior above that manager. A chain is three
        // people standing together, so EVERY PAIR among them is a real pairing — not only each of
        // them with the rep.
        //
        // Every companion past the two slots is named by hr id alone; one who has a CRM id is resolved
        // through it, as the walk knows him. The array repeats the slots, so each person is listed once —
        // by his directory hr id, which is the same whichever column named him.
        const companions = visitPartnerHrIds({ companion_hr_ids: row.companion_hr_ids }).map((hrId) => {
          const crmId = crmByHr.get(canonicalHrIdKey(hrId) ?? "");
          return personOnVisit(crmId ?? null, hrId, maps);
        });
        const seen = new Set<string>();
        const onVisit = [
          personOnVisit(row.agent_crm_id, row.agent_hr_id, maps),
          personOnVisit(row.double_crm_id, row.double_hr_id, maps),
          personOnVisit(row.double2_crm_id, row.double2_hr_id, maps),
          ...companions,
        ].filter((person): person is NonNullable<typeof person> => {
          if (person == null) return false;
          const who = canonicalHrIdKey(person.hrId) ?? person.key;
          if (seen.has(who)) return false;
          seen.add(who);
          return true;
        });
        // One partner at least: a solo visit pairs nobody. The same test the single-partner read made.
        if (onVisit.length < 2) continue;

        for (let i = 0; i < onVisit.length; i += 1) {
          for (let j = i + 1; j < onVisit.length; j += 1) {
            // A pair of the same person carries no information and would make the rollup's cycle
            // guard do the work instead.
            if (onVisit[i].key === onVisit[j].key) continue;
            // Recorded BOTH ways: the rollup walks outward from a manager, and the manager is the
            // one tagged as the partner while the rep is the agent. A one-directional map would
            // therefore never let a manager reach his rep.
            addPartner(partners, onVisit[i].hrId, day, onVisit[j].hrId);
            addPartner(partners, onVisit[j].hrId, day, onVisit[i].hrId);
          }
        }

        for (const person of onVisit) {
          if (person.crmId != null) discoveredCrm.add(person.crmId);
          else if (person.hrKey) discoveredHr.add(person.hrKey);
        }
      }

      frontierCrm = discoveredCrm;
      frontierHr = discoveredHr;
    }

    return partners;
  } catch (error) {
    logError("CRM visit-partner read failed; manager workload rollup will see no partners", {
      error,
      labels: { event: "crm_visit_partners_read_failed" },
    });
    return {};
  }
}

function addPartner(
  map: VisitPartnersByPersonDate,
  personHrId: string,
  date: string,
  partnerHrId: string,
) {
  const byDate = (map[personHrId] ??= {});
  const list = (byDate[date] ??= []);
  if (!list.includes(partnerHrId)) list.push(partnerHrId);
}
