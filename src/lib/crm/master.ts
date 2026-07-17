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
import { CRM_RESIGNED_AGENT_CRM_IDS } from "@/lib/crm/reads";
import type { VisitsSyncRun } from "@/lib/visits-report/types";

export type CrmMasterDataset =
  | "visits"
  | "checkins"
  | "double_visits"
  | "vacations"
  | "regular_no_checkin"
  | "crm_issues";

/** All datasets a tab can show, in display order. */
export const CRM_MASTER_DATASETS: ReadonlyArray<{ id: CrmMasterDataset; label: string }> = [
  { id: "visits", label: "Visits" },
  { id: "checkins", label: "Check-ins" },
  { id: "double_visits", label: "Double Visits" },
  { id: "vacations", label: "Vacations" },
  { id: "regular_no_checkin", label: "Regular · No Check-in" },
  { id: "crm_issues", label: "CRM Issues" },
];

/** DB view (migration crm_effective_visit_type_view) exposing has_checkin + effective_visit_type +
 * reclassified_no_checkin. Used only for the "Regular · No Check-in" tab's DB-level filter/count;
 * the other tabs read the base table and derive the flag in memory. */
const CRM_VISITS_EFFECTIVE_VIEW = "ireports360_visits_effective";

/** A visit-based dataset (everything except check-ins reads the visits table). */
function isVisitDataset(dataset: CrmMasterDataset): boolean {
  return dataset !== "checkins";
}

/** Fixed visit-type options for the Visit Type dropdown (a stable iReports360 enum). */
export const CRM_VISIT_TYPE_OPTIONS: readonly string[] = [
  "Regular Visit",
  "Campaign (Prospection)",
  "Meeting",
  "Group Meeting",
  "Conference",
  "Training",
  "Health Day",
  "Traveling",
  "Annual Vacation",
  "Unknown",
];

/** A displayed column: the raw DB key + a human label + a rendering hint + an optional
 * header tooltip.
 *  - `date`            → date only.
 *  - `datetime`        → a true UTC instant WE recorded (e.g. synced_at), converted to Cairo.
 *  - `datetime_local`  → a vendor timestamp that is already Cairo wall-clock but stored tagged
 *                        UTC (iReports360 sends zone-less local times); render the stored clock
 *                        as-is with NO timezone shift, otherwise it reads hours too late. */
export type CrmMasterColumn = {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "datetime" | "datetime_local" | "coord";
  note?: string;
};

/** Ordered columns shown for the visits dataset (every stored field except raw_payload, which is
 * shown per-row as the full JSON, and the internal uuid `id`). */
export const CRM_VISIT_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "crm_visit_id", kind: "number", label: "CRM Visit ID" },
  { key: "visit_date", kind: "date", label: "Visit Date" },
  { key: "crm_save_date", kind: "datetime_local", label: "CRM Save Date", note: "The real time the agent saved/submitted this visit in the CRM (Cairo time) — the one authoritative visit timestamp. Logged time, not GPS-verified proof of being on site." },
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
  { key: "effective_type", kind: "text", label: "Effective Type", note: "How the system counts this visit. A Regular visit with NO matching GPS check-in is counted as Campaign — always shown here (flagged), never silently recounted." },
  { key: "call_type", kind: "number", label: "Call Type" },
  { key: "attendance", kind: "number", label: "Attendance" },
  { key: "comment", kind: "text", label: "Comment" },
  { key: "checkin_id", kind: "number", label: "Check-in ID", note: "All 'Check-in …' columns come from the GPS check-in at the SAME contact (same rep, same day; nearest in time to CRM Save Date if the contact has several). Only Regular visits have a contact — Campaign/Meeting/Vacation/etc. correctly show — (no check-in)." },
  { key: "checkin_time", kind: "datetime_local", label: "Check-in Time" },
  { key: "checkin_agent_crm_id", kind: "number", label: "Check-in Agent CRM ID" },
  { key: "checkin_agent_hr_id", kind: "text", label: "Check-in Agent HR ID" },
  { key: "checkin_contact_id", kind: "number", label: "Check-in Contact ID" },
  { key: "checkin_contact_name", kind: "text", label: "Check-in Contact" },
  { key: "checkin_lat", kind: "coord", label: "Check-in Latitude" },
  { key: "checkin_lon", kind: "coord", label: "Check-in Longitude" },
  { key: "checkin_address", kind: "text", label: "Check-in Address" },
  { key: "checkin_synced_at", kind: "datetime", label: "Check-in Synced At" },
  { key: "synced_at", kind: "datetime", label: "Synced At", note: "When Phoenix pulled this record from the CRM into its mirror (Cairo time)." },
];

