/**
 * Clearance & offboarding domain service — HR Operations job description §6.
 *
 * Two rules shape everything here.
 *
 * 1. **The gate lives in the database, not in this file.** `phx_hr_clearance_release` refuses to
 *    record a settlement release while any station is still pending or blocked, and names the
 *    stations in the exception. A gate implemented in a page can be bypassed by the next page;
 *    a gate implemented in plpgsql cannot. This service calls the function and surfaces its
 *    message — it never re-implements the decision.
 * 2. **Nothing here writes payroll.** Recording that a settlement was released is a statement
 *    that HR handed it over, not an instruction to pay. "May not approve final settlement" is a
 *    named boundary in the same job description, enforced by HR_ROLE_BOUNDARIES' payroll entries.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  ClearanceAwaitingResignation,
  ClearanceChecklist,
  ClearanceChecklistStatus,
  ClearanceDashboardData,
  ClearanceItem,
  ClearanceItemStatus,
  ClearanceStats,
  DecideClearanceItemInput,
  ReleaseClearanceInput,
} from "./types";

const clearanceItemStatuses: ClearanceItemStatus[] = ["pending", "cleared", "blocked", "waived"];

type StationRow = {
  station_key: string;
  label: string;
  description: string | null;
  responsible: string | null;
  sort_order: number;
};

type ItemRow = {
  id: string;
  checklist_id: string;
  station_key: string;
  station_label: string;
  sort_order: number;
  status: ClearanceItemStatus;
  reason: string | null;
  amount_due: number | string | null;
  evidence_note: string | null;
  decided_at: string | null;
  decided_by: string | null;
};

type ChecklistRow = {
  id: string;
  resignation_id: string;
  employee_hr_id: string;
  employee_name: string;
  job_title: string | null;
  line_name: string | null;
  last_working_date: string | null;
  status: ClearanceChecklistStatus;
  opened_at: string;
  opened_by: string | null;
  ready_at: string | null;
  settlement_released_at: string | null;
  settlement_released_by: string | null;
  settlement_note: string | null;
  notes: string | null;
};

/**
 * True when the clearance tables have not reached this environment. Distinguished from a real
 * failure so a preview branch renders an honest "not ready yet" instead of a misleading zero —
 * the rule AGENTS.md §7 states for an unavailable data source.
 */
export function isClearanceSchemaMissing(error: unknown): boolean {
  const message = clearanceErrorMessage(error).toLowerCase();
  return (
    message.includes("hr_clearance_") &&
    (message.includes("does not exist") ||
      message.includes("could not find") ||
      message.includes("schema cache") ||
      message.includes("relation"))
  );
}

export function clearanceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "Clearance request failed.");
  }
  return "Clearance request failed.";
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whole days between two ISO calendar dates. Cairo sits a whole number of hours from UTC, so
 * reading both as UTC midnights gives the exact calendar difference without a timezone library.
 */
function daysBetweenDateOnly(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

async function resolveNames(hrIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(hrIds.map((id) => id.trim()).filter(Boolean))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;

  const supabase = getSupabaseAdmin();
  // Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns zero rows and no
  // error, because the filter travels in the URL. See AGENTS.md §2.1.
  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50);
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname")
      .in("hr_id", chunk);
    if (error) {
      // A missing display name must never fail the page — the ids still render.
      logError("Clearance could not resolve actor names", {
        labels: { event: "clearance_name_resolution_failed" },
        context: { requested: chunk.length },
        error,
      });
      continue;
    }
    for (const row of (data ?? []) as { hr_id: string; full_name: string; nickname: string | null }[]) {
      names.set(row.hr_id, resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id));
    }
  }
  return names;
}

function buildChecklist(
  row: ChecklistRow,
  itemRows: ItemRow[],
  names: Map<string, string>,
  today: string,
): ClearanceChecklist {
  const items: ClearanceItem[] = itemRows
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.station_label.localeCompare(b.station_label))
    .map((item) => ({
      id: item.id,
      stationKey: item.station_key,
      stationLabel: item.station_label,
      sortOrder: item.sort_order,
      status: item.status,
      reason: item.reason,
      amountDue: toNumber(item.amount_due),
      evidenceNote: item.evidence_note,
      decidedAt: item.decided_at,
      decidedBy: item.decided_by,
      decidedByName: item.decided_by ? (names.get(item.decided_by) ?? null) : null,
    }));

  // The same predicate the release gate uses, so the page's "still outstanding" list and the
  // database's refusal can never disagree.
  const outstanding = items.filter((item) => item.status === "pending" || item.status === "blocked");
  const daysSince = row.last_working_date ? daysBetweenDateOnly(row.last_working_date, today) : null;

  return {
    id: row.id,
    resignationId: row.resignation_id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    jobTitle: row.job_title,
    lineName: row.line_name,
    lastWorkingDate: row.last_working_date,
    status: row.status,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    readyAt: row.ready_at,
    settlementReleasedAt: row.settlement_released_at,
    settlementReleasedBy: row.settlement_released_by,
    settlementReleasedByName: row.settlement_released_by
      ? (names.get(row.settlement_released_by) ?? null)
      : null,
    settlementNote: row.settlement_note,
    notes: row.notes,
    items,
    outstandingLabels: outstanding.map((item) => item.stationLabel),
    clearedCount: items.filter((item) => item.status === "cleared" || item.status === "waived").length,
    totalCount: items.length,
    amountOutstanding: items.reduce(
      (total, item) => total + (item.status === "blocked" ? (item.amountDue ?? 0) : 0),
      0,
    ),
    isOverdue:
      (row.status === "open" || row.status === "ready") && daysSince !== null && daysSince > 0,
    daysSinceLastWorkingDate: daysSince,
  };
}

