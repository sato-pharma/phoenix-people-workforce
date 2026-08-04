/**
 * CRM admin/back-office reads + writes: the sync-run history and the unmapped-CRM-identity
 * punch-list + resolver. These power the CRM control center (sync health + "Unmapped Agents").
 * Relocated verbatim from visits-report/service.ts; behavior unchanged.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { getCrmIdentityResolutions, normalizeCrmName } from "@/lib/crm/identity";
import { getEffectiveExcludedAgentCrmIds } from "@/lib/crm/reads";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { CRM_IDENTITY_RESOLUTIONS_TABLE, CRM_SYNC_RUNS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  UnmappedCrmIdentityRow,
  UnmappedCrmResolutionAction,
  UnmappedCrmResolutionResult,
  VisitsSyncRun,
  VisitsSyncTrigger,
} from "@/lib/visits-report/types";

const visitsTable = CRM_VISITS_TABLE;
const syncRunsTable = CRM_SYNC_RUNS_TABLE;
const resolutionsTable = CRM_IDENTITY_RESOLUTIONS_TABLE;

type MutableUnmappedIdentity = {
  crmId: number;
  firstSeen: string;
  lastSeen: string;
  name: string;
  roles: Set<"agent" | "double">;
  visitCount: number;
};

function recordUnmappedIdentity(
  identities: Map<number, MutableUnmappedIdentity>,
  crmId: number | null,
  name: string | null,
  visitDate: string,
  role: "agent" | "double",
) {
  if (crmId == null) return;
  const existing = identities.get(crmId);
  if (!existing) {
    identities.set(crmId, { crmId, firstSeen: visitDate, lastSeen: visitDate, name: name ?? "(no name on visit)", roles: new Set([role]), visitCount: 1 });
    return;
  }
  existing.visitCount += 1;
  existing.roles.add(role);
  if (visitDate < existing.firstSeen) existing.firstSeen = visitDate;
  if (visitDate >= existing.lastSeen) {
    existing.lastSeen = visitDate;
    // Keep the NEWEST label, not the first-seen one: a handed-over CRM account carries the
    // current occupant's name on its latest rows, and this name is what the panel shows AND what
    // a "mapped" decision records as the label the mapping applies to (see stampUnmappedVisitRows
    // and the label-scoped override tier in identity.ts). Showing/recording the old occupant's
    // label would scope the mapping to exactly the wrong rows.
    if (name) existing.name = name;
  }
}

/**
 * Rolls up every currently-unmapped CRM agent/double-visitor identity (by crm_id) across the
 * FULL history of ireports360_visits into one row per identity — a punch-list for fixing
 * employees.crm_id/crm_username (see the Mostafa Mamdouh case: crm_id drifted to a new CRM
 * value and the display-name had a stray extra space), instead of scrolling through thousands
 * of individual unmapped visit rows one at a time. Not date-scoped on purpose — the goal is to
 * find every identity that still needs a roster fix, not just ones active in a chosen window.
 *
 * Paginates by keyset (`id > cursor`) rather than OFFSET (`.range()`). agent_hr_id IS NULL is
 * only ~8% selective on this table, so OFFSET pagination re-scans from the start of the table
 * on every page to skip past already-returned rows — cost grows with page count squared and
 * blew the 8s Postgres statement timeout in practice. Keyset pagination only visits each row
 * once across the whole scan, independent of how many pages it takes.
 */