/** Ordered columns shown for the check-ins dataset. */
export const CRM_CHECKIN_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "crm_checkin_id", kind: "number", label: "CRM Check-in ID" },
  { key: "check_date", kind: "datetime_local", label: "Check Date", note: "Real GPS check-in time from the agent's phone (Cairo time)." },
  { key: "agent_crm_id", kind: "number", label: "Agent CRM ID" },
  { key: "agent_hr_id", kind: "text", label: "Agent HR ID" },
  { key: "contact_crm_id", kind: "number", label: "Contact CRM ID" },
  { key: "contact_name", kind: "text", label: "Contact Name" },
  { key: "lat", kind: "coord", label: "Latitude" },
  { key: "lon", kind: "coord", label: "Longitude" },
  { key: "address", kind: "text", label: "Address" },
  { key: "synced_at", kind: "datetime", label: "Synced At", note: "When Phoenix pulled this record from the CRM into its mirror (Cairo time)." },
];

/** Vacation / issue tabs reuse the visit fields WITHOUT the nearest-check-in block (those records
 * have no check-in). Derived so the base column set stays defined in one place. */
const CRM_VISIT_BASE_COLUMNS: readonly CrmMasterColumn[] = CRM_VISIT_COLUMNS.filter(
  (col) => !col.key.startsWith("checkin_"),
);

const CRM_ISSUE_COLUMN: CrmMasterColumn = {
  key: "issue",
  kind: "text",
  label: "Issue",
  note: "Why this record isn't fully recognized: an unmapped agent and/or unmapped double visitor — its CRM id did not resolve to a Phoenix employee.",
};

const CRM_ISSUE_COLUMNS: readonly CrmMasterColumn[] = [CRM_ISSUE_COLUMN, ...CRM_VISIT_BASE_COLUMNS];

/** Columns shown for a given dataset/tab. */
function columnsForDataset(dataset: CrmMasterDataset): readonly CrmMasterColumn[] {
  if (dataset === "checkins") return CRM_CHECKIN_COLUMNS;
  if (dataset === "vacations" || dataset === "regular_no_checkin") return CRM_VISIT_BASE_COLUMNS;
  if (dataset === "crm_issues") return CRM_ISSUE_COLUMNS;
  return CRM_VISIT_COLUMNS; // visits, double_visits
}

const VISIT_SELECT =
  "id, crm_visit_id, agent_crm_id, agent_hr_id, agent_name, ampm, attendance, call_type, comment, " +
  "contact_crm_id, contact_name, crm_save_date, customer_name, double_crm_id, double_hr_id, double_name, " +
  "visit_date, visit_type, visit_type_description, synced_at, raw_payload";

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
  visitTypeOptions: readonly string[];
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
  neq: (...args: any[]) => MasterQuery;
  not: (...args: any[]) => MasterQuery;
  or: (...args: any[]) => MasterQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Escapes a free-text search term for a PostgREST `or(...ilike...)` expression. */
function sanitizeSearch(term: string): string {
  return term.replace(/[%,()]/g, " ").trim();
}

type CheckinLite = {
  address: string | null;
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  check_date: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_checkin_id: number | null;
  lat: number | null;
  lon: number | null;
  synced_at: string | null;
};

/** The nearest-check-in fields merged onto each visit row (all null when there's no match) —
 * the full set of check-in columns, mirroring the Check-ins dataset. */
const CHECKIN_MERGE_KEYS = [
  "checkin_id",
  "checkin_time",
  "checkin_agent_crm_id",
  "checkin_agent_hr_id",
  "checkin_contact_id",
  "checkin_contact_name",
  "checkin_lat",
  "checkin_lon",
  "checkin_address",
  "checkin_synced_at",
] as const;

/**
 * Attach each visit's GPS check-in: matched by same rep + SAME contact + same day — a check-in
 * belongs to the regular visit at that contact — and when one contact has >1 check-in that day, the
 * one nearest in time to the visit's crm_save_date. Only REGULAR visits carry a contact, so
 * non-regular visits (Campaign, Meeting, Vacation, …) correctly get no check-in. Time is only a
 * tiebreaker, anchored on crm_save_date (the real submit time); both it and check_date are
 * Cairo-local so the gap is consistent. Mutates rows in place; best-effort (leaves nulls on failure
 * or no same-contact match). Only the current page of visits is correlated.
 */
