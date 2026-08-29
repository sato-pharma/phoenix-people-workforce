/**
 * Reads for the Doctor List board — one rep's assigned doctors, with their CRM contact details.
 *
 * This answers a question no other board in Phoenix can. sfe-doctor-coverage.ts builds its panel
 * from visit history and rep-doctor-lists.ts from plan history, so both are blind to a doctor who
 * has been assigned and never touched — 448 of them company-wide on 2026-08-28. Those doctors have
 * a row here and nowhere else.
 *
 * WHAT THIS BOARD DELIBERATELY DOES NOT SHOW. Visits. The owner's instruction when he specified it
 * was exact — "all contact data of the doctors in that rep's CRM list: name, address, specialty,
 * grade. Not visits." Activity belongs to the two boards above. This one is the list itself.
 *
 * THREE THINGS THE DATA WILL NOT SUPPORT, so no caller should promise them:
 *  - A phone number. Filled on 35.6% of doctor rows, and on 0% for some entire reps.
 *  - History. The CRM returns only live contacts, so a doctor removed from a list simply stops
 *    being returned. `firstSeenAt` is the only trace of when one arrived.
 *  - "Not on the list means not his." 599 contacts (6.8%) that current agents genuinely worked in
 *    August 2026 sit on nobody's current list.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CONTACTS_TABLE } from "@/lib/crm/tables";
import { LIST_TYPES, type CrmListType } from "@/lib/crm/contacts-web-client";
import { scopeAllowsAgent, type CrmManagerScope } from "@/lib/crm/manager-scope";

/** PostgREST caps a page at 1000 rows; the largest single list measured was 197. */
const PAGE_SIZE = 1000;

export type DoctorListRow = {
  address: string | null;
  agentCrmId: number;
  agentHrId: string | null;
  contactCrmId: number;
  firstSeenAt: string | null;
  grade: string | null;
  listType: CrmListType;
  name: string;
  nameAr: string | null;
  phone: string | null;
  region: string | null;
  speciality: string | null;
  syncedAt: string | null;
};

export type DoctorListRepSummary = {
  agentCrmId: number;
  amCount: number;
  /** True when the PM list falls inside the owner's stated 90-120 rule. */
  inExpectedBand: boolean;
  hrId: string | null;
  name: string;
  pharmacyCount: number;
  pmCount: number;
  syncedAt: string | null;
};

/** The owner's rule, stated 2026-08-28: a medical rep carries 90 to 120 doctors, maximum. */
export const EXPECTED_PM_MIN = 90;
export const EXPECTED_PM_MAX = 120;

export function isInExpectedBand(pmCount: number): boolean {
  return pmCount >= EXPECTED_PM_MIN && pmCount <= EXPECTED_PM_MAX;
}

function normalizeListType(value: unknown): CrmListType {
  return LIST_TYPES.includes(value as CrmListType) ? (value as CrmListType) : "PM";
}

type ContactRecord = {
  address: string | null;
  agent_crm_id: number;
  agent_hr_id: string | null;
  contact_crm_id: number;
  contact_grade: string | null;
  contact_name: string | null;
  contact_name_ar: string | null;
  crm_region_name: string | null;
  first_seen_at: string | null;
  list_type: string;
  phone: string | null;
  speciality: string | null;
  synced_at: string | null;
};

const SELECT_COLUMNS =
  "agent_crm_id, agent_hr_id, contact_crm_id, contact_name, contact_name_ar, contact_grade, " +
  "speciality, phone, address, crm_region_name, first_seen_at, synced_at, list_type";

export function toDoctorListRow(record: ContactRecord): DoctorListRow {
  return {
    address: record.address,
    agentCrmId: record.agent_crm_id,
    agentHrId: record.agent_hr_id,
    contactCrmId: record.contact_crm_id,
    firstSeenAt: record.first_seen_at,
    grade: record.contact_grade,
    listType: normalizeListType(record.list_type),
    // The grid filled a name on all but one of 7,669 doctor rows, but a blank one must still render
    // as something a human can read rather than an empty cell with an id beside it.
    name: record.contact_name?.trim() || `Contact ${record.contact_crm_id}`,
    nameAr: record.contact_name_ar,
    phone: record.phone,
    region: record.crm_region_name,
    speciality: record.speciality,
    syncedAt: record.synced_at,
  };
}

/**
 * Every contact on one agent's lists.
 *
 * Pharmacies are returned alongside the doctors rather than filtered out here, because the caller
 * knows whether it is drawing a doctor board or a full list, and `listType` separates them
 * losslessly. `PM` is the doctor list proper — the one the 90-120 rule describes.
 */
