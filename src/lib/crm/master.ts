/**
 * CRM Master Data — the raw, exact mirror of iReports360 as pulled into Phoenix.
 *
 * Powers the CRM tab's "master table": every VISIT and every CHECK-IN the CRM sync stored,
 * with ALL columns and each record's full `raw_payload` (every field the CRM returned, even
 * ones without a dedicated column). This is the most literal "look at the actual CRM" view.
 *
 * Read-only and inside the CRM module, so it owns the raw table access directly (the single
 * door). Server-side paginated with an exact count, since the tables hold 90k+ rows.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CHECKINS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError, isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { isIReports360Configured } from "@/lib/crm/config";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import type { VisitsSyncRun } from "@/lib/visits-report/types";

export type CrmMasterDataset = "visits" | "checkins";

/** A displayed column: the raw DB key + a human label + a rendering hint. */
export type CrmMasterColumn = {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "datetime" | "coord";
};

/** Ordered columns shown for the visits dataset (every stored field except raw_payload, which is
 * shown per-row as the full JSON, and the internal uuid `id`). */
export const CRM_VISIT_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "crm_visit_id", kind: "number", label: "CRM Visit ID" },
  { key: "visit_date", kind: "date", label: "Visit Date" },
  { key: "visit_date_time", kind: "datetime", label: "Visit Date-Time" },
  { key: "ampm", kind: "text", label: "AM/PM" },
  { key: "agent_crm_id", kind: "number", label: "Agent CRM ID" },
  { key: "agent_hr_id", kind: "text", label: "Agent HR ID" },
  { key: "agent_name", kind: "text", label: "Agent Name" },
  { key: "double_crm_id", kind: "number", label: "Double CRM ID" },
  { key: "double_hr_id", kind: "text", label: "Double HR ID" },
  { key: "double_name", kind: "text", label: "Double Name" },
  { key: "contact_crm_id", kind: "number", label: "Contact CRM ID" },
  { key: "contact_name", kind: "text", label: "Contact Name" },
  { key: "customer_name", kind: "text", label: "Customer Name" },
  { key: "visit_type", kind: "number", label: "Visit Type" },
  { key: "visit_type_description", kind: "text", label: "Visit Type Description" },
  { key: "call_type", kind: "number", label: "Call Type" },
  { key: "attendance", kind: "number", label: "Attendance" },
  { key: "comment", kind: "text", label: "Comment" },
  { key: "crm_save_date", kind: "datetime", label: "CRM Save Date" },
  { key: "synced_at", kind: "datetime", label: "Synced At" },
];

/** Ordered columns shown for the check-ins dataset. */
export const CRM_CHECKIN_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "crm_checkin_id", kind: "number", label: "CRM Check-in ID" },
  { key: "check_date", kind: "datetime", label: "Check Date" },
  { key: "agent_crm_id", kind: "number", label: "Agent CRM ID" },
  { key: "agent_hr_id", kind: "text", label: "Agent HR ID" },
  { key: "contact_crm_id", kind: "number", label: "Contact CRM ID" },
  { key: "contact_name", kind: "text", label: "Contact Name" },
  { key: "lat", kind: "coord", label: "Latitude" },
  { key: "lon", kind: "coord", label: "Longitude" },
  { key: "address", kind: "text", label: "Address" },
  { key: "synced_at", kind: "datetime", label: "Synced At" },
];

const VISIT_SELECT =
  "id, crm_visit_id, agent_crm_id, agent_hr_id, agent_name, ampm, attendance, call_type, comment, " +
  "contact_crm_id, contact_name, crm_save_date, customer_name, double_crm_id, double_hr_id, double_name, " +
  "visit_date, visit_date_time, visit_type, visit_type_description, synced_at, raw_payload";

const CHECKIN_SELECT =
  "id, crm_checkin_id, agent_crm_id, agent_hr_id, contact_crm_id, contact_name, lat, lon, address, " +
  "check_date, synced_at, raw_payload";

export type CrmMasterRow = Record<string, unknown> & { id: string; raw_payload: Record<string, unknown> | null };

/** Agent-mapping filter (visits): show all, only rows with a resolved agent_hr_id, or only unmapped. */
export type CrmMasterMappingStatus = "all" | "agent_mapped" | "agent_unmapped";

/** AM/PM filter (visits). */
export type CrmMasterAmpm = "all" | "AM" | "PM";

export type CrmMasterData = {
  agentHrId: string | null;
  ampm: CrmMasterAmpm;
  columns: readonly CrmMasterColumn[];
  configured: boolean;
  dataset: CrmMasterDataset;
  dateFrom: string | null;
  dateTo: string | null;
  latestSyncRuns: VisitsSyncRun[];
  mappingStatus: CrmMasterMappingStatus;
  page: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  rows: CrmMasterRow[];
  schemaReady: boolean;
  search: string | null;
  totalCount: number;
  visitType: string | null;
};

