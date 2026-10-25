/**
 * Mirrors each rep's assigned contact list from the CRM web app into `ireports360_contacts`.
 *
 * WHAT DRIVES THE SWEEP. Phoenix's own employee roster, resolved to CRM agent ids — never the CRM's
 * agents grid. The CRM never deletes an account: when a rep resigns the admin blanks the name,
 * keeps the area and clones a new account for the next hire, so the CRM's own active flag marked
 * 121 medical-rep accounts live against 67 active Medical Representatives on 2026-08-28. Syncing
 * from the CRM's flag would mirror four years of leavers' lists.
 *
 * THE ONE RULE THAT MATTERS: AN EMPTY ANSWER NEVER DELETES A REAL LIST.
 * This mirror is authoritative-by-replacement — a doctor removed from a rep's list in the CRM must
 * disappear here, so each agent's rows are replaced wholesale. That makes an empty fetch the single
 * most dangerous outcome in this file, and the web app produces one for reasons that have nothing
 * to do with the rep: an expired session, a mistyped list type (`t=PH` returns HTTP 200 with an
 * empty grid — see contacts-web-client.ts), a page redesign. So:
 *
 *   - An agent whose three lists ALL come back empty, while the mirror already holds rows for them,
 *     is REFUSED: their existing rows are left exactly as they are and the refusal is reported.
 *   - An agent who genuinely holds nothing is a real answer (13 of 15 district managers, and one
 *     medical rep, on the first sweep) — so this cannot simply throw. The mirror having rows is
 *     what separates the two.
 *   - A failed fetch is never treated as an empty one. It is recorded and that agent is skipped.
 *
 * This is the same instinct as decidePlanPrune in plan-sync.ts, applied per agent rather than to
 * the whole window, because here each agent's list is fetched independently and can fail alone.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeContactGrade } from "@/lib/crm/sync";
import { isMissingCrmRpcError } from "@/lib/crm/reads";
import { CRM_CONTACTS_TABLE, CRM_PLAN_ENTRIES_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import {
  crmWebFetchContacts,
  crmWebLogin,
  LIST_TYPES,
  type CrmContactRow,
  type CrmListType,
  type CrmWebSession,
} from "@/lib/crm/contacts-web-client";

const UPSERT_BATCH_SIZE = 500;
/** PostgREST puts `.in()` filters in the URL, where a few hundred ids silently return nothing. */
const DELETE_CHUNK = 50;

export type CrmContactSyncTarget = {
  agentCrmId: number;
  hrId: string | null;
};

export type CrmContactAgentOutcome = {
  agentCrmId: number;
  deleted: number;
  error: string | null;
  fetched: number;
  hrId: string | null;
  /** True when every list came back empty while the mirror still holds rows — nothing was deleted. */
  refusedEmpty: boolean;
  upserted: number;
};

export type CrmContactSyncResult = {
  agents: number;
  agentsFailed: number;
  agentsRefusedEmpty: number;
  contacts: number;
  deleted: number;
  outcomes: CrmContactAgentOutcome[];
  /** Agents this run never reached, because the time budget ran out before their turn came. */
  skipped: number;
  upserted: number;
};

/**
 * Did this slice refresh nothing at all?
 *
 * **`agents` counts ATTEMPTED agents, not refreshed ones.** A per-agent fetch that throws still
 * lands in `outcomes`, so `agents === 0` on its own reads a slice where the vendor login succeeded
 * and then every single agent failed as a SUCCESS — a green heartbeat over a twelfth of the roster
 * that got nothing, and (in the poller, which carries a cursor) the cursor stepping straight past
 * it, so the twelfth that failed waits a whole sweep instead of the advertised failure retry.
 *
 * Partial degradation deliberately stays green: a handful of `agentsFailed`, or an
 * `agentsRefusedEmpty` (the designed safety when the vendor answers an empty grid — see
 * `decideContactReplacement`), is an ordinary hiccup on someone else's web app, and a check that
 * pages on those gets muted. Total failure is not degradation. It means the slice did not run.
 *
 * `skipped` is NOT failure either — those agents were never started because the time budget ran
 * out, which is the slicing working as designed.
 *
 * Shared by the cron route and the in-process poller so the two can never disagree about what a
 * green contact-list heartbeat means.
 */
export function contactSyncSliceRefreshedNothing(
  result: Pick<CrmContactSyncResult, "agents" | "agentsFailed">,
): boolean {
  return result.agents === 0 || result.agentsFailed === result.agents;
}

