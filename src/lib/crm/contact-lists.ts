/**
 * Reads for the rep contact lists — one rep's assigned doctors and pharmacies, with their contact
 * details — and the per-rep counts the pickers show.
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
 * THE SOURCE IS PHOENIX'S OWN LIST: `crm_contact_assignments`, joined to `crm_contacts`. An OPEN
 * assignment (`effective_to is null`) is a contact on a rep's list today. While the vendor sweep
 * still runs, the contact master refresh seeds those rows from the scraped `ireports360_contacts`;
 * once it is switched off, Phoenix's own list changes are the only writer. Reading the scrape here
 * would freeze every list, and every count built on it, on the day the sweep stops. Parity measured
 * on production 2026-09-14, before any reader moved: 9,756 open assignments against 9,757 scraped
 * rows (the one gap is contact 100000, the catch-all, which is no doctor), identical AM and PM
 * counts on all 137 rep lists, identical pharmacy totals, and identical names, phones, regions,
 * specialities and grades on every row.
 *
 * A REP IS KEYED ON HIS HR ID. A rep hired after the CRM cutover has no CRM account at all, so a
 * list keyed on `agent_crm_id` would report him as holding nothing, whatever he holds.
 *
 * THREE THINGS THE DATA WILL NOT SUPPORT, so no caller should promise them:
 *  - A phone number. Filled on 35.6% of doctor rows, and on 0% for some entire reps.
 *  - History, from these readers. The table keeps dated periods, but these return today's list only;
 *    `firstSeenAt` is when the contact's CURRENT period on the list began.
 *  - "Not on the list means not his." 599 contacts (6.8%) that current agents genuinely worked in
 *    August 2026 sit on nobody's current list.
 */

import { unstable_cache } from "next/cache";

import { fetchAllRowsKeyset, keysetRanges } from "@/lib/supabase/paginated";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CONTACT_ASSIGNMENTS_TABLE, CRM_CONTACT_MASTER_TABLE } from "@/lib/crm/tables";
import { LIST_TYPES, type CrmListType } from "@/lib/crm/list-types";
import { scopeAllowsAgent, type CrmManagerScope } from "@/lib/crm/manager-scope";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";

/** PostgREST caps a page at 1000 rows; the largest single list measured was 197. */
const PAGE_SIZE = 1000;

