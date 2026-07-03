import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { refreshFieldWorkforceComplianceLiveSnapshotsForRange } from "@/lib/field-workforce-compliance/live-snapshots";
import {
  iReports360GetCheckins,
  iReports360GetVisits,
  iReports360Login,
  type IReports360Checkin,
  type IReports360Visit,
} from "@/lib/field-workforce-compliance/ireports360-client";
import { getIReports360Config, isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  UnmappedCrmIdentityRow,
  UnmappedCrmResolutionAction,
  UnmappedCrmResolutionResult,
  VisitsReportData,
  VisitsReportExportResult,
  VisitsReportFilterInput,
  VisitsReportRow,
  VisitsSyncRun,
  VisitsSyncTrigger,
} from "@/lib/visits-report/types";

const visitsTable = "ireports360_visits";
const checkinsTable = "ireports360_checkins";
const syncRunsTable = "ireports360_visits_sync_runs";
const resolutionsTable = "ireports360_crm_identity_resolutions";
const upsertBatchSize = 500;
const MAX_EXPORT_ROWS = 20000;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function schemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return /ireports360_(visits|checkins|crm_identity_resolutions)|schema cache|does not exist|PGRST205|42P01/i.test(message);
}

async function isSchemaReady() {
  const { error } = await getSupabaseAdmin().from(visitsTable).select("id", { count: "exact", head: true }).limit(1);
  return !schemaMissing(error);
}

// ── CRM identity matching (manual override, then crm_id, then crm_username) ────────
//
// Mirrors the crm_id-primary / crm_username-secondary waterfall already used in
// src/lib/sales/employees.ts's CRM linking and
// src/lib/double-visit-analytics/parser.ts's recoverVisitedEmployeesByCrmUsername, with an
// admin-entered manual override (from the Unmapped Agents tab) checked first — a human
// decision always wins over an automatic guess.

type CrmResolutionRow = { crmId: number; mappedHrId: string | null; status: UnmappedCrmResolutionAction };

type CrmIdentityMaps = {
  hrIdByCrmId: Map<string, string>;
  hrIdByCrmUsername: Map<string, string>;
  hrIdByManualOverride: Map<string, string>;
};

/**
 * Trims + lowercases + collapses internal whitespace runs to a single space. The CRM's own
 * display-name text has been observed with inconsistent spacing for the same person across
 * records (e.g. "Alex East / P" vs "Alex East  / P" — a stray double space), so a plain
 * trim+lowercase alone under-matches; this normalizes both sides of the comparison the same way.
 */
function normalizeCrmName(name: string | null | undefined): string | null {
  const normalized = name?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? normalized : null;
}

/**
 * The crm_username map only keeps values unique across the active+inactive roster — an
 * ambiguous (2+) match is excluded rather than guessing wrong, same safety rule as the
 * double-visit-analytics precedent.
 */
function buildCrmIdentityMaps(employees: EmployeeDirectoryRow[], resolutions: CrmResolutionRow[] = []): CrmIdentityMaps {
  const hrIdByCrmId = new Map<string, string>();
  for (const employee of employees) {
    if (employee.crmId) hrIdByCrmId.set(employee.crmId, employee.hrId);
  }

  const usernameGroups = new Map<string, string[]>();
  for (const employee of employees) {
    const key = normalizeCrmName(employee.crmUsername);
    if (!key) continue;
    usernameGroups.set(key, [...(usernameGroups.get(key) ?? []), employee.hrId]);
  }
  const hrIdByCrmUsername = new Map<string, string>();
  for (const [key, hrIds] of usernameGroups) {
    if (hrIds.length === 1) hrIdByCrmUsername.set(key, hrIds[0]);
  }

  const hrIdByManualOverride = new Map<string, string>();
  for (const resolution of resolutions) {
    if (resolution.status === "mapped" && resolution.mappedHrId) {
      hrIdByManualOverride.set(String(resolution.crmId), resolution.mappedHrId);
    }
  }

  return { hrIdByCrmId, hrIdByCrmUsername, hrIdByManualOverride };
}

/**
 * Manual override first (an admin's explicit "map to this HR ID" decision from the Unmapped
 * Agents tab always wins); then crm_id; then falls back to matching the CRM's display name
 * (which IS the crm_username, e.g. "Rasha.Sabry ( P.M / F )" — confirmed from real captured
 * iReports360 data) against a unique crm_username on the roster.
 */
