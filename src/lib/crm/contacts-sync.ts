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
import { loadCrmIdentityMaps, resolveEmployeeHrId, type CrmIdentityMaps } from "@/lib/crm/identity";
import { normalizeContactGrade } from "@/lib/crm/sync";
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
 * THE WHOLE SWEEP DOES NOT FIT IN ONE REQUEST, AND THE SCHEDULER CUTS AT 30 SECONDS.
 *
 * Measured 2026-08-28 with a one-shot probe against the real route: cron-job.org killed the
 * connection at 30.1s (`ms=30108`) with the job's own `requestTimeout` set to 300. The 30-second
 * limit is a PLATFORM cap, not a per-job setting — raising the setting is accepted by their API and
 * changes nothing. The dangerous half of that measurement is what the database showed afterwards:
 * 39 of 68 agents re-stamped, the rest untouched. The server does NOT quietly finish the work after
 * the client hangs up. A single nightly request would therefore report failure every night AND
 * leave the mirror half refreshed — the two outcomes this module exists to avoid.
 *
 * The fix is to sweep a twelfth of the roster per request, twelve requests five minutes apart
 * inside one hour. Each tick is about 7 agents, roughly 14 seconds of vendor calls.
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

export function rowFromContact(
  contact: CrmContactRow,
  agentCrmId: number,
  listType: CrmListType,
  maps: CrmIdentityMaps,
) {
  const now = new Date().toISOString();
  return {
    address: contact.address,
    agent_crm_id: agentCrmId,
    // No date to scope the attribution to: a list is a statement about today, so today's mapping
    // is the right one. That is the opposite of a visit, which must resolve as-of its own date.
    agent_hr_id: resolveEmployeeHrId(agentCrmId, null, maps, null),
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
  maps: CrmIdentityMaps,
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
      for (const contact of contacts) rows.push(rowFromContact(contact, target.agentCrmId, listType, maps));
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
  const maps = await loadCrmIdentityMaps();
  const session = await crmWebLogin();

  const contacts = new Set<number>();
  const outcomes: CrmContactAgentOutcome[] = [];
  let skipped = 0;
  for (const target of input.targets) {
    if (input.deadlineAt != null && Date.now() >= input.deadlineAt) {
      skipped += 1;
      continue;
    }
    outcomes.push(await syncOneAgent(session, target, maps, contacts));
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
