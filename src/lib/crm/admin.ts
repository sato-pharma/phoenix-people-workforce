/**
 * CRM admin/back-office reads + writes: the sync-run history and the unmapped-CRM-identity
 * punch-list + resolver. These power the CRM control center (sync health + "Unmapped Agents").
 * Relocated verbatim from visits-report/service.ts; behavior unchanged.
 */

import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  buildCrmIdentityMaps,
  getCrmIdentityResolutions,
  isAttributableOn,
  isSettledUnmappedRow,
  loadCrmIdentityMaps,
  normalizeCrmName,
} from "@/lib/crm/identity";
import type { CrmMappingEmployeeOption } from "@/lib/crm/mapping-picker";
import { getEffectiveExcludedAgentCrmIds } from "@/lib/crm/reads";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { CRM_IDENTITY_RESOLUTIONS_TABLE, CRM_SYNC_RUNS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
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
  const [resolutions, maps] = await Promise.all([getCrmIdentityResolutions(), loadCrmIdentityMaps()]);
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
      .select("id, agent_crm_id, agent_name, visit_date, visit_type")
      .is("agent_hr_id", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (agentCursor) query = query.gt("id", agentCursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ agent_crm_id: number; agent_name: string | null; id: string; visit_date: string; visit_type: number | null }>;
    for (const row of page) {
      const slot = { crmId: row.agent_crm_id, label: row.agent_name, visitDate: row.visit_date, visitType: row.visit_type };
      if (isSettledUnmappedRow(slot, maps)) continue;
      recordUnmappedIdentity(identities, row.agent_crm_id, row.agent_name, row.visit_date, "agent");
    }
    if (page.length < pageSize) break;
    agentCursor = page[page.length - 1].id;
  }

  let doubleCursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select("id, double_crm_id, double_name, visit_date, visit_type")
      .not("double_crm_id", "is", null)
      .is("double_hr_id", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (doubleCursor) query = query.gt("id", doubleCursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ double_crm_id: number; double_name: string | null; id: string; visit_date: string; visit_type: number | null }>;
    for (const row of page) {
      const slot = { crmId: row.double_crm_id, label: row.double_name, visitDate: row.visit_date, visitType: row.visit_type };
      if (isSettledUnmappedRow(slot, maps)) continue;
      recordUnmappedIdentity(identities, row.double_crm_id, row.double_name, row.visit_date, "double");
    }
    if (page.length < pageSize) break;
    doubleCursor = page[page.length - 1].id;
  }

  return Array.from(identities.values())
    .filter((identity) => !resignedCrmIds.has(identity.crmId))
    .map((identity) => ({ ...identity, roles: Array.from(identity.roles) }))
    .sort((a, b) => b.visitCount - a.visitCount);
}

/**
 * Everyone the Unmapped Agents picker can offer as the holder of a CRM account, leavers included — a
 * handed-over account's history belongs to people who have LEFT, so an active-only list would hide
 * exactly the people that screen exists to map. The dates travel with each name so the admin sees
 * whose employment covers the account before saving; the save still enforces it.
 */
