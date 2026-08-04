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
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { logError } from "@/lib/observability/log";

/** person HR ID -> date (YYYY-MM-DD) -> the HR IDs they were recorded out with that date. */
export type VisitPartnersByPersonDate = Record<string, Record<string, string[]>>;

type PairRow = {
  agent_crm_id: number | null;
  double_crm_id: number | null;
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

/** Both directions of the CRM id <-> HR id mapping, from the employee directory. */
async function loadCrmIdentityMaps(): Promise<{
  crmByHr: Map<string, number>;
  hrByCrm: Map<number, string>;
}> {
  const crmByHr = new Map<string, number>();
  const hrByCrm = new Map<number, string>();
  // Inactive people included on purpose: a rep who has since left still did the visits that
  // justify a manager's trip, and dropping them would silently under-count a real day.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  for (const row of directory) {
    const crmId = row.crmId == null ? null : Number(row.crmId);
    const hrKey = canonicalHrIdKey(row.hrId);
    if (!hrKey || crmId == null || Number.isNaN(crmId)) continue;
    crmByHr.set(hrKey, crmId);
    // First writer wins: a CRM slot reused by a second person would otherwise resolve to
    // whoever the directory happened to list last. See the CRM reused-slot memory.
    if (!hrByCrm.has(crmId)) hrByCrm.set(crmId, row.hrId);
  }
  return { crmByHr, hrByCrm };
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
    const { crmByHr, hrByCrm } = await loadCrmIdentityMaps();
    const start = dates[0];
    const end = dates[dates.length - 1];
    const supabase = getSupabaseAdmin();

    let frontier = new Set<number>();
    for (const hrId of input.rootHrIds) {
      const crmId = crmByHr.get(canonicalHrIdKey(hrId) ?? "");
      if (crmId != null) frontier.add(crmId);
    }
    if (frontier.size === 0) return partners;

    const queried = new Set<number>();

    for (let hop = 0; hop < hops; hop += 1) {
      const toQuery = Array.from(frontier).filter((crmId) => !queried.has(crmId));
      if (toQuery.length === 0) break;
      for (const crmId of toQuery) queried.add(crmId);

      const list = toQuery.join(",");
      const { data, error } = await supabase
        .from(CRM_VISITS_TABLE)
        .select("agent_crm_id, double_crm_id, visit_date")
        .gte("visit_date", start)
        .lte("visit_date", `${end}T23:59:59.999Z`)
        .not("double_crm_id", "is", null)
        .or(`agent_crm_id.in.(${list}),double_crm_id.in.(${list})`);
      if (error) throw new Error(error.message);

      const discovered = new Set<number>();
      for (const row of (data ?? []) as PairRow[]) {
        const day = String(row.visit_date ?? "").slice(0, 10);
        if (!dates.includes(day)) continue;

        const agent = row.agent_crm_id == null ? null : Number(row.agent_crm_id);
        const partner = row.double_crm_id == null ? null : Number(row.double_crm_id);
        if (agent == null || partner == null || Number.isNaN(agent) || Number.isNaN(partner)) continue;
        // A row pairing someone with themselves carries no information and would make the
        // rollup's cycle guard do the work instead.
        if (agent === partner) continue;

        const agentHr = hrByCrm.get(agent);
        const partnerHr = hrByCrm.get(partner);
        if (!agentHr || !partnerHr) continue;

        // Recorded BOTH ways: the rollup walks outward from a manager, and the manager is the
        // one tagged as the double-visitor (`double_crm_id`) while the rep is the agent. A
        // one-directional map would therefore never let a manager reach his rep.
        addPartner(partners, agentHr, day, partnerHr);
        addPartner(partners, partnerHr, day, agentHr);

        discovered.add(agent);
        discovered.add(partner);
      }

      frontier = discovered;
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