function buildStats(checklists: ClearanceChecklist[]): ClearanceStats {
  return {
    open: checklists.filter((c) => c.status === "open").length,
    ready: checklists.filter((c) => c.status === "ready").length,
    released: checklists.filter((c) => c.status === "released").length,
    cancelled: checklists.filter((c) => c.status === "cancelled").length,
    overdue: checklists.filter((c) => c.isOverdue).length,
    blockedStations: checklists.reduce(
      (total, c) => total + c.items.filter((item) => item.status === "blocked").length,
      0,
    ),
    amountOutstanding: checklists.reduce((total, c) => total + c.amountOutstanding, 0),
  };
}

/**
 * Resignations that have no clearance checklist, most recent last working date first.
 *
 * Windowed to the last 45 days plus everything still upcoming. The whole table is only 54 rows, so
 * the window is not about volume - it is that opening a clearance for someone who left in April is
 * not a workflow anyone has, and listing them would bury the two or three that matter. Anything
 * older stays reachable through the API, which takes any resignation id.
 */
async function loadAwaitingResignations(
  withChecklists: (string | null)[],
): Promise<ClearanceAwaitingResignation[]> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("id,employee_hr_id,employee_name,job_title,line_name,last_working_date")
    .gte("last_working_date", cutoff)
    .order("last_working_date", { ascending: false });

  // Never fatal. This list is an assist; a checklist that already exists is the real work, and a
  // failure here must not take the whole page down with it.
  if (error) return [];

  // Filtered in JS rather than with a NOT IN, because the excluded set is the checklists we just
  // read - a second query could disagree with the first, and this table is 54 rows.
  const taken = new Set(withChecklists.filter((value): value is string => Boolean(value)));
  return ((data ?? []) as {
    id: string;
    employee_hr_id: string;
    employee_name: string | null;
    job_title: string | null;
    line_name: string | null;
    last_working_date: string | null;
  }[])
    .filter((row) => !taken.has(row.id))
    .map((row) => ({
      resignationId: row.id,
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name ?? row.employee_hr_id,
      jobTitle: row.job_title,
      lineName: row.line_name,
      lastWorkingDate: row.last_working_date,
    }));
}

