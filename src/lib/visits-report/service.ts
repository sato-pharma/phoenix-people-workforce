import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { iReports360GetVisits, iReports360Login, type IReports360Visit } from "@/lib/field-workforce-compliance/ireports360-client";
import { getIReports360Config, isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { VisitsReportData, VisitsReportRow, VisitsSyncRun, VisitsSyncTrigger } from "@/lib/visits-report/types";

const visitsTable = "ireports360_visits";
const syncRunsTable = "ireports360_visits_sync_runs";
const upsertBatchSize = 500;

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
  return /ireports360_visits|schema cache|does not exist|PGRST205|42P01/i.test(message);
}

async function isSchemaReady() {
  const { error } = await getSupabaseAdmin().from(visitsTable).select("id", { count: "exact", head: true }).limit(1);
  return !schemaMissing(error);
}

function rowFromVisit(visit: IReports360Visit, hrIdByCrmId: Map<string, string>) {
  const doubleCrmId = visit.doubleID && visit.doubleID !== 0 ? visit.doubleID : null;
  return {
    agent_crm_id: visit.agentID,
    agent_hr_id: hrIdByCrmId.get(String(visit.agentID)) ?? null,
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
    double_hr_id: doubleCrmId ? (hrIdByCrmId.get(String(doubleCrmId)) ?? null) : null,
    double_name: visit.doubleName,
    raw_payload: visit as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    visit_date: visit.visitDate.slice(0, 10),
    visit_type: visit.visitType,
    visit_type_description: visit.visitTypeDescription,
  };
}

/**
 * Pulls every visit iReports360 recorded in [dateFrom, dateTo] and upserts it into
 * ireports360_visits, keyed on the CRM's own crm_visit_id — re-running over an overlapping
 * range (which the recurring cron does deliberately, to catch late CRM edits) is safe and
 * idempotent. Logs a row in ireports360_visits_sync_runs for every attempt, success or failure,
 * so sync freshness is visible instead of silent.
 */
export async function syncIReports360Visits(input: {
  dateFrom: string;
  dateTo: string;
  trigger: VisitsSyncTrigger;
}): Promise<{ rowsFetched: number; rowsUpserted: number; runId: string }> {
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
    const visits = await iReports360GetVisits(config, token, input.dateFrom, input.dateTo);

    const employees = await getEmployeeDirectoryRows({ includeInactive: true });
    const hrIdByCrmId = new Map(
      employees
        .filter((employee): employee is typeof employee & { crmId: string } => Boolean(employee.crmId))
        .map((employee) => [employee.crmId, employee.hrId] as const),
    );

    const rows = visits.map((visit) => rowFromVisit(visit, hrIdByCrmId));
    let upserted = 0;
    for (let index = 0; index < rows.length; index += upsertBatchSize) {
      const chunk = rows.slice(index, index + upsertBatchSize);
      const { error } = await supabase.from(visitsTable).upsert(chunk, { onConflict: "crm_visit_id" });
      if (error) throw new Error(error.message);
      upserted += chunk.length;
    }

    await supabase
      .from(syncRunsTable)
      .update({ completed_at: new Date().toISOString(), rows_fetched: visits.length, rows_upserted: upserted, status: "success" })
      .eq("id", runId);
    return { rowsFetched: visits.length, rowsUpserted: upserted, runId };
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
    visitDate: row.visit_date as string,
    visitType: row.visit_type == null ? null : Number(row.visit_type),
    visitTypeDescription: (row.visit_type_description as string | null) ?? null,
  };
}

export async function getVisitsReportData(input: {
  agentHrId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<VisitsReportData> {
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
      filters: { agents: [] },
      latestSyncRuns: [],
      page,
      pageSize,
      rows: [],
      schemaReady: false,
      totalCount: 0,
    };
  }

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from(visitsTable)
    .select("*", { count: "exact" })
    .gte("visit_date", dateFrom)
    .lte("visit_date", dateTo)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (input.agentHrId) {
    query = query.eq("agent_hr_id", input.agentHrId.toUpperCase());
  }

  const [{ data, error, count }, latestSyncRuns] = await Promise.all([query, getLatestVisitsSyncRuns(10)]);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapVisitRow);

  const { data: agentRows } = await supabase
    .from(visitsTable)
    .select("agent_name")
    .gte("visit_date", dateFrom)
    .lte("visit_date", dateTo)
    .limit(5000);
  const agents = Array.from(
    new Set(((agentRows ?? []) as Array<{ agent_name: string | null }>).map((row) => row.agent_name).filter((value): value is string => Boolean(value))),
  ).sort();

  return {
    configured,
    dateFrom,
    dateTo,
    filters: { agents },
    latestSyncRuns,
    page,
    pageSize,
    rows,
    schemaReady: true,
    totalCount: count ?? rows.length,
  };
}