/**
 * THE WHOLE SWEEP DOES NOT FIT IN ONE REQUEST, AND THE SCHEDULER CUTS AT 30 SECONDS.
 *
 * Measured 2026-08-28 with a one-shot probe against the real route: cron-job.org killed the
 * connection at 30.1s (`ms=30108`) with the job's own `requestTimeout` set to 300. The 30-second
 * limit is a PLATFORM cap, not a per-job setting — raising it is accepted by their API, read back
 * unchanged, and does nothing.
 *
 * THE WORK ITSELF STILL COMPLETES, so this is not a data-integrity fix and must not be described as
 * one. The audit row this route writes LAST landed at 20:09:43 Cairo covering all 82 agents, ~70
 * seconds after the client was killed. (A query taken at 20:09:02, mid-sweep, said "39 of 68
 * re-stamped" and was briefly reported as proof of truncation — it was the run still in progress.
 * Judge completion from the terminal artefact, never from row timestamps while the job may still
 * be running.)
 *
 * Slicing is worth doing for the honest reasons: a job that reports `Failed (timeout)` every single
 * night is one nobody reads, its response body is never visible, and finishing at all depends on a
 * detached request outliving a container restart. So the sweep takes a twelfth of the roster per
 * request, twelve requests five minutes apart inside one hour — measured on production at 7 agents
 * and 8-10 seconds per tick.
 */
export const CONTACT_SYNC_SLICE_COUNT = 12;

/**
 * Which slice a run at this instant belongs to, derived from the clock rather than from the URL.
 *
 * Twelve five-minute slots inside an hour, so ONE cron entry covers the whole roster instead of
 * twelve separate jobs. The minute is rounded to the NEAREST slot rather than floored, because a
 * scheduler firing at 05:04:58 for the 05:05 tick would otherwise repeat slice 0 and skip slice 1
 * every single day — a permanent hole in the roster that looks exactly like a healthy job.
 * Rounding tolerates about two and a half minutes of skew in either direction.
 *
 * Deliberately NO timezone conversion, and that is not an oversight. Only the minute within the
 * hour selects a slice, and Cairo is a whole-hour offset from UTC in both standard time and summer
 * time — so the Cairo minute and the UTC minute are always the same number. Converting would add a
 * dependency on a zone database to compute a value that cannot change. The schedule is still
 * written in Cairo time; only which twelfth this reads is offset-proof.
 */
export function contactSyncSliceForDate(date: Date): number {
  const withinHour = date.getUTCMinutes() * 60 + date.getUTCSeconds();
  return Math.round(withinHour / 300) % CONTACT_SYNC_SLICE_COUNT;
}

/**
 * Picks the agents belonging to one slice. Pure, so the partition is testable without a clock.
 *
 * Round-robin over the id-sorted roster, NOT `agentCrmId % of`: the vendor's ids are not evenly
 * spread, and on the live roster of 82 that modulo put 11 agents in one slice against 4 in
 * another — 11 agents is about 21 seconds, uncomfortably close to a 30-second cap. Round-robin
 * guarantees ceil(n / of), which is 7 here.
 *
 * A hire landing mid-window shifts the tail by one position, so one agent can be swept twice that
 * day and another can wait until tomorrow. Both are harmless: the sweep is idempotent, and a list
 * one day old is what this job produces on its best night anyway.
 */
export function selectContactSyncSlice<T>(targets: T[], slice: number, of: number): T[] {
  if (of <= 1) return [...targets];
  const index = ((slice % of) + of) % of;
  return targets.filter((_target, position) => position % of === index);
}

/**
 * The job titles whose CRM accounts hold a contact list worth mirroring.
 *
 * District managers are included even though almost none of them hold a list of their own — one of
 * fifteen did on 2026-08-28, with 25 doctors and not one of them planned that month. That is
 * exactly the kind of thing the owner needs to see, and it is invisible if the sweep never asks.
 */
export const CONTACT_LIST_JOB_TITLES = [
  "Medical Representative",
  "District Sales Manager",
  // Spelled exactly as `employees.job_title` spells it, because this list is handed straight to a
  // PostgREST `.in()` — a title missing here is not a smaller sweep, it is a district manager whose
  // contact list silently stops being mirrored with nothing to see. Added for B-94's promotion.
  "Senior District Manager",
  // The senior-grade medical-rep title (B-7, 2026-09-29). Same exact-`.in()` reason as above: a rep
  // whose title gained "Senior" must keep having her contact list mirrored, or her Reps List and CRM
  // board silently empty out — the sharpest behaviour change an appreciation label could cause.
  "Senior Medical Representative",
] as const;