export async function getClearanceDashboardData(
  _access: AccessContext,
): Promise<ClearanceDashboardData> {
  const supabase = getSupabaseAdmin();
  const today = currentCairoDateOnlyIso();

  const [stationsResult, checklistsResult] = await Promise.all([
    supabase
      .from("hr_clearance_stations")
      .select("station_key,label,description,responsible,sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("hr_clearance_checklists")
      .select(
        "id,resignation_id,employee_hr_id,employee_name,job_title,line_name,last_working_date,status,opened_at,opened_by,ready_at,settlement_released_at,settlement_released_by,settlement_note,notes",
      )
      .order("last_working_date", { ascending: false, nullsFirst: false })
      .order("opened_at", { ascending: false }),
  ]);

  if (stationsResult.error) {
    if (isClearanceSchemaMissing(stationsResult.error)) {
      return { checklists: [], stations: [], stats: buildStats([]), awaiting: [], schemaReady: false };
    }
    throw new Error(clearanceErrorMessage(stationsResult.error));
  }
  if (checklistsResult.error) {
    if (isClearanceSchemaMissing(checklistsResult.error)) {
      return { checklists: [], stations: [], stats: buildStats([]), awaiting: [], schemaReady: false };
    }
    throw new Error(clearanceErrorMessage(checklistsResult.error));
  }

  const checklistRows = (checklistsResult.data ?? []) as ChecklistRow[];
  const itemsByChecklist = new Map<string, ItemRow[]>();

  // Chunked for the same PostgREST reason as resolveNames.
  for (let index = 0; index < checklistRows.length; index += 50) {
    const ids = checklistRows.slice(index, index + 50).map((row) => row.id);
    const { data, error } = await supabase
      .from("hr_clearance_items")
      .select(
        "id,checklist_id,station_key,station_label,sort_order,status,reason,amount_due,evidence_note,decided_at,decided_by",
      )
      .in("checklist_id", ids);
    if (error) throw new Error(clearanceErrorMessage(error));
    for (const item of (data ?? []) as ItemRow[]) {
      const bucket = itemsByChecklist.get(item.checklist_id);
      if (bucket) bucket.push(item);
      else itemsByChecklist.set(item.checklist_id, [item]);
    }
  }

  const actorIds = [
    ...checklistRows.flatMap((row) => [row.opened_by, row.settlement_released_by]),
    ...[...itemsByChecklist.values()].flat().map((item) => item.decided_by),
  ].filter((value): value is string => Boolean(value));
  const names = await resolveNames(actorIds);

  const checklists = checklistRows.map((row) =>
    buildChecklist(row, itemsByChecklist.get(row.id) ?? [], names, today),
  );

  return {
    checklists,
    awaiting: await loadAwaitingResignations(checklistRows.map((row) => row.resignation_id)),
    stations: ((stationsResult.data ?? []) as StationRow[]).map((row) => ({
      stationKey: row.station_key,
      label: row.label,
      description: row.description,
      responsible: row.responsible,
      sortOrder: row.sort_order,
    })),
    stats: buildStats(checklists),
    schemaReady: true,
  };
}

/**
 * Open a checklist for a resignation by hand. Normally the AFTER INSERT trigger has already done
 * it; this exists for resignations recorded before the trigger existed, and for a departure whose
 * trigger attempt failed — that path is deliberately best-effort, because a checklist must never
 * be the reason a resignation fails to record.
 */
export async function openClearanceChecklist(resignationId: string, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_hr_clearance_open", {
    p_resignation_id: resignationId,
    p_actor: actor,
  });
  if (error) throw new Error(clearanceErrorMessage(error));

  const checklistId = typeof data === "string" ? data : String(data ?? "");
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "hr_clearance_decision",
    entityId: checklistId || resignationId,
    summary: `Opened a clearance checklist for resignation ${resignationId}`,
    newValues: { resignationId, checklistId },
  });
  return checklistId;
}

export async function decideClearanceItem(
  input: DecideClearanceItemInput,
  actor: string,
): Promise<void> {
  if (!clearanceItemStatuses.includes(input.status)) {
    throw new Error(`Unknown clearance status "${input.status}".`);
  }
  const reason = input.reason?.trim() ?? "";
  // Checked here as well as in the CHECK constraint, so a mistake reads as a sentence rather than
  // a constraint violation. The database stays the authority — this is presentation, not the gate.
  if ((input.status === "blocked" || input.status === "waived") && reason === "") {
    throw new Error(`A ${input.status} decision needs a written reason.`);
  }

  const supabase = getSupabaseAdmin();
  const { data: before } = await supabase
    .from("hr_clearance_items")
    .select("checklist_id,station_label,status,reason,amount_due")
    .eq("id", input.itemId)
    .maybeSingle();

  const { error } = await supabase.rpc("phx_hr_clearance_decide", {
    p_item_id: input.itemId,
    p_status: input.status,
    p_actor: actor,
    p_reason: reason === "" ? null : reason,
    p_evidence_note: input.evidenceNote?.trim() || null,
    p_amount_due: input.status === "blocked" ? (input.amountDue ?? null) : null,
  });
  if (error) throw new Error(clearanceErrorMessage(error));

  const station = (before as { station_label?: string } | null)?.station_label ?? "a station";
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "hr_clearance_decision",
    entityId: input.itemId,
    summary: `Marked ${station} as ${input.status}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: {
      status: input.status,
      reason: reason || null,
      amountDue: input.status === "blocked" ? (input.amountDue ?? null) : null,
      evidenceNote: input.evidenceNote?.trim() || null,
    },
  });
}

/**
 * Record that the final settlement was released. The refusal path is the point of this function:
 * `phx_hr_clearance_release` throws, naming the outstanding stations, and that sentence reaches
 * the page unchanged.
 *
 * Audited with `writeRequiredAuditLog` rather than a best-effort writer: this is the row that says
 * a departure was closed out, and a release nobody can attribute is treated as a failed release,
 * not a quiet success.
 */
export async function releaseClearanceSettlement(
  input: ReleaseClearanceInput,
  actor: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: before } = await supabase
    .from("hr_clearance_checklists")
    .select("employee_hr_id,employee_name,status,last_working_date")
    .eq("id", input.checklistId)
    .maybeSingle();

  const { error } = await supabase.rpc("phx_hr_clearance_release", {
    p_checklist_id: input.checklistId,
    p_actor: actor,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(clearanceErrorMessage(error));

  const subject = (before as { employee_name?: string } | null)?.employee_name ?? "an employee";
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "hr_clearance_release",
    entityId: input.checklistId,
    summary: `Recorded the final settlement release for ${subject}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: { status: "released", note: input.note?.trim() || null },
  });
}