export async function getCrmMappingEmployeeOptions(): Promise<CrmMappingEmployeeOption[]> {
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  return employees
    .map((employee) => ({
      employmentStatus: employee.employmentStatus,
      fullName: employee.fullName,
      hireDate: employee.hireDate?.slice(0, 10) ?? null,
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      lastWorkingDate: employee.lastWorkingDate?.slice(0, 10) ?? null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** One visit row as the pre-hire mapping check reads it: the record's own CRM label and its date. */
export type MappingCandidateRow = { label: string | null; visitDate: string };

/** What a refused mapping would have credited — enough to tell the admin exactly what is wrong. */
export type PreHireMappingConflict = { count: number; earliest: string; latest: string };

/**
 * PRE-HIRE MAPPING GUARD — the pure decision core, split out so it is unit-testable without
 * mocking Supabase (same reasoning as selectIdentitiesToPreserve in sync.ts).
 *
 * IT USED TO REFUSE THE MAPPING; SINCE 2026-09-21 IT ONLY REPORTS. When this was written the
 * resolver's tier 1 and the Map button's stamp both credited a mapped account's whole history, so the
 * only safe answer to a pre-hire conflict was to refuse the save. Both are now tenure-scoped — the
 * resolver refuses a mapped person's out-of-employment rows (identity.ts, tier 1) and the stamp skips
 * them (selectStampableVisitRowIds) — so a mapping can no longer credit a single visit dated before
 * the person joined. The refusal then protected nothing and blocked the real task: a handed-over
 * account could never be mapped to its CURRENT holder at all, and the owner hit that wall on account
 * 1537 twice ("this issue must be permanently resolved"). The count is now returned as a notice
 * instead: the mapping saves, their own visits are credited, and the earlier ones stay unassigned.
 *
 * THE INCIDENT (production, 2026-08-28). Three CRM accounts had been mapped this way — slots 1391,
 * 1399 and 1102 — and between them credited 1,373 visits to people who had not yet joined, the
 * largest being 1,136 real doctor calls filed under a rep who started 170 days after the earliest
 * of them. Each was an account handed over from a leaver, which iReports360 relabels to the new
 * holder, so the screen showed the new person's own name against every one of those rows and there
 * was nothing on it to suggest the mapping was wrong.
 *
 * LABEL SCOPING MIRRORS THE RESOLVER, NOT THE STAMP. The two differ on one case: tier 1 credits a
 * row that carries NO label at all (`!recordLabel`), while stampUnmappedVisitRows requires an exact
 * label match and skips it. This counts the resolver's superset, because a refusal must cover every
 * row the mapping would eventually credit — not merely the ones stamped the moment it is saved.
 *
 * A missing hire date never refuses anything: an unknown start is not evidence, exactly as
 * isAttributableOn treats it.
 */
export function findPreHireMappingConflict(
  rows: readonly MappingCandidateRow[],
  input: { decisionLabel: string | null; hireDate: string | null },
): PreHireMappingConflict | null {
  if (!input.hireDate) return null;
  const hireDay = input.hireDate.slice(0, 10);

  let count = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const row of rows) {
    const day = row.visitDate?.slice(0, 10);
    if (!day || day >= hireDay) continue;
    // Same three-way test as the resolver's tier 1: a decision with no label applies to the whole
    // slot, and a row with no label of its own is claimed by whatever the slot is mapped to.
    const rowLabel = normalizeCrmName(row.label);
    if (input.decisionLabel && rowLabel && rowLabel !== input.decisionLabel) continue;
    count += 1;
    if (!earliest || day < earliest) earliest = day;
    if (!latest || day > latest) latest = day;
  }

  if (count === 0 || !earliest || !latest) return null;
  return { count, earliest, latest };
}

/** One unmapped visit row as the Map button's stamp reads it. */
export type StampCandidateRow = { id: string; label: string | null; visitDate: string | null };

/**
 * Which unmapped rows the Map button may stamp with the chosen person — the pure core of
 * stampUnmappedVisitRows, split out so it is unit-testable without Supabase.
 *
 * TWO FILTERS, BOTH REQUIRED. The label filter (above) keeps a decision off rows carrying a
 * different person's name. The TENURE filter keeps it off rows dated outside the chosen person's
 * own employment, using the exact test the sync's resolver applies (isAttributableOn): nothing
 * before the hire date, and nothing after the last working day unless the row still carries that
 * person's own CRM label (their trailing work logged late).
 *
 * The label filter alone is not enough, because iReports360 rewrites a handed-over account's WHOLE
 * history to the current holder's name. Slot 1399 (Tanta / A), production 2026-09-21: every row from
 * January to September read "Ahmed.Farag ( Tanta / A )", but it was held by three people in turn —
 * Jan 1..Jun 28 by a rep who left on Jun 28, Aug 2..6 by a rep who lasted four days, and from Sep 6
 * by the current holder. The save-time pre-hire guard refused mapping it to the current holder, but
 * mapping it to the FIRST holder passed that guard (nothing predated her hire) and would have stamped
 * the second holder's August calls onto her, seven weeks after she left. The resolver would never
 * have produced that attribution; only this blanket stamp could.
 *
 * Rows the filter skips stay unmapped, which is honest and recoverable — they remain on the
 * Unmapped Agents list for their own decision.
 */
export function selectStampableVisitRowIds(
  rows: readonly StampCandidateRow[],
  input: { decisionLabel: string | null; employee: EmployeeDirectoryRow },
): string[] {
  const maps = buildCrmIdentityMaps([input.employee]);
  const hrId = input.employee.hrId;
  const ids: string[] = [];
  for (const row of rows) {
    if (input.decisionLabel && normalizeCrmName(row.label) !== input.decisionLabel) continue;
    if (!isAttributableOn(hrId, row.visitDate, maps, row.label)) continue;
    ids.push(row.id);
  }
  return ids;
}

/** The sentence the admin sees after the save. Written as prose naming the person and the dates,
 *  because the account shows one name across its whole history and a bare count would read as a
 *  bug in the tool. */
export function preHireMappingNotice(input: {
  conflict: PreHireMappingConflict;
  employeeName: string;
  hireDate: string;
}): string {
  const { count, earliest, latest } = input.conflict;
  const visits = count === 1 ? "1 visit" : `${count} visits`;
  const dates = earliest === latest ? `dated ${earliest}` : `dated between ${earliest} and ${latest}`;
  return (
    `${input.employeeName} joined on ${input.hireDate.slice(0, 10)}, so ${visits} on this account ` +
    `${dates} — before that date — were left unassigned; only their own visits were credited. ` +
    `This is what a handed-over CRM account looks like: iReports360 rewrites the previous holder's ` +
    `rows with the new holder's name. If the hiring date is wrong, correct it on the employee ` +
    `record and map the account again.`
  );
}

/**
 * Every visit row on one CRM account dated before `hireDate`, in the shape the pure check above
 * reads. The date filter is pushed into SQL (it removes almost everything); the label test stays in
 * JS because the vendor emits the same label with inconsistent internal whitespace, so a SQL
 * equality filter would silently skip real rows — the same reason stampUnmappedVisitRows pages.
 *
 * Both roles are read: a mapping resolves the agent AND the double-visit partner, so a refusal that
 * only looked at agent_crm_id would wave through the identical mistake made on a double visit.
 */
async function loadPreHireMappingCandidates(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: { crmId: number; hireDate: string },
): Promise<MappingCandidateRow[]> {
  const rows: MappingCandidateRow[] = [];
  const columns = [
    { idColumn: "agent_crm_id", nameColumn: "agent_name" },
    { idColumn: "double_crm_id", nameColumn: "double_name" },
  ] as const;

  for (const { idColumn, nameColumn } of columns) {
    const pageSize = 1000;
    let cursor: string | null = null;
    for (;;) {
      let query = supabase
        .from(visitsTable)
        .select(`id, visit_date, ${nameColumn}`)
        .eq(idColumn, input.crmId)
        .lt("visit_date", input.hireDate.slice(0, 10))
        .order("id", { ascending: true })
        .limit(pageSize);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const page = (data ?? []) as unknown as Array<{ id: string } & Record<string, string | null>>;
      if (page.length === 0) break;
      for (const row of page) rows.push({ label: row[nameColumn], visitDate: String(row.visit_date ?? "") });
      if (page.length < pageSize) break;
      cursor = page[page.length - 1].id;
    }
  }
  return rows;
}

/**
 * Records an admin's decision for one unmapped CRM identity:
 * - "resigned": stores the decision only — the identity drops out of getUnmappedCrmIdentities,
 *   but its ireports360_visits rows stay unmapped forever, on purpose.
 * - "mapped": validates mappedHrId against the real employee roster (by canonical HR ID, not a
 *   raw string compare — casing/symbols vary), stamps it onto every currently-unmapped visit row
 *   for this crm_id dated inside that person's employment immediately, reports any earlier rows it
 *   left unassigned (see findPreHireMappingConflict) (so the Visit Log tab reflects it
 *   right away), and records it so future syncs resolve this identity too (see
 *   resolveEmployeeHrId's manual-override tier).
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
  let resolvedEmployee: EmployeeDirectoryRow | null = null;
  let notice: string | null = null;
  if (input.action === "mapped") {
    const typed = input.mappedHrId?.trim();
    if (!typed) throw new Error("An HR ID is required to map this identity.");
    const employees = await getEmployeeDirectoryRows({ includeInactive: true });
    const key = canonicalHrIdKey(typed);
    const match = employees.find((employee) => canonicalHrIdKey(employee.hrId) === key);
    if (!match) throw new Error(`No employee found with HR ID "${typed}".`);
    resolvedHrId = match.hrId;
    resolvedName = match.fullName;
    resolvedEmployee = match;

    // Counted, never refused — see findPreHireMappingConflict. The resolver and the stamp both skip
    // these rows already; this only tells the admin how many stayed unassigned and why.
    if (match.hireDate) {
      const candidates = await loadPreHireMappingCandidates(supabase, {
        crmId: input.crmId,
        hireDate: match.hireDate,
      });
      const conflict = findPreHireMappingConflict(candidates, {
        decisionLabel: normalizeCrmName(input.crmName),
        hireDate: match.hireDate,
      });
      if (conflict) {
        notice = preHireMappingNotice({ conflict, employeeName: match.fullName, hireDate: match.hireDate });
      }
    }
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
  if (input.action === "mapped" && resolvedEmployee) {
    updatedVisits += await stampUnmappedVisitRows(supabase, {
      crmId: input.crmId,
      crmName: input.crmName ?? null,
      employee: resolvedEmployee,
      idColumn: "agent_crm_id",
      nameColumn: "agent_name",
      targetColumn: "agent_hr_id",
    });
    updatedVisits += await stampUnmappedVisitRows(supabase, {
      crmId: input.crmId,
      crmName: input.crmName ?? null,
      employee: resolvedEmployee,
      idColumn: "double_crm_id",
      nameColumn: "double_name",
      targetColumn: "double_hr_id",
    });
  }

  return { notice, resolvedEmployeeHrId: resolvedHrId, resolvedEmployeeName: resolvedName, updatedVisits };
}

/**
 * Stamps the mapped hr id onto currently-unmapped visit rows for one CRM account — LABEL-SCOPED
 * when the decision recorded the CRM display label it was made against. Production slots 1102,
 * 1395 and 1399 each carry two different people's names across their history (a leaver's rows,
 * then the replacement's), so the old blanket "every null row for this crm_id" stamp would file
 * the previous occupant's work under the new hire. Rows whose label doesn't normalize to the
 * decision's label are left unmapped for their own, separate decision. Without a recorded label
 * (legacy callers) every label on the account is eligible. Name matching happens in JS via
 * normalizeCrmName — the vendor emits the same person's label with inconsistent internal
 * whitespace, so a SQL equality filter would silently skip real rows.
 *
 * TENURE-SCOPED TOO — see selectStampableVisitRowIds.
 */
async function stampUnmappedVisitRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: {
    crmId: number;
    crmName: string | null;
    employee: EmployeeDirectoryRow;
    idColumn: "agent_crm_id" | "double_crm_id";
    nameColumn: "agent_name" | "double_name";
    targetColumn: "agent_hr_id" | "double_hr_id";
  },
): Promise<number> {
  const candidates: StampCandidateRow[] = [];
  const pageSize = 1000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select(`id, visit_date, ${input.nameColumn}`)
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
      candidates.push({ id: row.id, label: row[input.nameColumn] ?? null, visitDate: row.visit_date ?? null });
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }

  const matchingIds = selectStampableVisitRowIds(candidates, {
    decisionLabel: normalizeCrmName(input.crmName),
    employee: input.employee,
  });

  const hrId = input.employee.hrId;
  let updated = 0;
  for (let from = 0; from < matchingIds.length; from += 500) {
    const chunk = matchingIds.slice(from, from + 500);
    const { count, error } = await supabase
      .from(visitsTable)
      .update({ [input.targetColumn]: hrId, updated_at: new Date().toISOString() }, { count: "exact" })
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

/**
 * When was a given day last CHECKED, as opposed to when its newest row happened to change?
 *
 * The compliance board's freshness label used to come from `max(synced_at)` over the day's mirrored
 * rows. That is "when data last moved", not "when we last looked" — so a successful sync that found
 * nothing new left the label frozen and made the Sync button look broken. This reads the run
 * ledger instead: the completed_at of the most recent SUCCESSFUL run whose window covers `dateIso`.
 *
 * Returns null (never throws) when the mirror schema is absent or no run covers the day.
 */
export async function getLatestSuccessfulSyncRunFor(dateIso: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(syncRunsTable)
    .select("completed_at")
    .eq("status", "success")
    .lte("date_from", dateIso)
    .gte("date_to", dateIso)
    .order("completed_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isCrmSchemaMissingError(error)) return null;
    throw new Error(error.message);
  }
  const rows = (data ?? []) as unknown as Array<{ completed_at?: string | null }>;
  return rows[0]?.completed_at ?? null;
}

/**
 * Every sync-run row that started in [`fromIso`, `beforeIso`), oldest first, paged past PostgREST's
 * 1,000-row cap — the System Audit's sync-runs detector reads the whole window, successes included,
 * because a later success is what verifies an earlier failure. Unlike the board reads above, a
 * missing table THROWS: an audit that cannot read its source must say so, never answer "no runs".
 */
export async function listVisitsSyncRunsInWindow<T>(input: {
  columns: string;
  fromIso: string;
  beforeIso: string | null;
  client?: ReturnType<typeof getSupabaseAdmin>;
}): Promise<T[]> {
  const supabase = input.client ?? getSupabaseAdmin({ requestTimeoutMs: 20_000 });
  return fetchAllRows<T>(() => {
    let query = supabase.from(syncRunsTable).select(input.columns).gte("started_at", input.fromIso);
    if (input.beforeIso) query = query.lt("started_at", input.beforeIso);
    return query.order("started_at", { ascending: true });
  }, "id");
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