/**
 * Resolves who to sync from Phoenix's own roster.
 *
 * The CRM agent id comes from the activity mirrors rather than from a column on `employees`,
 * because that is where the vendor's id actually lives and it is the same key the contact grid
 * returns. A brand-new hire has no activity yet and therefore no id — they are reported as
 * unresolved rather than silently dropped, since "this rep has no CRM account yet" and "this rep
 * has no doctors" must never look the same.
 */
export async function loadCrmContactSyncTargets(): Promise<{
  targets: CrmContactSyncTarget[];
  unresolved: { hrId: string; name: string }[];
}> {
  const supabase = getSupabaseAdmin();
  const { data: employees, error } = await supabase
    .from("employees")
    .select("hr_id, full_name, job_title")
    .eq("employment_status", "active")
    .in("job_title", [...CONTACT_LIST_JOB_TITLES]);
  if (error) throw new Error(`Could not read the employee roster: ${error.message}`);

  const hrIds = (employees ?? []).map((row) => row.hr_id as string);
  const agentByHrId = await resolveAgentCrmIdsByHr(hrIds);

  const targets: CrmContactSyncTarget[] = [];
  const unresolved: { hrId: string; name: string }[] = [];
  for (const employee of employees ?? []) {
    const hrId = employee.hr_id as string;
    const agentCrmId = agentByHrId.get(hrId);
    if (agentCrmId == null) {
      unresolved.push({ hrId, name: (employee.full_name as string) ?? hrId });
      continue;
    }
    targets.push({ agentCrmId, hrId });
  }
  targets.sort((left, right) => left.agentCrmId - right.agentCrmId);
  return { targets, unresolved };
}

const AGENT_CRM_IDS_BY_HR_RPC = "phx_crm_agent_crm_ids_by_hr";

/**
 * Every HR id's CRM agent id, the highest across the visit and plan-entry mirrors, in ONE statement.
 *
 * 2026-10-25 production load audit: the chunked read below scanned all 198,723 plan entries per
 * chunk (124 calls at 229 ms), and each chunk matched about half the table, of which PostgREST
 * returned only its first 1,000 rows. The function answers from two index-only scans as one jsonb
 * value, so no row cap applies. See
 * supabase/migrations/20261025233000_crm_plan_entries_agent_hr_id_index.sql.
 */
export async function resolveAgentCrmIdsByHr(hrIds: string[]): Promise<Map<string, number>> {
  if (hrIds.length === 0) return new Map();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc(AGENT_CRM_IDS_BY_HR_RPC, { p_hr_ids: hrIds });
  if (error) {
    if (isMissingCrmRpcError(error)) return resolveAgentCrmIdsByHrInChunks(hrIds);
    throw new Error(`Could not resolve CRM agent ids: ${error.message}`);
  }
  return agentCrmIdsFromTuples((Array.isArray(data) ? data : []) as [string, number | null][]);
}

/** The function's [hr_id, agent_crm_id] pairs as the map the sync reads; highest id wins. Pure; exported for its test. */
export function agentCrmIdsFromTuples(tuples: [string, number | null][]): Map<string, number> {
  const agentByHrId = new Map<string, number>();
  for (const [hrId, agentId] of tuples) {
    if (!hrId || agentId == null) continue;
    const id = Number(agentId);
    const current = agentByHrId.get(hrId);
    if (current == null || id > current) agentByHrId.set(hrId, id);
  }
  return agentByHrId;
}

/** The pre-function read, kept only for a database that has not got `phx_crm_agent_crm_ids_by_hr` yet. */
async function resolveAgentCrmIdsByHrInChunks(hrIds: string[]): Promise<Map<string, number>> {
  const supabase = getSupabaseAdmin();
  const agentByHrId = new Map<string, number>();
  for (const table of [CRM_VISITS_TABLE, CRM_PLAN_ENTRIES_TABLE] as const) {
    for (let index = 0; index < hrIds.length; index += DELETE_CHUNK) {
      const chunk = hrIds.slice(index, index + DELETE_CHUNK);
      const { data, error: readError } = await supabase
        .from(table)
        .select("agent_hr_id, agent_crm_id")
        .in("agent_hr_id", chunk)
        .not("agent_crm_id", "is", null);
      if (readError) throw new Error(`Could not resolve CRM agent ids: ${readError.message}`);
      for (const row of data ?? []) {
        const hrId = row.agent_hr_id as string | null;
        const agentId = row.agent_crm_id as number | null;
        if (!hrId || agentId == null) continue;
        // Highest id wins: a rehired or re-seated person can appear under an older account too, and
        // the newest account is the live one (the admin clones rather than renames).
        const current = agentByHrId.get(hrId);
        if (current == null || agentId > current) agentByHrId.set(hrId, agentId);
      }
    }
  }
  return agentByHrId;
}