export async function getUnmappedCrmIdentities(): Promise<UnmappedCrmIdentityRow[]> {
  const supabase = getSupabaseAdmin();
  const identities = new Map<number, MutableUnmappedIdentity>();
  const pageSize = 1000;

  // Identities an admin has already marked "resigned" stay genuinely unmapped in
  // ireports360_visits on purpose (see setUnmappedCrmIdentityResolution) — exclude them from
  // the list here rather than mutating the underlying visit rows. "mapped" identities need no
  // such exclusion: their visit rows get agent_hr_id/double_hr_id stamped immediately, so the
  // `.is(..., null)` scans below naturally stop returning them.
  const resolutions = await getCrmIdentityResolutions();
  const resignedCrmIds = new Set<number>([
    ...resolutions.filter((r) => r.status === "resigned").map((r) => r.crmId),
    // Also drop the effective (static ∪ live departed) excluded agents — the same set every CRM read
    // hides — so a never-mapped excluded agent can't linger on the punch-list asking an admin to map
    // someone deliberately kept out.
    ...(await getEffectiveExcludedAgentCrmIds()),
  ]);

  let agentCursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select("id, agent_crm_id, agent_name, visit_date")
      .is("agent_hr_id", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (agentCursor) query = query.gt("id", agentCursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ agent_crm_id: number; agent_name: string | null; id: string; visit_date: string }>;
    for (const row of page) recordUnmappedIdentity(identities, row.agent_crm_id, row.agent_name, row.visit_date, "agent");
    if (page.length < pageSize) break;
    agentCursor = page[page.length - 1].id;
  }

  let doubleCursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select("id, double_crm_id, double_name, visit_date")
      .not("double_crm_id", "is", null)
      .is("double_hr_id", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (doubleCursor) query = query.gt("id", doubleCursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ double_crm_id: number; double_name: string | null; id: string; visit_date: string }>;
    for (const row of page) recordUnmappedIdentity(identities, row.double_crm_id, row.double_name, row.visit_date, "double");
    if (page.length < pageSize) break;
    doubleCursor = page[page.length - 1].id;
  }

  return Array.from(identities.values())
    .filter((identity) => !resignedCrmIds.has(identity.crmId))
    .map((identity) => ({ ...identity, roles: Array.from(identity.roles) }))
    .sort((a, b) => b.visitCount - a.visitCount);
}

/**
 * Records an admin's decision for one unmapped CRM identity:
 * - "resigned": stores the decision only — the identity drops out of getUnmappedCrmIdentities,
 *   but its ireports360_visits rows stay unmapped forever, on purpose.
 * - "mapped": validates mappedHrId against the real employee roster (by canonical HR ID, not a
 *   raw string compare — casing/symbols vary), stamps it onto every currently-unmapped visit
 *   row for this crm_id immediately (so the Visit Log tab reflects it right away), and records
 *   it so future syncs resolve this identity too (see resolveEmployeeHrId's manual-override tier).
 * - "pending": explicitly resets to the default, no-decision state.
 */
export async function setUnmappedCrmIdentityResolution(input: {
  action: UnmappedCrmResolutionAction;
  crmId: number;
  crmName?: string | null;
  mappedHrId?: string | null;
  resolvedByHrId: string | null;
}): Promise<UnmappedCrmResolutionResult> {
  const supabase = getSupabaseAdmin();

  let resolvedHrId: string | null = null;
  let resolvedName: string | null = null;
  if (input.action === "mapped") {
    const typed = input.mappedHrId?.trim();
    if (!typed) throw new Error("An HR ID is required to map this identity.");
    const employees = await getEmployeeDirectoryRows({ includeInactive: true });
    const key = canonicalHrIdKey(typed);
    const match = employees.find((employee) => canonicalHrIdKey(employee.hrId) === key);
    if (!match) throw new Error(`No employee found with HR ID "${typed}".`);
    resolvedHrId = match.hrId;
    resolvedName = match.fullName;
  }

  const { error: upsertError } = await supabase.from(resolutionsTable).upsert(
    {
      crm_id: input.crmId,
      crm_name: input.crmName ?? null,
      mapped_hr_id: resolvedHrId,
      resolved_at: new Date().toISOString(),
      resolved_by_hr_id: input.resolvedByHrId,
      status: input.action,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "crm_id" },
  );
  if (upsertError) throw new Error(upsertError.message);

  let updatedVisits = 0;
  if (input.action === "mapped" && resolvedHrId) {
    updatedVisits += await stampUnmappedVisitRows(supabase, {
      crmId: input.crmId,
      crmName: input.crmName ?? null,
      hrId: resolvedHrId,
      idColumn: "agent_crm_id",
      nameColumn: "agent_name",
      targetColumn: "agent_hr_id",
    });
    updatedVisits += await stampUnmappedVisitRows(supabase, {
      crmId: input.crmId,
      crmName: input.crmName ?? null,
      hrId: resolvedHrId,
      idColumn: "double_crm_id",
      nameColumn: "double_name",
      targetColumn: "double_hr_id",
    });
  }

  return { resolvedEmployeeHrId: resolvedHrId, resolvedEmployeeName: resolvedName, updatedVisits };
}