function resolveEmployeeHrId(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
): string | null {
  if (crmId != null) {
    const overridden = maps.hrIdByManualOverride.get(String(crmId));
    if (overridden) return overridden;
    const byId = maps.hrIdByCrmId.get(String(crmId));
    if (byId) return byId;
  }
  const key = normalizeCrmName(name);
  if (!key) return null;
  return maps.hrIdByCrmUsername.get(key) ?? null;
}

/** Every stored admin resolution decision — small table (bounded by distinct crm_id count),
 * no pagination needed. Returns [] before the migration ships so callers degrade gracefully. */
async function getCrmIdentityResolutions(): Promise<CrmResolutionRow[]> {
  const { data, error } = await getSupabaseAdmin().from(resolutionsTable).select("crm_id, status, mapped_hr_id");
  if (error) {
    if (schemaMissing(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Array<{ crm_id: number; mapped_hr_id: string | null; status: string }>).map((row) => ({
    crmId: row.crm_id,
    mappedHrId: row.mapped_hr_id,
    status: row.status as UnmappedCrmResolutionAction,
  }));
}

function rowFromVisit(visit: IReports360Visit, maps: CrmIdentityMaps) {
  const doubleCrmId = visit.doubleID && visit.doubleID !== 0 ? visit.doubleID : null;
  return {
    agent_crm_id: visit.agentID,
    agent_hr_id: resolveEmployeeHrId(visit.agentID, visit.agentName, maps),
    agent_name: visit.agentName,
    ampm: visit.ampm,
    attendance: visit.attendance,
    call_type: visit.callType,
    comment: visit.comment,
    contact_crm_id: visit.contactID,
    contact_name: visit.contactName,
    crm_save_date: visit.saveDate,
    crm_visit_id: visit.id,
    customer_name: visit.customerName,
    double_crm_id: doubleCrmId,
    double_hr_id: doubleCrmId ? resolveEmployeeHrId(doubleCrmId, visit.doubleName, maps) : null,
    double_name: visit.doubleName,
    raw_payload: visit as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    visit_date: visit.visitDate.slice(0, 10),
    visit_date_time: visit.visitDate,
    visit_type: visit.visitType,
    visit_type_description: visit.visitTypeDescription,
  };
}

function rowFromCheckin(checkin: IReports360Checkin, maps: CrmIdentityMaps) {
  return {
    address: checkin.address,
    agent_crm_id: checkin.agentID,
    // Check-ins have no agent display-name field (crm_id only) — the crm_username fallback
    // can't apply here, only the direct crm_id match.
    agent_hr_id: resolveEmployeeHrId(checkin.agentID, null, maps),
    check_date: checkin.checkDate,
    contact_crm_id: checkin.contactID,
    contact_name: checkin.contactName,
    crm_checkin_id: checkin.id,
    lat: checkin.lat,
    lon: checkin.lon,
    raw_payload: checkin as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Pulls every visit AND check-in iReports360 recorded in [dateFrom, dateTo] in one
 * authenticated session, and upserts them into ireports360_visits / ireports360_checkins,
 * keyed on the CRM's own crm_visit_id / crm_checkin_id — re-running over an overlapping range
 * (which the recurring cron does deliberately, to catch late CRM edits) is safe and
 * idempotent. Logs a row in ireports360_visits_sync_runs for every attempt, success or
 * failure, so sync freshness is visible instead of silent.
 */
export async function syncIReports360Visits(input: {
  dateFrom: string;
  dateTo: string;
  trigger: VisitsSyncTrigger;
}): Promise<{
  checkinsFetched: number;
  checkinsUpserted: number;
  fieldWorkforceComplianceRefresh: { refreshed: string[]; warnings: string[] };
  rowsFetched: number;
  rowsUpserted: number;
  runId: string;
}> {
  if (!isIReports360Configured()) {
    throw new Error("iReports360 is not configured (missing IREPORTS360_BASE_URL/USERNAME/PASSWORD).");
  }
  const supabase = getSupabaseAdmin();
  const { data: runRow, error: runError } = await supabase
    .from(syncRunsTable)
    .insert({ date_from: input.dateFrom, date_to: input.dateTo, status: "running", trigger: input.trigger })
    .select("id")
    .single();
  if (runError || !runRow) throw new Error(runError?.message ?? "Failed to start a sync run record.");
  const runId = runRow.id as string;

  try {
    const config = getIReports360Config();
    const token = await iReports360Login(config);
    const [visits, checkins] = await Promise.all([
      iReports360GetVisits(config, token, input.dateFrom, input.dateTo),
      // GPS check-ins are a best-effort overlay for visits, never required for the sync to
      // succeed — a check-ins API problem must not fail the whole run (same rule already
      // applied to the single-rep FWC drill-down this pattern is mirrored from).
      iReports360GetCheckins(config, token, input.dateFrom, input.dateTo).catch(() => [] as IReports360Checkin[]),
    ]);

    const [employees, resolutions] = await Promise.all([
      getEmployeeDirectoryRows({ includeInactive: true }),
      getCrmIdentityResolutions(),
    ]);
    const maps = buildCrmIdentityMaps(employees, resolutions);

    const visitRows = visits.map((visit) => rowFromVisit(visit, maps));
    let visitsUpserted = 0;
    for (let index = 0; index < visitRows.length; index += upsertBatchSize) {
      const chunk = visitRows.slice(index, index + upsertBatchSize);
      const { error } = await supabase.from(visitsTable).upsert(chunk, { onConflict: "crm_visit_id" });
      if (error) throw new Error(error.message);
      visitsUpserted += chunk.length;
    }

    const checkinRows = checkins.map((checkin) => rowFromCheckin(checkin, maps));
    let checkinsUpserted = 0;
    for (let index = 0; index < checkinRows.length; index += upsertBatchSize) {
      const chunk = checkinRows.slice(index, index + upsertBatchSize);
      const { error } = await supabase.from(checkinsTable).upsert(chunk, { onConflict: "crm_checkin_id" });
      if (error) throw new Error(error.message);
      checkinsUpserted += chunk.length;
    }

    await supabase
      .from(syncRunsTable)
      .update({ completed_at: new Date().toISOString(), rows_fetched: visits.length, rows_upserted: visitsUpserted, status: "success" })
      .eq("id", runId);

    // Best-effort: keep Field Workforce Compliance's per-month snapshots current for whatever
    // this sync just touched. Never throws (see the function's own doc comment) — a snapshot
    // recompute failure must not turn an otherwise-successful visits sync into an error.
    const fieldWorkforceComplianceRefresh = await refreshFieldWorkforceComplianceLiveSnapshotsForRange({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });

    return { checkinsFetched: checkins.length, checkinsUpserted, fieldWorkforceComplianceRefresh, rowsFetched: visits.length, rowsUpserted: visitsUpserted, runId };
  } catch (error) {
    await supabase
      .from(syncRunsTable)
      .update({
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error),
        status: "failed",
      })
      .eq("id", runId);
    throw error;
  }
}

/** The recurring cron's window: always re-pulls the last N days so late CRM edits get caught. */
export async function runScheduledIReports360Sync(lookbackDays = 10) {
  const dateTo = todayIso();
  const dateFrom = addDaysIso(dateTo, -lookbackDays);
  return syncIReports360Visits({ dateFrom, dateTo, trigger: "cron" });
}

/**
 * One-time (or periodic) retroactive fix: re-resolves agent_hr_id/double_hr_id for rows that
 * are currently unmapped, using the crm_username fallback against the already-stored
 * agent_name/double_name text — no CRM re-fetch needed. Safe to re-run any time crm_username
 * data changes on the employee roster.
 *
 * Fetches every currently-unmapped row FIRST (fixed offsets), then applies all updates
 * afterward — updating rows while paginating the same WHERE clause the updates narrow would
 * shift offsets mid-scan and silently skip rows.
 */
export async function remapUnmatchedHrIds(): Promise<{ agentFixed: number; checked: number; doubleFixed: number }> {
  const supabase = getSupabaseAdmin();
  const [employees, resolutions] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    getCrmIdentityResolutions(),
  ]);
  const maps = buildCrmIdentityMaps(employees, resolutions);

  type UnmappedRow = {
    agent_crm_id: number;
    agent_hr_id: string | null;
    agent_name: string | null;
    double_crm_id: number | null;
    double_hr_id: string | null;
    double_name: string | null;
    id: string;
  };
  const pageSize = 1000;
  const allRows: UnmappedRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(visitsTable)
      .select("id, agent_crm_id, agent_hr_id, agent_name, double_crm_id, double_hr_id, double_name")
      .or("agent_hr_id.is.null,double_hr_id.is.null")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as UnmappedRow[];
    allRows.push(...page);
    if (page.length < pageSize) break;
  }

  let agentFixed = 0;
  let doubleFixed = 0;
  for (const row of allRows) {
    const patch: { agent_hr_id?: string; double_hr_id?: string } = {};
    if (!row.agent_hr_id) {
      const resolved = resolveEmployeeHrId(row.agent_crm_id, row.agent_name, maps);
      if (resolved) {
        patch.agent_hr_id = resolved;
        agentFixed += 1;
      }
    }
    if (row.double_crm_id != null && !row.double_hr_id) {
      const resolved = resolveEmployeeHrId(row.double_crm_id, row.double_name, maps);
      if (resolved) {
        patch.double_hr_id = resolved;
        doubleFixed += 1;
      }
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from(visitsTable).update(patch).eq("id", row.id);
      if (error) throw new Error(error.message);
    }
  }

  return { agentFixed, checked: allRows.length, doubleFixed };
}

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
  if (visitDate > existing.lastSeen) existing.lastSeen = visitDate;
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
  const resignedCrmIds = new Set(resolutions.filter((r) => r.status === "resigned").map((r) => r.crmId));

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
      if (schemaMissing(error)) return [];
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
    const { count: agentCount, error: agentError } = await supabase
      .from(visitsTable)
      .update({ agent_hr_id: resolvedHrId, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("agent_crm_id", input.crmId)
      .is("agent_hr_id", null);
    if (agentError) throw new Error(agentError.message);
    updatedVisits += agentCount ?? 0;

    const { count: doubleCount, error: doubleError } = await supabase
      .from(visitsTable)
      .update({ double_hr_id: resolvedHrId, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("double_crm_id", input.crmId)
      .is("double_hr_id", null);
    if (doubleError) throw new Error(doubleError.message);
    updatedVisits += doubleCount ?? 0;
  }

  return { resolvedEmployeeHrId: resolvedHrId, resolvedEmployeeName: resolvedName, updatedVisits };
}

function mapSyncRun(row: Record<string, unknown>): VisitsSyncRun {
  return {
    completedAt: (row.completed_at as string | null) ?? null,
    dateFrom: row.date_from as string,
    dateTo: row.date_to as string,
    errorMessage: (row.error_message as string | null) ?? null,
    id: row.id as string,
    rowsFetched: Number(row.rows_fetched ?? 0),
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
    if (schemaMissing(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Record<string, unknown>[]).map(mapSyncRun);
}

function mapVisitRow(row: Record<string, unknown>): VisitsReportRow {
  return {
    agentCrmId: Number(row.agent_crm_id),
    agentHrId: (row.agent_hr_id as string | null) ?? null,
    agentName: (row.agent_name as string | null) ?? null,
    ampm: (row.ampm as string | null) ?? null,
    callType: row.call_type == null ? null : Number(row.call_type),
    comment: (row.comment as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    crmSaveDate: (row.crm_save_date as string | null) ?? null,
    crmVisitId: Number(row.crm_visit_id),
    customerName: (row.customer_name as string | null) ?? null,
    doubleCrmId: row.double_crm_id == null ? null : Number(row.double_crm_id),
    doubleHrId: (row.double_hr_id as string | null) ?? null,
    doubleName: (row.double_name as string | null) ?? null,
    id: row.id as string,
    nearestCheckinAddress: null,
    nearestCheckinTime: null,
    visitDate: row.visit_date as string,
    visitDateTime: (row.visit_date_time as string | null) ?? null,
    visitType: row.visit_type == null ? null : Number(row.visit_type),
    visitTypeDescription: (row.visit_type_description as string | null) ?? null,
  };
}

/** Applies the shared filter set (date range, agent, search, visit type, AM/PM, mapping
 * status) to a base ireports360_visits query — used identically by the paginated report view
 * and the unpaginated export, so the two can never silently disagree on what "matches". */
/* eslint-disable @typescript-eslint/no-explicit-any -- structural shape only, needs to accept
   Supabase's actual (much more specific) PostgrestFilterBuilder method signatures. */
type FilterableQuery = {
  eq: (...args: any[]) => FilterableQuery;
  gte: (...args: any[]) => FilterableQuery;
  ilike: (...args: any[]) => FilterableQuery;
  is: (...args: any[]) => FilterableQuery;
  lte: (...args: any[]) => FilterableQuery;
  not: (...args: any[]) => FilterableQuery;
  or: (...args: any[]) => FilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Not generic over Supabase's real PostgrestFilterBuilder type on purpose — that type is deep
// enough that TS gives up trying to instantiate it through a wrapper ("Type instantiation is
// excessively deep"). Callers pass their concrete query in as FilterableQuery and cast the
// result back (see call sites) to keep chaining .order()/.range() with full typing there.
function applyVisitsFilters(
  query: FilterableQuery,
  filters: VisitsReportFilterInput & { dateFrom: string; dateTo: string },
): FilterableQuery {
  let result: FilterableQuery = query.gte("visit_date", filters.dateFrom).lte("visit_date", filters.dateTo);
  if (filters.agentName) result = result.eq("agent_name", filters.agentName);
  if (filters.ampm) result = result.eq("ampm", filters.ampm);
  if (filters.visitType) result = result.eq("visit_type_description", filters.visitType);
  const term = filters.search?.trim();
  if (term) {
    const escaped = term.replace(/[%,()]/g, " ").trim();
    if (escaped) {
      result = result.or(
        `agent_name.ilike.%${escaped}%,double_name.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,comment.ilike.%${escaped}%`,
      );
    }
  }
  if (filters.mappingStatus === "agent_unmapped") result = result.is("agent_hr_id", null);
  else if (filters.mappingStatus === "double_unmapped") result = result.is("double_hr_id", null);
  else if (filters.mappingStatus === "either_unmapped") result = result.or("agent_hr_id.is.null,double_hr_id.is.null");
  else if (filters.mappingStatus === "fully_mapped") {
    result = result.not("agent_hr_id", "is", null).or("double_crm_id.is.null,double_hr_id.not.is.null");
  }
  return result;
}

/**
 * Best-effort GPS check-in correlation: batch-fetches check-ins for exactly the distinct
 * agent_crm_ids present in `rows` over [dateFrom, dateTo], then attaches to each visit the
 * check-in closest in time (by visitDateTime, falling back to the earliest same-day check-in
 * when no time is available) from that same agent + same calendar day. Never a guaranteed
 * exact match — the vendor's own data model has no shared key between visits and check-ins.
 */
async function attachNearestCheckins(rows: VisitsReportRow[], dateFrom: string, dateTo: string): Promise<VisitsReportRow[]> {
  if (rows.length === 0) return rows;
  const agentIds = Array.from(new Set(rows.map((row) => row.agentCrmId)));
  const supabase = getSupabaseAdmin();
  const { data: checkinRows } = await supabase
    .from(checkinsTable)
    .select("agent_crm_id, check_date, address")
    .in("agent_crm_id", agentIds)
    .gte("check_date", `${dateFrom}T00:00:00`)
    .lte("check_date", `${dateTo}T23:59:59`)
    .limit(5000);

  const byAgentDay = new Map<string, Array<{ address: string | null; checkDate: string }>>();
  for (const checkin of (checkinRows ?? []) as Array<{ address: string | null; agent_crm_id: number; check_date: string }>) {
    const day = checkin.check_date.slice(0, 10);
    const key = `${checkin.agent_crm_id}:${day}`;
    byAgentDay.set(key, [...(byAgentDay.get(key) ?? []), { address: checkin.address, checkDate: checkin.check_date }]);
  }

  return rows.map((row) => {
    const key = `${row.agentCrmId}:${row.visitDate}`;
    const candidates = byAgentDay.get(key);
    if (!candidates || candidates.length === 0) return row;
    const anchor = row.visitDateTime ? new Date(row.visitDateTime).getTime() : null;
    let nearest = candidates[0];
    if (anchor != null) {
      let bestDiff = Infinity;
      for (const candidate of candidates) {
        const diff = Math.abs(new Date(candidate.checkDate).getTime() - anchor);
        if (diff < bestDiff) {
          bestDiff = diff;
          nearest = candidate;
        }
      }
    }
    return { ...row, nearestCheckinAddress: nearest.address, nearestCheckinTime: nearest.checkDate };
  });
}

/**
 * Every distinct agent_name in [dateFrom, dateTo] — feeds the Agent filter dropdown. Paginates
 * by keyset (`id > cursor`), not a flat `.limit()`: a typical date range has far more rows than
 * any reasonable single-request cap, and a flat limit would silently sample an arbitrary subset
 * of rows rather than actually covering every distinct name (confirmed in practice — an agent
 * with 400+ visits across a 4-month range was simply absent from the dropdown because none of
 * their rows landed in the first 5000 scanned). Cardinality of distinct names is small (low
 * hundreds), so this is a bounded, one-pass scan of the row set, not the results.
 */
async function getDistinctAgentNames(dateFrom: string, dateTo: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const names = new Set<string>();
  const pageSize = 2000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select("id, agent_name")
      .gte("visit_date", dateFrom)
      .lte("visit_date", dateTo)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ agent_name: string | null; id: string }>;
    for (const row of page) {
      if (row.agent_name) names.add(row.agent_name);
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(names).sort();
}

async function getDistinctVisitTypes(dateFrom: string, dateTo: string): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from(visitsTable)
    .select("visit_type_description")
    .gte("visit_date", dateFrom)
    .lte("visit_date", dateTo)
    .limit(5000);
  return Array.from(
    new Set(((data ?? []) as Array<{ visit_type_description: string | null }>).map((row) => row.visit_type_description).filter((value): value is string => Boolean(value))),
  ).sort();
}

export async function getVisitsReportData(
  input: VisitsReportFilterInput & { page?: number; pageSize?: number },
): Promise<VisitsReportData> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -30);
  const dateTo = input.dateTo || today;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, input.pageSize ?? 100));
  const configured = isIReports360Configured();

  if (!(await isSchemaReady())) {
    return {
      configured,
      dateFrom,
      dateTo,
      filters: { agents: [], visitTypes: [] },
      latestSyncRuns: [],
      page,
      pageSize,
      rows: [],
      schemaReady: false,
      totalCount: 0,
    };
  }

  const supabase = getSupabaseAdmin();
  const baseQuery = supabase.from(visitsTable).select("*", { count: "exact" });
  const filteredQuery = (applyVisitsFilters(baseQuery as unknown as FilterableQuery, { ...input, dateFrom, dateTo }) as unknown as typeof baseQuery)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, latestSyncRuns, agents, visitTypes] = await Promise.all([
    filteredQuery,
    getLatestVisitsSyncRuns(10),
    getDistinctAgentNames(dateFrom, dateTo),
    getDistinctVisitTypes(dateFrom, dateTo),
  ]);
  if (error) throw new Error(error.message);

  const rawRows = ((data ?? []) as Record<string, unknown>[]).map(mapVisitRow);
  const rows = await attachNearestCheckins(rawRows, dateFrom, dateTo);

  return {
    configured,
    dateFrom,
    dateTo,
    filters: { agents, visitTypes },
    latestSyncRuns,
    page,
    pageSize,
    rows,
    schemaReady: true,
    totalCount: count ?? rows.length,
  };
}

/** Same filter logic as getVisitsReportData but unpaginated, capped at MAX_EXPORT_ROWS —
 * never silently drops data past the cap without saying so via `truncated`. */
export async function getVisitsReportExportRows(input: VisitsReportFilterInput): Promise<VisitsReportExportResult> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -30);
  const dateTo = input.dateTo || today;

  if (!(await isSchemaReady())) {
    return { rows: [], totalCount: 0, truncated: false };
  }

  const supabase = getSupabaseAdmin();
  const baseQuery = supabase.from(visitsTable).select("*", { count: "exact" });
  const filteredQuery = (applyVisitsFilters(baseQuery as unknown as FilterableQuery, { ...input, dateFrom, dateTo }) as unknown as typeof baseQuery)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);

  const { data, error, count } = await filteredQuery;
  if (error) throw new Error(error.message);

  const rawRows = ((data ?? []) as Record<string, unknown>[]).map(mapVisitRow);
  const rows = await attachNearestCheckins(rawRows, dateFrom, dateTo);
  const totalCount = count ?? rows.length;

  return { rows, totalCount, truncated: totalCount > rows.length };
}