export function rowFromContact(
  contact: CrmContactRow,
  target: CrmContactSyncTarget,
  listType: CrmListType,
) {
  const now = new Date().toISOString();
  return {
    address: contact.address,
    agent_crm_id: target.agentCrmId,
    // THE TARGET'S OWN HR ID — never re-resolved from the CRM id.
    //
    // This used to call resolveEmployeeHrId(agentCrmId, null, maps, null), reasoning that "a list is
    // a statement about today, so today's mapping is the right one". The reasoning was right and the
    // instrument was wrong. That waterfall is built for a VISIT, which carries a date and the
    // vendor's own label to tell a handed-over account's two occupants apart; a contact list has
    // NEITHER, so the call landed on tier 2 — the tier identity.ts's own comment names as "the tier
    // that misattributes a reused CRM slot" — and answered with whoever `employees.crm_id` points
    // at, which on a reused slot is the rep who LEFT.
    //
    // Measured on production 2026-09-21, both live: slot 1399's 103 rows were stamped B-97 (resigned
    // 2026-06-28) though the account is Ahmed Farag Soliman Elakraa's (AI-0020, 72 visits), and slot
    // 1485's 158 rows were stamped B-171 (resigned 2026-07-11) though the account is Manar Sadek's
    // (CN-0007, 37 visits). The daily sweep re-stamped both every morning.
    //
    // `target.hrId` cannot have that failure mode: loadCrmContactSyncTargets builds it from the
    // ACTIVE employee roster and resolves the CRM id from that person's own visit and plan rows, so
    // it is today's holder by construction — which is exactly what this module's header says drives
    // the sweep in the first place.
    agent_hr_id: target.hrId,
    city: contact.city,
    contact_crm_id: contact.contactCrmId,
    contact_grade: normalizeContactGrade(contact.grade),
    contact_name: contact.name,
    contact_name_ar: contact.nameAr,
    crm_region_name: contact.region,
    list_type: listType,
    phone: contact.phone,
    raw_payload: contact as unknown as Record<string, unknown>,
    speciality: contact.speciality,
    synced_at: now,
    updated_at: now,
    zone: contact.zone,
  };
}

export type CrmContactDraftRow = ReturnType<typeof rowFromContact>;

/** The composite key, as one string, for set arithmetic before a delete. */
export function contactRowKey(row: {
  agent_crm_id: number;
  contact_crm_id: number;
  list_type: string;
}): string {
  return `${row.agent_crm_id}|${row.contact_crm_id}|${row.list_type}`;
}

/**
 * Decides what to do with one agent's fetched lists. Pure, so the refusal rule is testable without
 * a database or the vendor.
 */
export function decideContactReplacement(input: {
  fetchedKeys: string[];
  mirroredKeys: string[];
}): { refusedEmpty: boolean; staleKeys: string[] } {
  if (!input.fetchedKeys.length && input.mirroredKeys.length > 0) {
    return { refusedEmpty: true, staleKeys: [] };
  }
  const fetched = new Set(input.fetchedKeys);
  return {
    refusedEmpty: false,
    staleKeys: input.mirroredKeys.filter((key) => !fetched.has(key)),
  };
}

async function mirroredKeysForAgent(agentCrmId: number): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CONTACTS_TABLE)
    .select("agent_crm_id, contact_crm_id, list_type")
    .eq("agent_crm_id", agentCrmId);
  if (error) throw new Error(`Could not read the mirrored contact list: ${error.message}`);
  return (data ?? []).map((row) =>
    contactRowKey(row as { agent_crm_id: number; contact_crm_id: number; list_type: string }),
  );
}