/**
 * Stamps the mapped hr id onto currently-unmapped visit rows for one CRM account — LABEL-SCOPED
 * when the decision recorded the CRM display label it was made against. Production slots 1102,
 * 1395 and 1399 each carry two different people's names across their history (a leaver's rows,
 * then the replacement's), so the old blanket "every null row for this crm_id" stamp would file
 * the previous occupant's work under the new hire. Rows whose label doesn't normalize to the
 * decision's label are left unmapped for their own, separate decision. Without a recorded label
 * (legacy callers) the blanket behavior is preserved. Name matching happens in JS via
 * normalizeCrmName — the vendor emits the same person's label with inconsistent internal
 * whitespace, so a SQL equality filter would silently skip real rows.
 */
async function stampUnmappedVisitRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: {
    crmId: number;
    crmName: string | null;
    hrId: string;
    idColumn: "agent_crm_id" | "double_crm_id";
    nameColumn: "agent_name" | "double_name";
    targetColumn: "agent_hr_id" | "double_hr_id";
  },
): Promise<number> {
  const decisionLabel = normalizeCrmName(input.crmName);
  if (!decisionLabel) {
    const { count, error } = await supabase
      .from(visitsTable)
      .update({ [input.targetColumn]: input.hrId, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq(input.idColumn, input.crmId)
      .is(input.targetColumn, null);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  const matchingIds: string[] = [];
  const pageSize = 1000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select(`id, ${input.nameColumn}`)
      .eq(input.idColumn, input.crmId)
      .is(input.targetColumn, null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Array<{ id: string } & Record<string, string | null>>;
    if (page.length === 0) break;
    for (const row of page) {
      if (normalizeCrmName(row[input.nameColumn]) === decisionLabel) matchingIds.push(row.id);
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }

  let updated = 0;
  for (let from = 0; from < matchingIds.length; from += 500) {
    const chunk = matchingIds.slice(from, from + 500);
    const { count, error } = await supabase
      .from(visitsTable)
      .update({ [input.targetColumn]: input.hrId, updated_at: new Date().toISOString() }, { count: "exact" })
      .in("id", chunk);
    if (error) throw new Error(error.message);
    updated += count ?? chunk.length;
  }
  return updated;
}

function mapSyncRun(row: Record<string, unknown>): VisitsSyncRun {
  return {
    completedAt: (row.completed_at as string | null) ?? null,
    dateFrom: row.date_from as string,
    dateTo: row.date_to as string,
    errorMessage: (row.error_message as string | null) ?? null,
    id: row.id as string,
    rowsDeleted: Number(row.rows_deleted ?? 0),
    rowsFetched: Number(row.rows_fetched ?? 0),
    rowsSkippedInvalidDate: Number(row.rows_skipped_invalid_date ?? 0),
    rowsSkippedReconcile: Number(row.rows_skipped_reconcile ?? 0),
    rowsUpserted: Number(row.rows_upserted ?? 0),
    startedAt: row.started_at as string,
    status: row.status as VisitsSyncRun["status"],
    trigger: row.trigger as VisitsSyncTrigger,
  };
}

export async function getLatestVisitsSyncRuns(limit = 10): Promise<VisitsSyncRun[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(syncRunsTable)
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isCrmSchemaMissingError(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Record<string, unknown>[]).map(mapSyncRun);
}