export async function getAgentContactList(agentCrmId: number): Promise<DoctorListRow[]> {
  const rows: DoctorListRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_CONTACTS_TABLE)
      .select(SELECT_COLUMNS)
      .eq("agent_crm_id", agentCrmId)
      .order("list_type", { ascending: true })
      .order("contact_name", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read the doctor list: ${error.message}`);
    const page = (data ?? []) as unknown as ContactRecord[];
    rows.push(...page.map(toDoctorListRow));
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * One summary row per agent that has a mirrored list, for the rep picker.
 *
 * Counts come from the mirror rather than from the CRM's own counter column, so what the picker
 * promises and what the board then shows are the same number by construction.
 */
export async function getDoctorListRepSummaries(): Promise<DoctorListRepSummary[]> {
  const byAgent = new Map<number, DoctorListRepSummary>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_CONTACTS_TABLE)
      .select("agent_crm_id, agent_hr_id, list_type, synced_at")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read the doctor lists: ${error.message}`);
    const page = (data ?? []) as unknown as Pick<
      ContactRecord,
      "agent_crm_id" | "agent_hr_id" | "list_type" | "synced_at"
    >[];
    for (const record of page) {
      const existing = byAgent.get(record.agent_crm_id) ?? {
        agentCrmId: record.agent_crm_id,
        amCount: 0,
        hrId: record.agent_hr_id,
        inExpectedBand: false,
        name: "",
        pharmacyCount: 0,
        pmCount: 0,
        syncedAt: record.synced_at,
      };
      const listType = normalizeListType(record.list_type);
      if (listType === "PM") existing.pmCount += 1;
      else if (listType === "AM") existing.amCount += 1;
      else existing.pharmacyCount += 1;
      if (!existing.hrId && record.agent_hr_id) existing.hrId = record.agent_hr_id;
      if (record.synced_at && (!existing.syncedAt || record.synced_at > existing.syncedAt)) {
        existing.syncedAt = record.synced_at;
      }
      byAgent.set(record.agent_crm_id, existing);
    }
    if (page.length < PAGE_SIZE) break;
  }
  for (const summary of byAgent.values()) summary.inExpectedBand = isInExpectedBand(summary.pmCount);
  return [...byAgent.values()];
}

export type DoctorListBoard = {
  /** The rep whose list is on screen, or null when the mirror is empty. */
  selected: DoctorListRepSummary | null;
  reps: DoctorListRepSummary[];
  rows: DoctorListRow[];
  /** What the viewer's reach is, in words — shown so a short picker is never read as a thin CRM. */
  scopeLabel: string;
  /** Set when the viewer resolves to nobody; the board then explains rather than showing an empty picker. */
  scopeReason: string | null;
  syncedAt: string | null;
};

/**
 * Assembles the board: every rep who has a list, plus the selected rep's contacts.
 *
 * Names are resolved here rather than in the component because the owner's standing rule is that a
 * screen never shows a raw code — an agent id is exactly that. An agent the mirror holds but the
 * roster does not is labelled as such instead of being dropped, since a list belonging to nobody is
 * a finding, not a row to hide.
 *
 * SCOPE FILTERS THE PICKER, NOT JUST THE ROWS. `reps` is what the picker renders and `selected` is
 * chosen from `reps`, so one filter here governs both and they cannot drift apart. That is the exact
 * fault the owner caught on Doctor Coverage on 2026-08-28 — scoped data behind an unscoped picker —
 * and the reason `selected` is deliberately never looked up outside this filtered list: a hand-typed
 * `?rep=` id belonging to another district finds nothing and falls back to the viewer's own first
 * rep, which is a readable board rather than a leak or a blank page.
 */
export async function getDoctorListBoard(input: {
  agentCrmId?: number;
  scope: CrmManagerScope;
}): Promise<DoctorListBoard> {
  const scopeLabel = input.scope.kind === "none" ? "No reach" : input.scope.label;
  if (input.scope.kind === "none") {
    return { reps: [], rows: [], scopeLabel, scopeReason: input.scope.reason, selected: null, syncedAt: null };
  }

  const all = await getDoctorListRepSummaries();
  // An agent the mirror could not tie to an employee is visible to a company-scoped viewer only —
  // a manager cannot be shown a list that nobody can prove is his.
  const reps = all.filter((rep) => scopeAllowsAgent(input.scope, rep.hrId));

  const hrIds = [...new Set(reps.map((rep) => rep.hrId).filter((id): id is string => Boolean(id)))];
  const nameByHrId = new Map<string, string>();
  for (let from = 0; from < hrIds.length; from += 50) {
    const chunk = hrIds.slice(from, from + 50);
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, full_name")
      .in("hr_id", chunk);
    if (error) throw new Error(`Could not read rep names: ${error.message}`);
    for (const row of data ?? []) nameByHrId.set(row.hr_id as string, (row.full_name as string) ?? "");
  }
  for (const rep of reps) {
    rep.name = (rep.hrId ? nameByHrId.get(rep.hrId) : "") || `CRM account ${rep.agentCrmId} — not on the roster`;
  }
  reps.sort((left, right) => left.name.localeCompare(right.name));

  const selected =
    reps.find((rep) => rep.agentCrmId === input.agentCrmId) ?? reps.find((rep) => rep.pmCount > 0) ?? reps[0] ?? null;
  const rows = selected ? await getAgentContactList(selected.agentCrmId) : [];
  const syncedAt = reps.reduce<string | null>(
    (latest, rep) => (rep.syncedAt && (!latest || rep.syncedAt > latest) ? rep.syncedAt : latest),
    null,
  );
  return { reps, rows, scopeLabel, scopeReason: null, selected, syncedAt };
}