async function syncOneAgent(
  session: CrmWebSession,
  target: CrmContactSyncTarget,
  seenContacts: Set<number>,
): Promise<CrmContactAgentOutcome> {
  const outcome: CrmContactAgentOutcome = {
    agentCrmId: target.agentCrmId,
    deleted: 0,
    error: null,
    fetched: 0,
    hrId: target.hrId,
    refusedEmpty: false,
    upserted: 0,
  };

  const rows: CrmContactDraftRow[] = [];
  for (const listType of LIST_TYPES) {
    // A single failed list is not an empty list. Recording the error and returning early keeps the
    // replacement from running on a partial answer, which would delete the lists that DID load.
    try {
      const contacts = await crmWebFetchContacts(session, target.agentCrmId, listType);
      for (const contact of contacts) rows.push(rowFromContact(contact, target, listType));
    } catch (error) {
      outcome.error = `${listType}: ${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }
  }
  outcome.fetched = rows.length;

  // The same contact can legitimately appear twice in one list's grid; the composite key is what
  // the table enforces, so collapse on it before upserting or the batch self-conflicts.
  const byKey = new Map<string, CrmContactDraftRow>();
  for (const row of rows) byKey.set(contactRowKey(row), row);
  const unique = [...byKey.values()];
  for (const row of unique) seenContacts.add(row.contact_crm_id);

  const mirrored = await mirroredKeysForAgent(target.agentCrmId);
  const decision = decideContactReplacement({
    fetchedKeys: [...byKey.keys()],
    mirroredKeys: mirrored,
  });
  if (decision.refusedEmpty) {
    outcome.refusedEmpty = true;
    return outcome;
  }

  const supabase = getSupabaseAdmin();
  for (let index = 0; index < unique.length; index += UPSERT_BATCH_SIZE) {
    const batch = unique.slice(index, index + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from(CRM_CONTACTS_TABLE)
      // first_seen_at is deliberately absent from every row built above, so the column default
      // applies on insert and the stored value survives an update untouched.
      .upsert(batch, { onConflict: "agent_crm_id,contact_crm_id,list_type" });
    if (error) throw new Error(`Could not write the contact list: ${error.message}`);
    outcome.upserted += batch.length;
  }

  for (let index = 0; index < decision.staleKeys.length; index += DELETE_CHUNK) {
    const chunk = decision.staleKeys.slice(index, index + DELETE_CHUNK);
    for (const key of chunk) {
      const [, contactId, listType] = key.split("|");
      const { error } = await supabase
        .from(CRM_CONTACTS_TABLE)
        .delete()
        .eq("agent_crm_id", target.agentCrmId)
        .eq("contact_crm_id", Number(contactId))
        .eq("list_type", listType);
      if (error) throw new Error(`Could not remove a stale contact: ${error.message}`);
      outcome.deleted += 1;
    }
  }
  return outcome;
}

/**
 * Refreshes the contact-list mirror for the given agents.
 *
 * One login is shared across the whole sweep — the web app issues a session cookie, and 246
 * requests on one session completed without a single failure on 2026-08-28. Agents are processed
 * in sequence rather than in parallel: this is someone else's production web app, and a contact
 * list changes slowly enough that a few minutes of wall clock costs nothing.
 *
 * `deadlineAt` is the second guard behind the slicing above, and it is the one that cannot be
 * knocked out by a roster change or a slow night at the vendor. An agent is only STARTED while
 * there is budget left; one already running is always allowed to finish, so a run never stops
 * between an agent's upserts and its deletes. Agents never reached are counted, not hidden — a
 * `skipped` above zero is the signal that the window needs another tick or a wider spread.
 */
export async function syncCrmContactLists(input: {
  deadlineAt?: number;
  targets: CrmContactSyncTarget[];
}): Promise<CrmContactSyncResult> {
  const session = await crmWebLogin();

  const contacts = new Set<number>();
  const outcomes: CrmContactAgentOutcome[] = [];
  let skipped = 0;
  for (const target of input.targets) {
    if (input.deadlineAt != null && Date.now() >= input.deadlineAt) {
      skipped += 1;
      continue;
    }
    outcomes.push(await syncOneAgent(session, target, contacts));
  }

  return {
    agents: outcomes.length,
    agentsFailed: outcomes.filter((outcome) => outcome.error).length,
    agentsRefusedEmpty: outcomes.filter((outcome) => outcome.refusedEmpty).length,
    contacts: contacts.size,
    deleted: outcomes.reduce((sum, outcome) => sum + outcome.deleted, 0),
    outcomes,
    skipped,
    upserted: outcomes.reduce((sum, outcome) => sum + outcome.upserted, 0),
  };
}