export type CrmMasterFilter = {
  agentHrId?: string | null;
  ampm?: CrmMasterAmpm | null;
  dataset?: CrmMasterDataset;
  dateFrom?: string | null;
  dateTo?: string | null;
  mappingStatus?: CrmMasterMappingStatus | null;
  page?: number;
  pageSize?: number;
  search?: string | null;
  visitType?: string | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
export const CRM_MASTER_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

/* eslint-disable @typescript-eslint/no-explicit-any -- structural PostgREST builder (too deep to
   thread through a helper — same pattern as crm/reads.ts). */
type MasterQuery = {
  eq: (...args: any[]) => MasterQuery;
  gte: (...args: any[]) => MasterQuery;
  ilike: (...args: any[]) => MasterQuery;
  is: (...args: any[]) => MasterQuery;
  lte: (...args: any[]) => MasterQuery;
  not: (...args: any[]) => MasterQuery;
  or: (...args: any[]) => MasterQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Escapes a free-text search term for a PostgREST `or(...ilike...)` expression. */
function sanitizeSearch(term: string): string {
  return term.replace(/[%,()]/g, " ").trim();
}

/**
 * Paginated master view of one CRM dataset (visits or check-ins). Returns every stored column
 * plus the full `raw_payload` for each row, ordered newest-first, with an exact total count.
 * Degrades to an empty result (never throws) when the mirror schema isn't present yet.
 */
export async function getCrmMasterData(input: CrmMasterFilter = {}): Promise<CrmMasterData> {
  const dataset: CrmMasterDataset = input.dataset === "checkins" ? "checkins" : "visits";
  const isVisits = dataset === "visits";
  const page = Math.max(1, input.page ?? 1);
  const requested = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = (CRM_MASTER_PAGE_SIZE_OPTIONS as readonly number[]).includes(requested)
    ? requested
    : Math.min(MAX_PAGE_SIZE, Math.max(10, requested));
  const dateFrom = input.dateFrom || null;
  const dateTo = input.dateTo || null;
  const search = input.search?.trim() || null;
  const agentHrId = input.agentHrId?.trim() || null;
  const ampm: CrmMasterAmpm = input.ampm === "AM" || input.ampm === "PM" ? input.ampm : "all";
  const visitType = input.visitType?.trim() || null;
  const mappingStatus: CrmMasterMappingStatus =
    input.mappingStatus === "agent_mapped" || input.mappingStatus === "agent_unmapped" ? input.mappingStatus : "all";
  const configured = isIReports360Configured();

  const columns = dataset === "checkins" ? CRM_CHECKIN_COLUMNS : CRM_VISIT_COLUMNS;

  // Fields echoed back so the UI can seed its filter inputs.
  const echo = {
    agentHrId,
    ampm,
    columns,
    configured,
    dataset,
    dateFrom,
    dateTo,
    mappingStatus,
    page,
    pageSize,
    pageSizeOptions: CRM_MASTER_PAGE_SIZE_OPTIONS,
    search,
    visitType,
  };

  const empty = (schemaReady: boolean): CrmMasterData => ({
    ...echo,
    latestSyncRuns: [],
    rows: [],
    schemaReady,
    totalCount: 0,
  });

  if (!(await isCrmVisitsSchemaReady())) return empty(false);

  const supabase = getSupabaseAdmin();
  const table = dataset === "checkins" ? CRM_CHECKINS_TABLE : CRM_VISITS_TABLE;
  const dateColumn = dataset === "checkins" ? "check_date" : "visit_date";
  const idColumn = dataset === "checkins" ? "crm_checkin_id" : "crm_visit_id";
  const select = dataset === "checkins" ? CHECKIN_SELECT : VISIT_SELECT;

  const base = supabase.from(table).select(select, { count: "exact" });
  let filtered = base as unknown as MasterQuery;
  if (dateFrom) filtered = filtered.gte(dateColumn, dataset === "checkins" ? `${dateFrom}T00:00:00` : dateFrom);
  if (dateTo) filtered = filtered.lte(dateColumn, dataset === "checkins" ? `${dateTo}T23:59:59` : dateTo);
  // Advanced filters. agent_hr_id exists on both tables; the rest are visits-only columns.
  if (agentHrId) {
    const escaped = sanitizeSearch(agentHrId);
    if (escaped) filtered = filtered.ilike("agent_hr_id", `%${escaped}%`);
  }
  if (isVisits && ampm !== "all") filtered = filtered.eq("ampm", ampm);
  if (isVisits && visitType) {
    const escaped = sanitizeSearch(visitType);
    if (escaped) filtered = filtered.ilike("visit_type_description", `%${escaped}%`);
  }
  if (isVisits && mappingStatus === "agent_mapped") filtered = filtered.not("agent_hr_id", "is", null);
  if (isVisits && mappingStatus === "agent_unmapped") filtered = filtered.is("agent_hr_id", null);
  if (search) {
    const escaped = sanitizeSearch(search);
    if (escaped) {
      const orExpr = dataset === "checkins"
        ? `agent_hr_id.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,address.ilike.%${escaped}%`
        : `agent_name.ilike.%${escaped}%,double_name.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,customer_name.ilike.%${escaped}%,agent_hr_id.ilike.%${escaped}%,comment.ilike.%${escaped}%`;
      filtered = filtered.or(orExpr);
    }
  }

  const ordered = (filtered as unknown as typeof base)
    .order(dateColumn, { ascending: false })
    .order(idColumn, { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, latestSyncRuns] = await Promise.all([ordered, getLatestVisitsSyncRuns(6)]);
  if (error) {
    if (isCrmSchemaMissingError(error)) return empty(false);
    throw new Error(error.message);
  }

  return {
    ...echo,
    latestSyncRuns,
    rows: (data ?? []) as unknown as CrmMasterRow[],
    schemaReady: true,
    totalCount: count ?? 0,
  };
}
