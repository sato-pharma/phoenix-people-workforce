// Business Review — CRM field activity, live.
//
// This is the half of the review the workbook could not re-slice at all: it carried one frozen
// Jan–Jun visit count (69,682) and nothing behind it. `ireports360_visits` holds 123,373 rows for
// 2026-01 → 2026-08, so every window can now be answered from the feed itself. That is a
// RESTATEMENT, not a refinement, and the Coverage tab says both numbers rather than quietly
// replacing one with the other.
//
// FOUR RULES THIS FILE OBEYS, EACH BOUGHT WITH A REAL INCIDENT:
//
// 1. RESIGNED AGENTS ARE INCLUDED, AND COUNTED. Every other CRM read hides agents on the
//    resigned/excluded floor, and that is right for scoring a live rep. It is wrong for history:
//    a rep who left in March still worked in January, and dropping their rows would take that
//    month's total down by up to 47% with no sign anything was missing. The list has also hidden
//    an ACTIVE rep six times over (a reused CRM slot). So the door is opened with
//    `includeResignedAgents: true` and `excludedAgentRows` reports exactly how many rows that let
//    through — visible, never silent, either way.
//
// 2. "VISITS" MEANS FIELD VISITS, VIA THE SHARED CLASSIFIER. Not every row is a visit: leave,
//    meetings, admin work and BRM days all live in the same table. The regular/campaign/admin
//    split is `classifyVisit` in crm/visit-types.ts — the single authority the CRM master,
//    Employee 360 and the portal already share — so this module cannot drift from them. Note it
//    puts code -30 in the `regular` bucket: those 868 rows ARE field visits, and a hand-rolled
//    `visit_type IN (0, -8)` would have lost them.
//
// 3. REGULAR (0) IS REPORTED SEPARATELY FROM CAMPAIGN (-8), AND NEITHER IS WIDENED INTO THE
//    OTHER. Two reps log their entire month as campaign work; on any measure built on type 0
//    alone they read as a flat zero while working full time. Whether a campaign call satisfies a
//    planned doctor call is a business decision the owner has not made, so the review shows both
//    columns and lets the reader see which is which.
//
// 4. CUSTOMERS COME FROM TYPE 0 ONLY. Regular visits are 100% contact-named; every other type
//    shares ONE sentinel `contact_crm_id`. Unioning contact ids across all types would add
//    exactly one phantom customer to every area, every month.
//
// Duplicate submissions are collapsed with the CRM module's own `collapseDuplicateVisitSubmissions`
// (one rep, one contact, one day, one type — the later re-save is not a second visit), and the
// number removed is reported, because it is the largest single reason a live count differs from a
// hand-tallied one.

import {
  collapseDuplicateVisitSubmissions,
  getEffectiveExcludedAgentCrmIds,
  isCrmDoubleVisitRow,
  queryVisits,
} from "@/lib/crm/reads";
import { CAMPAIGN_TYPE, REGULAR_TYPE, classifyVisit } from "@/lib/crm/visit-types";

import { hrKey } from "./attribution";
import type { ReviewWindow } from "../period";

/** The columns the fold needs. Deliberately narrow: `comment` is the one big text column on this
 *  table and pulling it across the window would multiply the payload for a label that only two
 *  codes out of sixteen consult (-7 and -30, 1,016 rows in all of production). `classifyVisit`
 *  documents a null comment as safe — it yields the code's own default label — and neither code
 *  can move a customer count or a field-visit count whichever way it lands. */
const VISIT_COLUMNS =
  "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, crm_save_date, crm_visit_id, " +
  "double_crm_id, double_hr_id, double_name, visit_date, visit_type";

type VisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  contact_crm_id: number | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  visit_date: string | null;
  visit_type: number | null;
};