async function attachNearestCheckins(rows: CrmMasterRow[]): Promise<void> {
  for (const row of rows) {
    for (const key of CHECKIN_MERGE_KEYS) row[key] = null;
  }
  const agentIds = Array.from(
    new Set(rows.map((r) => r.agent_crm_id).filter((v): v is number => typeof v === "number")),
  );
  const days = rows
    .map((r) => (typeof r.visit_date === "string" ? r.visit_date.slice(0, 10) : null))
    .filter((v): v is string => Boolean(v));
  if (agentIds.length === 0 || days.length === 0) return;
  const from = days.reduce((a, b) => (a < b ? a : b));
  const to = days.reduce((a, b) => (a > b ? a : b));

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_CHECKINS_TABLE)
    .select("crm_checkin_id, check_date, agent_crm_id, agent_hr_id, contact_crm_id, contact_name, lat, lon, address, synced_at")
    .in("agent_crm_id", agentIds)
    .gte("check_date", `${from}T00:00:00`)
    .lte("check_date", `${to}T23:59:59`)
    .limit(20000);
  if (error || !data) return;

  // Key by agent + CONTACT + day: a check-in belongs to the regular visit at that same contact.
  const byAgentContactDay = new Map<string, CheckinLite[]>();
  for (const c of data as CheckinLite[]) {
    if (c.agent_crm_id == null || c.contact_crm_id == null || !c.check_date) continue;
    const key = `${c.agent_crm_id}|${c.contact_crm_id}|${String(c.check_date).slice(0, 10)}`;
    const list = byAgentContactDay.get(key);
    if (list) list.push(c);
    else byAgentContactDay.set(key, [c]);
  }

  for (const row of rows) {
    const agent = typeof row.agent_crm_id === "number" ? row.agent_crm_id : null;
    // Only regular visits carry a real contact; a check-in belongs to the visit at the SAME contact.
    // Non-regular visits (Campaign, Meeting, Vacation, …) have no contact and genuinely no check-in.
    const contact = typeof row.contact_crm_id === "number" && row.contact_crm_id !== 0 ? row.contact_crm_id : null;
    const day = typeof row.visit_date === "string" ? row.visit_date.slice(0, 10) : null;
    if (agent == null || contact == null || !day) continue;
    const candidates = byAgentContactDay.get(`${agent}|${contact}|${day}`);
    if (!candidates || candidates.length === 0) continue;

    // One contact can have >1 check-in that day → pick the one nearest in time to crm_save_date.
    const anchorMs = typeof row.crm_save_date === "string" ? new Date(row.crm_save_date).getTime() : NaN;
    let best = candidates[0];
    if (Number.isFinite(anchorMs)) {
      let bestDiff = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const diff = Math.abs(new Date(String(c.check_date)).getTime() - anchorMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }
    }
    row.checkin_id = best.crm_checkin_id;
    row.checkin_time = best.check_date;
    row.checkin_agent_crm_id = best.agent_crm_id;
    row.checkin_agent_hr_id = best.agent_hr_id;
    row.checkin_contact_id = best.contact_crm_id;
    row.checkin_contact_name = best.contact_name;
    row.checkin_lat = best.lat;
    row.checkin_lon = best.lon;
    row.checkin_address = best.address;
    row.checkin_synced_at = best.synced_at;
  }
}

/** CRM Issues: anything not fully recognized — an unmapped agent and/or (for a double visit) an
 * unmapped double visitor. Sets the `issue` column describing what didn't resolve. */
function attachIssueReason(rows: CrmMasterRow[]): void {
  for (const row of rows) {
    const agentUnmapped = row.agent_hr_id == null || row.agent_hr_id === "";
    const hasDouble = typeof row.double_crm_id === "number" && row.double_crm_id !== 0;
    const doubleUnmapped = hasDouble && (row.double_hr_id == null || row.double_hr_id === "");
    const reasons: string[] = [];
    if (agentUnmapped) reasons.push("Agent unmapped");
    if (doubleUnmapped) reasons.push("Double visitor unmapped");
    row.issue = reasons.length > 0 ? reasons.join(" · ") : "Unmapped";
  }
}

/** Effective visit type: a Regular visit (0) with NO matched GPS check-in is COUNTED as Campaign,
 * but ALWAYS flagged here — never a silent recount. For regular_no_checkin every row is reclassified
 * (the tab filters to it); for visits/double it's derived from the in-memory check-in correlation
 * (checkin_id null). Datasets that don't correlate (vacations, crm_issues) keep the raw type. */