export type DoctorListRow = {
  address: string | null;
  /** The CRM account on the list row, or null for a rep who has none. Never the rep's identity. */
  agentCrmId: number | null;
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

/** One rep's list counts, keyed on the rep rather than on a CRM account. */
export type RepListSummary = Omit<DoctorListRepSummary, "agentCrmId"> & {
  /** The CRM account the rep's list rows carry, or null for a rep hired without one. */
  agentCrmId: number | null;
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
  agent_crm_id: number | null;
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

/** One open assignment with its contact embedded — the shape the list readers fetch. */
export type OpenAssignmentRecord = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact: {
    address: string | null;
    crm_region_name: string | null;
    name: string | null;
    name_ar: string | null;
    phone: string | null;
    speciality: string | null;
  } | null;
  contact_crm_id: number;
  effective_from: string | null;
  grade: string | null;
  list_type: string;
  updated_at: string | null;
};

/** The columns the per-rep summaries count from. */
export type OpenAssignmentCountRecord = Pick<OpenAssignmentRecord, "agent_crm_id" | "agent_hr_id" | "list_type" | "updated_at">;

/** Embedded through the assignment's foreign key to the contact master, so one ranged read is a
 * whole page of rows with their contact details and paging stays on the assignment's own `id`. */
const LIST_SELECT =
  "id, agent_crm_id, agent_hr_id, contact_crm_id, list_type, grade, effective_from, updated_at, " +
  `contact:${CRM_CONTACT_MASTER_TABLE}(name, name_ar, speciality, phone, address, crm_region_name)`;

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
 * An open assignment in the row shape `toDoctorListRow` reads. The assignment carries the list
 * (rep, list type, grade, period); the contact master carries who the contact is.
 */
export function assignmentToContactRecord(record: OpenAssignmentRecord): ContactRecord {
  return {
    address: record.contact?.address ?? null,
    agent_crm_id: record.agent_crm_id,
    agent_hr_id: record.agent_hr_id,
    contact_crm_id: record.contact_crm_id,
    contact_grade: record.grade,
    contact_name: record.contact?.name ?? null,
    contact_name_ar: record.contact?.name_ar ?? null,
    crm_region_name: record.contact?.crm_region_name ?? null,
    first_seen_at: record.effective_from,
    list_type: record.list_type,
    phone: record.contact?.phone ?? null,
    speciality: record.contact?.speciality ?? null,
    synced_at: record.updated_at,
  };
}

/** The screen's order: list by list, then by name. */
function compareListRows(left: DoctorListRow, right: DoctorListRow): number {
  if (left.listType !== right.listType) return left.listType < right.listType ? -1 : 1;
  return left.name.localeCompare(right.name);
}

/** Today's list for one rep, by CRM account or by HR id. Ordered by the assignment `id` while paging —
 * unique, so no page can repeat or skip a row — then sorted for the screen. */
async function readOpenList(rep: { agentCrmId: number } | { hrId: string }): Promise<DoctorListRow[]> {
  const rows: DoctorListRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = getSupabaseAdmin().from(CRM_CONTACT_ASSIGNMENTS_TABLE).select(LIST_SELECT).is("effective_to", null);
    query = "hrId" in rep ? query.in("agent_hr_id", hrIdLookupKeys(rep.hrId)) : query.eq("agent_crm_id", rep.agentCrmId);
    const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read the doctor list: ${error.message}`);
    const page = (data ?? []) as unknown as OpenAssignmentRecord[];
    rows.push(...page.map((record) => toDoctorListRow(assignmentToContactRecord(record))));
    if (page.length < PAGE_SIZE) break;
  }
  return rows.sort(compareListRows);
}

/**
 * Every contact on one CRM account's lists today.
 *
 * Pharmacies are returned alongside the doctors rather than filtered out here, because the caller
 * knows whether it is drawing a doctor board or a full list, and `listType` separates them
 * losslessly. `PM` is the doctor list proper — the one the 90-120 rule describes.
 *
 * Kept for the callers that only hold a CRM account (plan entries carry one). A rep with no CRM
 * account has no rows here by construction — read `getRepContactList` wherever the rep is known.
 */
export async function getAgentContactList(agentCrmId: number): Promise<DoctorListRow[]> {
  return readOpenList({ agentCrmId });
}

/**
 * Every contact on one rep's lists today, found by his HR id — the reader that also sees a rep
 * hired after the CRM cutover. Matched through `hrIdLookupKeys`, because HR ids are stored in more
 * than one casing across this system.
 */
export async function getRepContactList(hrId: string): Promise<DoctorListRow[]> {
  if (!canonicalHrIdKey(hrId)) return [];
  return readOpenList({ hrId });
}

/**
 * The cache tag for the rep summaries below.
 *
 * Two things move these numbers: the contact master refresh (run by the contact-lists cron from the
 * vendor sweep, until the sweep is switched off) and an approved Phoenix list change. Both must bust
 * this tag, which is what keeps the cache from being a staleness bug: a TTL alone would leave the
 * picker quoting old counts for up to five minutes after a change.
 */
export const CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG = "crm-contact-list-summaries";

/**
 * Per-rep counts from open assignment rows. Pure, exported for its test.
 *
 * KEYED ON THE REP'S CANONICAL HR ID, never on the CRM account: a rep hired after the cutover has no
 * account, and a Phoenix list change writes his rows with none. A row with no HR id at all — a vendor
 * row nobody resolved — still counts, under its CRM account, so it is visible rather than dropped.
 */
export function summarizeRepLists(records: readonly OpenAssignmentCountRecord[]): RepListSummary[] {
  const byRep = new Map<string, RepListSummary>();
  for (const record of records) {
    const hrKey = canonicalHrIdKey(record.agent_hr_id);
    const key = hrKey ? `hr:${hrKey}` : record.agent_crm_id != null ? `crm:${record.agent_crm_id}` : null;
    if (!key) continue;
    let summary = byRep.get(key);
    if (!summary) {
      summary = {
        agentCrmId: record.agent_crm_id,
        amCount: 0,
        hrId: record.agent_hr_id,
        inExpectedBand: false,
        name: "",
        pharmacyCount: 0,
        pmCount: 0,
        syncedAt: record.updated_at,
      };
      byRep.set(key, summary);
    }
    const listType = normalizeListType(record.list_type);
    if (listType === "PM") summary.pmCount += 1;
    else if (listType === "AM") summary.amCount += 1;
    else summary.pharmacyCount += 1;
    if (summary.agentCrmId == null && record.agent_crm_id != null) summary.agentCrmId = record.agent_crm_id;
    if (record.updated_at && (!summary.syncedAt || record.updated_at > summary.syncedAt)) {
      summary.syncedAt = record.updated_at;
    }
  }
  const summaries = [...byRep.values()];
  for (const summary of summaries) summary.inExpectedBand = isInExpectedBand(summary.pmCount);
  return summaries;
}

/**
 * `walks - 1` even id cuts across the whole assignment table, for `keysetRanges` to turn into `walks`
 * contiguous id ranges. The lowest and highest id are two one-row reads on the primary key with no
 * filter, so each is an index endpoint, never a scan. The cuts only spread the work: open rows bunch
 * by id (six of fourteen even ranges held none on 28 Oct 2026), and a dense range simply pages on.
 */
async function assignmentIdCuts(walks: number): Promise<number[]> {
  if (walks <= 1) return [];
  const supabase = getSupabaseAdmin();
  const [lowest, highest] = await Promise.all(
    [true, false].map((ascending) =>
      supabase.from(CRM_CONTACT_ASSIGNMENTS_TABLE).select("id").order("id", { ascending }).limit(1).maybeSingle(),
    ),
  );
  if (lowest.error) throw new Error(`Could not size the doctor lists: ${lowest.error.message}`);
  if (highest.error) throw new Error(`Could not size the doctor lists: ${highest.error.message}`);
  const low = Number((lowest.data as { id?: unknown } | null)?.id);
  const high = Number((highest.data as { id?: unknown } | null)?.id);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return [];
  const step = (high - low + 1) / walks;
  return Array.from({ length: walks - 1 }, (_unused, index) => Math.floor(low + step * (index + 1)));
}

/**
 * One summary row per rep who holds a list today, for the rep pickers.
 *
 * Counts come from the list rows themselves rather than from any counter column, so what the picker
 * promises and what the board then shows are the same number by construction.
 *
 * ## Why this reads every open row, and why that is paid at most once every five minutes
 *
 * There is no per-rep aggregate in the database — the counts are a GROUP BY that PostgREST cannot
 * express without a view — so producing ~70 summary rows means reading ~9,800 list rows. That is
 * inherent. What was NOT inherent was doing it SEQUENTIALLY, on every render, on all three boards
 * that call this: `/employee-portals/reps-list`, `/admin/reps-list` and Plan Verification. The
 * portal board is the one the nav registry calls "the page a manager reads standing in a pharmacy",
 * and its FIRST screen — the rep picker, before any rep is chosen — paid ten serial round trips to
 * Amsterdam to put a contact count on about five cards.
 *
 * Two changes, and they fix different halves:
 *
 *  1. THE PAGES ARE FETCHED AT ONCE, not one after another. Counted first so the fan-out is exact,
 *     the same shape `loadContactRoster` in reps-list.ts uses. Ten serial hops become one count plus
 *     ten parallel ones.
 *  2. THE RESULT IS CACHED. It is ~70 small objects — far below the 2 MB data-cache entry limit that
 *     kills the dev server, and a plain array, so nothing is lost to serialization the way a returned
 *     `Map` would be. The tag above closes the five-minute window whenever a list moves.
 *
 * THE ORDER IS NOT DECORATION. Ranged paging with no ORDER BY has no defined row order between
 * requests, so a row can be returned twice or skipped entirely and the counts come out quietly
 * wrong. `id` is the table's identity key, unique, so ordering on it is a total order and the sweep
 * is deterministic. The count and every page carry the same open-period filter, or the count would
 * size the fan-out for closed periods the pages never return.
 *
 * THE PAGES ARE ID RANGES, NOT OFFSETS (28 Oct 2026). An OFFSET page makes Postgres walk and throw
 * away every earlier open row, so page 14 walked ~14,000 rows to return 1,000: ~258,000 rows a build,
 * 9,487 buffer pages a call, the largest single read on the database (8.9% of all page reads over
 * 25–28 Oct, pg_stat_statements). Each walk now seeks inside its own id range on the primary key. The
 * cuts are even steps across the table's whole id span; they only spread the work, and since the
 * ranges are contiguous and the last is open-ended (keysetRanges), a row written mid-read can slow one
 * walk but never be lost or read twice — which an offset sweep could do.
 *
 * The try/catch stays OUT of the cached function deliberately, for the same reason
 * `loadBrickCentroids` does it: a transient database error must throw, never be written into the
 * cache as an empty roster that then reads as "no rep has a list" for five minutes.
 */
export const getRepListSummaries = unstable_cache(
  async (): Promise<RepListSummary[]> => {
    const supabase = getSupabaseAdmin();
    const { count, error: countError } = await supabase
      .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
      .select("id", { count: "exact", head: true })
      .is("effective_to", null);
    if (countError) throw new Error(`Could not size the doctor lists: ${countError.message}`);

    const ranges = keysetRanges(await assignmentIdCuts(Math.ceil((count ?? 0) / PAGE_SIZE)));
    const walks = await Promise.all(
      ranges.map((range) =>
        fetchAllRowsKeyset<OpenAssignmentCountRecord & { id: number }>(
          () => {
            let query = supabase
              .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
              .select("id, agent_crm_id, agent_hr_id, list_type, updated_at")
              .is("effective_to", null);
            if (range.from !== null) query = query.gte("id", range.from);
            if (range.below !== null) query = query.lt("id", range.below);
            return query;
          },
          { cursorColumn: "id", cursorOf: (row) => row.id },
        ),
      ),
    ).catch((error: { message?: string }) => {
      throw new Error(`Could not read the doctor lists: ${error?.message ?? String(error)}`);
    });

    // The ranges are in ascending id order, so the rows arrive in the order one walk would return them.
    const records: OpenAssignmentCountRecord[] = walks.flat();
    return summarizeRepLists(records);
  },
  ["crm-rep-list-summaries-by-hr-id"],
  { revalidate: 300, tags: [CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG] },
);

/**
 * The same summaries, limited to reps whose list rows carry a CRM account — for the callers that
 * join on one (Plan Verification matches plans by CRM account). Derived from the one cached read,
 * never a second one, so the two can never disagree about a count.
 */
export async function getDoctorListRepSummaries(): Promise<DoctorListRepSummary[]> {
  return (await getRepListSummaries()).filter((summary): summary is DoctorListRepSummary => summary.agentCrmId != null);
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
 *
 * NO ROUTE CALLS THIS ANY MORE. Its page (/admin/doctor-list) was retired on 2026-08-31 and Reps
 * List replaced it, assembling the same data through `getRepsListBoard`. It is kept rather than
 * deleted because it is the reference implementation of the scope rule above and its tests pin that
 * rule directly. Do not wire a new page to this one: the board that ships is Reps List, and a second
 * door onto the same data is how the two diverge on the first edit.
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
      .select("hr_id, full_name, nickname")
      .in("hr_id", chunk);
    if (error) throw new Error(`Could not read rep names: ${error.message}`);
    for (const row of data ?? []) {
      nameByHrId.set(
        row.hr_id as string,
        row.full_name ? resolveEmployeeDisplayName(row.full_name as string, row.nickname as string | null, row.hr_id as string) : "",
      );
    }
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