export type VisitAgentFact = {
  period: string;
  /** Uppercased HR id, or "" when the mirror never resolved one for this agent. */
  agentHrId: string;
  agentCrmId: number | null;
  agentName: string | null;
  /** Regular + campaign + unlabelled field rows — everything the classifier calls fieldwork. */
  fieldVisits: number;
  /** Visit type 0 exactly. The only figure comparable with Doctor Coverage and DV Analytics. */
  regularVisits: number;
  /** Visit type -8. Real work; shown beside `regularVisits`, never folded into it. */
  campaignVisits: number;
  /** Meetings, leave, admin, BRM. Recorded activity, but not a customer visit. */
  adminRows: number;
  /** Of this agent's own field visits, how many carried a manager riding along. */
  accompaniedVisits: number;
  /** Distinct `contact_crm_id` on type-0 rows. A SET, so an area total is a union not a sum. */
  customers: Set<number>;
  /** Rows per classifier label, so the activity mix can be rolled up per area, district and line
   *  instead of only company-wide — a mix is only useful next to the team it describes. */
  byLabel: Map<string, number>;
};

export type VisitManagerFact = {
  period: string;
  managerHrId: string;
  managerName: string | null;
  /** Double-visit rides: a real partner on a fieldwork type (0 or -8). */
  rides: number;
  /** Rides per rep ridden with. A MAP, not a count, because a manager's rides have to be split
   *  across the lines their reps sit on — a total alone cannot be attributed to a line without
   *  guessing. `.size` is the coaching spread; the values are the split. */
  ridesByRep: Map<string, number>;
  /** Distinct customers reached while riding along, type-0 rows only. */
  customers: Set<number>;
};

/** The activity mix, in the classifier's own display labels. */
export type VisitActivityFact = { period: string; label: string; rows: number };

export type VisitsLoad = {
  agents: VisitAgentFact[];
  managers: VisitManagerFact[];
  activity: VisitActivityFact[];
  periodsWithData: string[];
  /** Rows kept for the window, after the duplicate collapse. */
  totalRows: number;
  /** Rows the collapse removed as re-saves of a stop already counted. */
  collapsedRows: number;
  /** Rows carrying no `agent_hr_id`, so they can reach no person, area or district. */
  unattributableRows: number;
  /** Rows whose agent sits on the resigned/excluded floor — included on purpose, see rule 1. */
  excludedAgentRows: number;
};

const EMPTY: VisitsLoad = {
  agents: [],
  managers: [],
  activity: [],
  periodsWithData: [],
  totalRows: 0,
  collapsedRows: 0,
  unattributableRows: 0,
  excludedAgentRows: 0,
};

/** Last day of a YYYY-MM, for the inclusive upper bound on `visit_date`. */
function endOfMonth(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
}