function attachEffectiveType(dataset: CrmMasterDataset, rows: CrmMasterRow[]): void {
  const knowsCheckin = dataset === "visits" || dataset === "double_visits" || dataset === "regular_no_checkin";
  for (const row of rows) {
    const isRegular = row.visit_type === 0;
    const reclassified = dataset === "regular_no_checkin" ? true : knowsCheckin && isRegular && row.checkin_id == null;
    row.effective_type = reclassified
      ? "Campaign — reclassified (Regular, no check-in)"
      : (typeof row.visit_type_description === "string" && row.visit_type_description) || String(row.visit_type ?? "—");
  }
}

/** Normalize the requested dataset to a known value. */
function normalizeDataset(value: CrmMasterDataset | undefined): CrmMasterDataset {
  return value && CRM_MASTER_DATASETS.some((d) => d.id === value) ? value : "visits";
}

/** Apply date + advanced + dataset-scope filters. Shared by the paginated view and the export. */
function applyMasterFilters(
  query: MasterQuery,
  opts: {
    agentHrId: string | null;
    ampm: CrmMasterAmpm;
    dataset: CrmMasterDataset;
    dateFrom: string | null;
    dateTo: string | null;
    mappingStatus: CrmMasterMappingStatus;
    search: string | null;
    visitType: string | null;
  },
): MasterQuery {
  const { agentHrId, ampm, dataset, dateFrom, dateTo, mappingStatus, search, visitType } = opts;
  const isCheckins = dataset === "checkins";
  const isVisits = isVisitDataset(dataset);
  const dateColumn = isCheckins ? "check_date" : "visit_date";

  let q = query;
  // Resigned agents (owner-flagged) are invisible across every CRM tab — visits + check-ins alike.
  if (CRM_RESIGNED_AGENT_CRM_IDS.length > 0) {
    q = q.not("agent_crm_id", "in", `(${CRM_RESIGNED_AGENT_CRM_IDS.join(",")})`);
  }
  if (dateFrom) q = q.gte(dateColumn, isCheckins ? `${dateFrom}T00:00:00` : dateFrom);
  if (dateTo) q = q.lte(dateColumn, isCheckins ? `${dateTo}T23:59:59` : dateTo);

  // Dataset scope.
  if (dataset === "double_visits") q = q.not("double_crm_id", "is", null).neq("double_crm_id", 0);
  if (dataset === "vacations") q = q.ilike("visit_type_description", "%vacation%");
  if (dataset === "regular_no_checkin") q = q.eq("reclassified_no_checkin", true);
  if (dataset === "crm_issues") {
    q = q.or("agent_hr_id.is.null,and(double_crm_id.not.is.null,double_crm_id.neq.0,double_hr_id.is.null)");
  }

  // Advanced filters. agent_hr_id exists on both tables; the rest are visits-only columns.
  if (agentHrId) {
    const escaped = sanitizeSearch(agentHrId);
    if (escaped) q = q.ilike("agent_hr_id", `%${escaped}%`);
  }
  if (isVisits && ampm !== "all") q = q.eq("ampm", ampm);
  if (isVisits && visitType) {
    const escaped = sanitizeSearch(visitType);
    if (escaped) q = q.ilike("visit_type_description", `%${escaped}%`);
  }
  if (isVisits && mappingStatus === "agent_mapped") q = q.not("agent_hr_id", "is", null);
  if (isVisits && mappingStatus === "agent_unmapped") q = q.is("agent_hr_id", null);
  if (search) {
    const escaped = sanitizeSearch(search);
    if (escaped) {
      const orExpr = isCheckins
        ? `agent_hr_id.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,address.ilike.%${escaped}%`
        : `agent_name.ilike.%${escaped}%,double_name.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,customer_name.ilike.%${escaped}%,agent_hr_id.ilike.%${escaped}%,comment.ilike.%${escaped}%`;
      q = q.or(orExpr);
    }
  }
  return q;
}

/** Merge derived columns onto rows (nearest check-in for visit datasets, issue reason for issues). */
async function attachDerived(dataset: CrmMasterDataset, rows: CrmMasterRow[]): Promise<void> {
  if (dataset === "visits" || dataset === "double_visits") await attachNearestCheckins(rows);
  if (dataset === "crm_issues") attachIssueReason(rows);
  if (isVisitDataset(dataset)) attachEffectiveType(dataset, rows);
}

