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
// 3. PLANNED IS REPORTED SEPARATELY FROM UNPLANNED, AND NEITHER IS WIDENED INTO THE OTHER. Until
//    6 Nov 2026 the second column was campaign (-8); the owner replaced it with unplanned visits
//    ("replace campagin with unplanned visist"). Phoenix serves every visit as type 0, so its own
//    `is_unplanned` mark decides; on an archive day iReports360's campaign code still counts as
//    unplanned (isUnplannedFieldVisit). Two reps once logged their entire month as campaign work;
//    on any measure built on planned visits alone they read as a flat zero while working full
//    time, so the review shows both columns and lets the reader see which is which.
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
import { markDegraded } from "@/lib/cache/serve-uncached";
import { CATCH_ALL_CONTACT_CRM_ID } from "@/lib/crm/call-rate";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import {
  addBucketToSplit,
  emptyVisitCountSplit,
  visitCountBucket,
  type VisitCountBucket,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { REGULAR_TYPE, classifyVisit } from "@/lib/crm/visit-types";
import { isUnplannedFieldVisit } from "@/lib/crm/visit-type-meaning";
import { tidyAllCapitalsName } from "@/lib/employees/display-name";

import { hrKey } from "./attribution";
import type { ReviewWindow } from "../period";
import { periodMonthEnd } from "../period-format";

/**
 * The columns the fold needs.
 *
 * `ampm` and `speciality` joined the projection on 2026-09-26, for the AM · PM · Pharmacies golden
 * rule: the bucket is decided by the visited contact's own speciality, and only then by the period
 * tag. Both are narrow columns.
 *
 * `comment` is still deliberately OUT. It is the one big text column on this table and pulling it
 * across a window would multiply the payload for a label only the vendor's `-30` code consults —
 * and that code carries no contact, so it is the one row shape `speciality` cannot answer for. It is
 * read by a SECOND, narrow query instead (`loadUnlabelledFieldComments` below), the same shape
 * crm/sfe-field-analytics.ts uses. Measured on production for 2026-07 → 2026-09: 325 `-30` rows in
 * all, so the second read is nothing.
 */
const VISIT_COLUMNS =
  "agent_crm_id, agent_hr_id, agent_name, ampm, contact_crm_id, crm_save_date, crm_visit_id, " +
  "double_crm_id, double_hr_id, double_name, double2_hr_id, double2_name, is_unplanned, speciality, visit_date, visit_type";

/** Just enough to route the vendor's unlabelled field visit, keyed back by `crm_visit_id`. */
const UNLABELLED_FIELD_VISIT_TYPE = -30;
const UNLABELLED_COMMENT_COLUMNS = "comment, crm_visit_id";

type VisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  double2_hr_id: string | null;
  double2_name: string | null;
  /** Phoenix CRM's own planned/unplanned mark; null on an iReports360 row. */
  is_unplanned?: boolean | null;
  speciality: string | null;
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
  /** PLANNED visits: visit type 0 that is not unplanned. On an iReports360 month that is type 0 exactly, as before. */
  regularVisits: number;
  /**
   * UNPLANNED visits (owner, 6 Nov 2026: "replace campagin with unplanned visist"): a Phoenix visit marked
   * unplanned, or iReports360's campaign code (-8) on an archive day — isUnplannedFieldVisit. Real work; shown
   * beside `regularVisits`, never folded into it. The field keeps its stored name.
   */
  campaignVisits: number;
  /** Meetings, leave, admin, BRM. Recorded activity, but not a customer visit. */
  adminRows: number;
  /** Of this agent's own field visits, how many carried a manager riding along. */
  accompaniedVisits: number;
  /**
   * The same field visits, split AM · PM · Pharmacies — the owner's golden rule, 2026-09-21.
   *
   * A pharmacy is NEVER counted among the PM doctors, however the vendor tagged its period: measured
   * on production for 2026-08-01 → 2026-09-20, 1,827 regular pharmacy visits carried `ampm = 'PM'`
   * and 426 carried 'AM'. `visitCountBucket` is the one authority and is never re-implemented here.
   *
   * `am + pm + pharmacies` equals `fieldVisits`: an unmarked period lands in PM, so every counted
   * visit sits in exactly one bucket. That is the Private Calendar's convention rather than Employee
   * 360's (which keeps an unmarked visit out of all three) — deliberate, because this page's figures
   * have to add up against the sales beside them.
   */
  visitSplit: VisitCountSplit;
  /** Distinct `contact_crm_id` on type-0 rows. A SET, so an area total is a union not a sum. */
  customers: Set<number>;
  /**
   * The same contacts, split the same three ways. A pharmacy is not a doctor, so "doctors reached"
   * can only be honest once these are apart. Unioned at every level, never summed.
   */
  customersAm: Set<number>;
  customersPm: Set<number>;
  customersPharmacy: Set<number>;
  /**
   * What this agent's list is made of, by the vendor's own `speciality` value: the distinct
   * contacts under each, and the visits to them.
   *
   * Tallies rather than rows, because a district merges its reps and a line merges its districts —
   * carrying every visit row that far would be the same data an order of magnitude larger. The
   * classification happens at the far end, in `specialty-mix.ts`, against the ONE authority.
   */
  specialityContacts: Map<string, Set<number>>;
  specialityVisits: Map<string, number>;
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
  /** The same, split three ways — a pharmacy a manager rode to is not a doctor either. */
  customersAm: Set<number>;
  customersPm: Set<number>;
  customersPharmacy: Set<number>;
  /** Rides split AM · PM · Pharmacies. */
  rideSplit: VisitCountSplit;
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

export async function loadVisitFacts(window: ReviewWindow): Promise<VisitsLoad> {
  let raw: VisitRow[] = [];
  let excludedCrmIds: number[] = [];
  let unlabelledComments: { comment: string | null; crm_visit_id: number | null }[] = [];
  try {
    [raw, excludedCrmIds, unlabelledComments] = await Promise.all([
      // Collapse is applied below rather than by the door, so the number removed can be reported.
      queryVisits<VisitRow>({
        columns: VISIT_COLUMNS,
        dateFrom: `${window.from}-01`,
        dateTo: periodMonthEnd(window.to),
        includeResignedAgents: true,
      }),
      getEffectiveExcludedAgentCrmIds(),
      // The `-30` rows only, and only their comment. That code carries no contact, so its bucket can
      // be read from nothing else; every other row is answered by `speciality`, which is already in
      // the main projection. Narrow on purpose — see VISIT_COLUMNS.
      queryVisits<{ comment: string | null; crm_visit_id: number | null }>({
        columns: UNLABELLED_COMMENT_COLUMNS,
        dateFrom: `${window.from}-01`,
        dateTo: periodMonthEnd(window.to),
        includeResignedAgents: true,
        visitTypes: [UNLABELLED_FIELD_VISIT_TYPE],
      }),
    ]);
  } catch {
    // A missing mirror or a transient read must read as "no data", which the coverage layer then
    // states in words. It must never read as a month in which nobody visited anybody. Marked, so
    // the five-minute bundle cache serves it to this render only (src/lib/cache/serve-uncached.ts).
    return markDegraded({ ...EMPTY });
  }

  const commentByVisitId = new Map<number, string | null>();
  for (const row of unlabelledComments) {
    if (row.crm_visit_id != null) commentByVisitId.set(row.crm_visit_id, row.comment ?? null);
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
    // Contact 0 is no contact, and 100000 is the catch-all — a slot the vendor's UI writes when the
    // rep named nobody, and no doctor. Every other CRM surface in this repo excludes it (the call
    // rate, Employee 360, the contact lists, customer bricks, the Phoenix plan history); this one
    // did not, so it added one phantom customer to every level that saw it.
    const contactId =
      isRegular &&
      row.contact_crm_id != null &&
      row.contact_crm_id !== 0 &&
      row.contact_crm_id !== CATCH_ALL_CONTACT_CRM_ID
        ? row.contact_crm_id
        : null;
    // The one authority for AM · PM · Pharmacies. `comment` is only consulted for the vendor's
    // unlabelled `-30` field visit, which carries no contact — hence the narrow second read.
    const countBucket: VisitCountBucket = visitCountBucket({
      ampm: row.ampm,
      comment:
        row.visit_type === UNLABELLED_FIELD_VISIT_TYPE && row.crm_visit_id != null
          ? commentByVisitId.get(row.crm_visit_id) ?? null
          : null,
      speciality: row.speciality,
      visit_type: row.visit_type,
    });
    // A Phoenix CRM row (its negative id) logs no pharmacy visit: the split counts it, so the review
    // prints that pharmacy figure as not recorded, never 0 (src/lib/crm/visit-count-buckets.ts).
    const fromPhoenix = isPhoenixNativeVisitRow(row);

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
        visitSplit: emptyVisitCountSplit(),
        customers: new Set<number>(),
        customersAm: new Set<number>(),
        customersPm: new Set<number>(),
        customersPharmacy: new Set<number>(),
        specialityContacts: new Map<string, Set<number>>(),
        specialityVisits: new Map<string, number>(),
        byLabel: new Map<string, number>(),
      };
      agents.set(agentKey, agent);
    }
    if (!agent.agentName && row.agent_name) agent.agentName = row.agent_name;
    agent.byLabel.set(label, (agent.byLabel.get(label) ?? 0) + 1);
    if (isField) {
      agent.fieldVisits += 1;
      addBucketToSplit(agent.visitSplit, countBucket, 1, fromPhoenix);
    } else agent.adminRows += 1;
    // Planned and unplanned, apart: Phoenix serves every visit as type 0, so its own mark decides.
    const isUnplanned = isUnplannedFieldVisit({ is_unplanned: row.is_unplanned, visit_type: row.visit_type });
    if (isRegular && !isUnplanned) agent.regularVisits += 1;
    if (isUnplanned) agent.campaignVisits += 1;
    if (contactId != null) {
      agent.customers.add(contactId);
      if (countBucket === "AM") agent.customersAm.add(contactId);
      else if (countBucket === "PM") agent.customersPm.add(contactId);
      else agent.customersPharmacy.add(contactId);
    }

    // What the list is made of. The vendor's value VERBATIM and trimmed — classification happens
    // once, at the far end, against the one authority in contact-taxonomy.ts. Normalising or
    // bucketing here would be a second opinion, and the second opinion is what once scored
    // "Contract" and "Health Insurance" as doctors.
    //
    // Only FIELD rows: an admin row is not a call on anybody, and counting it would put a doctor in
    // the list on the strength of paperwork. A row with no contact still contributes its VISIT,
    // because it is real fieldwork; it just cannot name a customer.
    if (isField) {
      const speciality = String(row.speciality ?? "").trim();
      agent.specialityVisits.set(speciality, (agent.specialityVisits.get(speciality) ?? 0) + 1);
      if (contactId != null) {
        let ids = agent.specialityContacts.get(speciality);
        if (!ids) {
          ids = new Set<number>();
          agent.specialityContacts.set(speciality, ids);
        }
        ids.add(contactId);
      }
    }

    if (!isCrmDoubleVisitRow(row)) continue;
    if (isField) agent.accompaniedVisits += 1;

    // BOTH partner slots. A chain visit carries two managers and each of them really made that ride,
    // so crediting slot 1 alone lost the other one entirely — on production that is 10 visits, two
    // people, 6-7 October 2026. The ride is counted once per manager, never twice for the same one:
    // the view fills slot 1 from coalesce(manager, product_manager, senior), so the two slots never
    // hold the same person.
    for (const [rawManagerHrId, rawManagerName] of [
      [row.double_hr_id, row.double_name],
      [row.double2_hr_id, row.double2_name],
    ] as const) {
      const managerHrId = hrKey(rawManagerHrId);
      if (!managerHrId) continue;
      const managerKey = `${period}|${managerHrId}`;
      let manager = managers.get(managerKey);
      if (!manager) {
        manager = {
          period,
          managerHrId,
          managerName: rawManagerName ? tidyAllCapitalsName(rawManagerName) : null,
          rides: 0,
          ridesByRep: new Map<string, number>(),
          customers: new Set<number>(),
          customersAm: new Set<number>(),
          customersPm: new Set<number>(),
          customersPharmacy: new Set<number>(),
          rideSplit: emptyVisitCountSplit(),
        };
        managers.set(managerKey, manager);
      }
      if (!manager.managerName && rawManagerName) manager.managerName = tidyAllCapitalsName(rawManagerName);
      manager.rides += 1;
      addBucketToSplit(manager.rideSplit, countBucket, 1, fromPhoenix);
      if (agentHrId) manager.ridesByRep.set(agentHrId, (manager.ridesByRep.get(agentHrId) ?? 0) + 1);
      if (contactId != null) {
        manager.customers.add(contactId);
        if (countBucket === "AM") manager.customersAm.add(contactId);
        else if (countBucket === "PM") manager.customersPm.add(contactId);
        else manager.customersPharmacy.add(contactId);
      }
    }
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

// The door serves iReports360 rows, and a team that works in Phoenix CRM by its own Phoenix visits from
// the team's start instead of its reps' vendor rows (owner, 2026-10-02 — src/lib/crm/phoenix-team-starts.ts).
// Kept to one short line: it lands in a merged cell of the pack that does not wrap.
export const VISITS_ORIGIN = "public.crm_visits_unified via the CRM read door, keyed on visit_date";
export const VISITS_RULE =
  "A visit is a field row under the shared classifier — regular, campaign, or an unlabelled field " +
  "call. Meetings, leave, admin and BRM days are counted separately and are not visits. Repeat " +
  "submissions of the same stop are collapsed, and resigned agents are included so a past month " +
  "keeps the visits it really had. Every visit is reported AM · PM · Pharmacies, three figures " +
  "apart: a pharmacy call is never counted among the PM doctors, whatever period the vendor tagged " +
  "it with, and an unmarked period counts as PM so the three always add to the total.";
// The same door as VISITS_ORIGIN above. It was left naming the raw mirror when the visits line moved onto
// the view, so for a started team the pack told its reader the customers came from iReports360 when they
// came from Phoenix CRM — the one question a provenance cell exists to answer.
export const CUSTOMERS_ORIGIN =
  "public.crm_visits_unified via the CRM read door, distinct contact_crm_id on regular visits";
export const CUSTOMERS_RULE =
  "A customer counts in a month when a regular (type 0) visit named them. Area, district, line and " +
  "company totals are unions of those contacts, never sums, so one doctor seen by two reps is one " +
  "customer. They are reported AM accounts · PM doctors · Pharmacies apart, because a pharmacy is " +
  "not a doctor. The vendor's catch-all contact is excluded — it is a slot, not a person.";