export async function loadVisitFacts(window: ReviewWindow): Promise<VisitsLoad> {
  let raw: VisitRow[] = [];
  let excludedCrmIds: number[] = [];
  try {
    [raw, excludedCrmIds] = await Promise.all([
      // Collapse is applied below rather than by the door, so the number removed can be reported.
      queryVisits<VisitRow>({
        columns: VISIT_COLUMNS,
        dateFrom: `${window.from}-01`,
        dateTo: endOfMonth(window.to),
        includeResignedAgents: true,
      }),
      getEffectiveExcludedAgentCrmIds(),
    ]);
  } catch {
    // A missing mirror or a transient read must read as "no data", which the coverage layer then
    // states in words. It must never read as a month in which nobody visited anybody.
    return EMPTY;
  }

  const rows = collapseDuplicateVisitSubmissions(raw);
  const excluded = new Set(excludedCrmIds);

  const agents = new Map<string, VisitAgentFact>();
  const managers = new Map<string, VisitManagerFact>();
  const activity = new Map<string, VisitActivityFact>();
  const periods = new Set<string>();
  let unattributableRows = 0;
  let excludedAgentRows = 0;
  let totalRows = 0;

  for (const row of rows) {
    const period = String(row.visit_date ?? "").slice(0, 7);
    if (!period || !window.periods.includes(period)) continue;
    periods.add(period);
    totalRows += 1;

    const agentHrId = hrKey(row.agent_hr_id);
    if (!agentHrId) unattributableRows += 1;
    if (row.agent_crm_id != null && excluded.has(row.agent_crm_id)) excludedAgentRows += 1;

    const { label, bucket } = classifyVisit(row.visit_type ?? null, null, null);
    const isField = bucket === "regular" || bucket === "campaign";
    const isRegular = row.visit_type === REGULAR_TYPE;
    const contactId =
      isRegular && row.contact_crm_id != null && row.contact_crm_id !== 0 ? row.contact_crm_id : null;

    const activityKey = `${period}|${label}`;
    const activityFact = activity.get(activityKey);
    if (activityFact) activityFact.rows += 1;
    else activity.set(activityKey, { period, label, rows: 1 });

    // An agent with no HR id is still a real person doing real work — keyed on their CRM id so the
    // coverage tab can name them instead of piling every unmapped rep into one anonymous row.
    const agentKey = `${period}|${agentHrId || `crm:${row.agent_crm_id ?? "?"}`}`;
    let agent = agents.get(agentKey);
    if (!agent) {
      agent = {
        period,
        agentHrId,
        agentCrmId: row.agent_crm_id ?? null,
        agentName: row.agent_name ?? null,
        fieldVisits: 0,
        regularVisits: 0,
        campaignVisits: 0,
        adminRows: 0,
        accompaniedVisits: 0,
        customers: new Set<number>(),
        byLabel: new Map<string, number>(),
      };
      agents.set(agentKey, agent);
    }
    if (!agent.agentName && row.agent_name) agent.agentName = row.agent_name;
    agent.byLabel.set(label, (agent.byLabel.get(label) ?? 0) + 1);
    if (isField) agent.fieldVisits += 1;
    else agent.adminRows += 1;
    if (isRegular) agent.regularVisits += 1;
    if (row.visit_type === CAMPAIGN_TYPE) agent.campaignVisits += 1;
    if (contactId != null) agent.customers.add(contactId);

    if (!isCrmDoubleVisitRow(row)) continue;
    if (isField) agent.accompaniedVisits += 1;

    const managerHrId = hrKey(row.double_hr_id);
    if (!managerHrId) continue;
    const managerKey = `${period}|${managerHrId}`;
    let manager = managers.get(managerKey);
    if (!manager) {
      manager = {
        period,
        managerHrId,
        managerName: row.double_name ?? null,
        rides: 0,
        ridesByRep: new Map<string, number>(),
        customers: new Set<number>(),
      };
      managers.set(managerKey, manager);
    }
    if (!manager.managerName && row.double_name) manager.managerName = row.double_name;
    manager.rides += 1;
    if (agentHrId) manager.ridesByRep.set(agentHrId, (manager.ridesByRep.get(agentHrId) ?? 0) + 1);
    if (contactId != null) manager.customers.add(contactId);
  }

  return {
    agents: [...agents.values()],
    managers: [...managers.values()],
    activity: [...activity.values()].sort((a, b) =>
      a.period === b.period ? b.rows - a.rows : a.period < b.period ? -1 : 1,
    ),
    periodsWithData: [...periods].sort(),
    totalRows,
    collapsedRows: raw.length - rows.length,
    unattributableRows,
    excludedAgentRows,
  };
}

export const VISITS_ORIGIN = "public.ireports360_visits via the CRM read door, keyed on visit_date";
export const VISITS_RULE =
  "A visit is a field row under the shared classifier — regular, campaign, or an unlabelled field " +
  "call. Meetings, leave, admin and BRM days are counted separately and are not visits. Repeat " +
  "submissions of the same stop are collapsed, and resigned agents are included so a past month " +
  "keeps the visits it really had.";
export const CUSTOMERS_ORIGIN =
  "public.ireports360_visits, distinct contact_crm_id on regular visits";
export const CUSTOMERS_RULE =
  "A customer counts in a month when a regular (type 0) visit named them. Area, district, line and " +
  "company totals are unions of those contacts, never sums, so one doctor seen by two reps is one " +
  "customer.";