/**
 * Paginated master view of one CRM dataset (visits or check-ins). Returns every stored column
 * plus the full `raw_payload` for each row, ordered newest-first, with an exact total count.
 * Degrades to an empty result (never throws) when the mirror schema isn't present yet.
 */
export async function getCrmMasterData(input: CrmMasterFilter = {}): Promise<CrmMasterData> {
  const dataset = normalizeDataset(input.dataset);
  const isCheckins = dataset === "checkins";
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

  const columns = columnsForDataset(dataset);
  const filterOpts = { agentHrId, ampm, dataset, dateFrom, dateTo, mappingStatus, search, visitType };

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
    visitTypeOptions: CRM_VISIT_TYPE_OPTIONS,
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
  const table = dataset === "regular_no_checkin" ? CRM_VISITS_EFFECTIVE_VIEW : isCheckins ? CRM_CHECKINS_TABLE : CRM_VISITS_TABLE;
  const dateColumn = isCheckins ? "check_date" : "visit_date";
  const idColumn = isCheckins ? "crm_checkin_id" : "crm_visit_id";
  const select = isCheckins ? CHECKIN_SELECT : VISIT_SELECT;

  const base = supabase.from(table).select(select, { count: "exact" });
  const filtered = applyMasterFilters(base as unknown as MasterQuery, filterOpts);
  const ordered = (filtered as unknown as typeof base)
    .order(dateColumn, { ascending: false })
    .order(idColumn, { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, latestSyncRuns] = await Promise.all([ordered, getLatestVisitsSyncRuns(6)]);
  if (error) {
    if (isCrmSchemaMissingError(error)) return empty(false);
    throw new Error(error.message);
  }

  const rows = (data ?? []) as unknown as CrmMasterRow[];
  await attachDerived(dataset, rows);

  return { ...echo, latestSyncRuns, rows, schemaReady: true, totalCount: count ?? 0 };
}

/**
 * All matching rows for a dataset + filters, UNPAGINATED (capped at 50k) — powers the XLSX export.
 * Runs the same filters and derived columns as the paginated view; walks pages internally.
 */
export async function getCrmMasterExportRows(
  input: CrmMasterFilter = {},
): Promise<{ columns: readonly CrmMasterColumn[]; dataset: CrmMasterDataset; rows: CrmMasterRow[]; truncated: boolean }> {
  const dataset = normalizeDataset(input.dataset);
  const isCheckins = dataset === "checkins";
  const columns = columnsForDataset(dataset);
  const filterOpts = {
    agentHrId: input.agentHrId?.trim() || null,
    ampm: (input.ampm === "AM" || input.ampm === "PM" ? input.ampm : "all") as CrmMasterAmpm,
    dataset,
    dateFrom: input.dateFrom || null,
    dateTo: input.dateTo || null,
    mappingStatus: (input.mappingStatus === "agent_mapped" || input.mappingStatus === "agent_unmapped"
      ? input.mappingStatus
      : "all") as CrmMasterMappingStatus,
    search: input.search?.trim() || null,
    visitType: input.visitType?.trim() || null,
  };

  const emptyResult = { columns, dataset, rows: [] as CrmMasterRow[], truncated: false };
  if (!(await isCrmVisitsSchemaReady())) return emptyResult;

  const supabase = getSupabaseAdmin();
  const table = dataset === "regular_no_checkin" ? CRM_VISITS_EFFECTIVE_VIEW : isCheckins ? CRM_CHECKINS_TABLE : CRM_VISITS_TABLE;
  const dateColumn = isCheckins ? "check_date" : "visit_date";
  const idColumn = isCheckins ? "crm_checkin_id" : "crm_visit_id";
  const select = isCheckins ? CHECKIN_SELECT : VISIT_SELECT;

  const PAGE = 1000;
  const MAX_ROWS = 50000;
  const rows: CrmMasterRow[] = [];
  let truncated = false;
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const base = supabase.from(table).select(select);
    const filtered = applyMasterFilters(base as unknown as MasterQuery, filterOpts);
    const { data, error } = await (filtered as unknown as typeof base)
      .order(dateColumn, { ascending: false })
      .order(idColumn, { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isCrmSchemaMissingError(error)) return emptyResult;
      throw new Error(error.message);
    }
    const pageRows = (data ?? []) as unknown as CrmMasterRow[];
    rows.push(...pageRows);
    if (pageRows.length < PAGE) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }

  await attachDerived(dataset, rows);
  return { columns, dataset, rows, truncated };
}
