/**
 * The single read API for CRM (iReports360) mirror data. Every module that needs visit or
 * check-in data calls these functions instead of running its own `.from("ireports360_*")`
 * query — that is the "one door" contract the CRM module enforces.
 *
 * Rows come back carrying the sync-time-resolved `agent_hr_id` / `double_hr_id`; callers map
 * them to their own domain shapes. Reads that project a subset of columns pass their own row
 * type as the generic (the `CrmVisitRow` / `CrmCheckinRow` defaults describe a `select("*")`).
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CHECKINS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError, isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import { isIReports360Configured } from "@/lib/crm/config";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import type { CrmCheckinRow, CrmVisitRow } from "@/lib/crm/types";
import type {
  VisitsReportData,
  VisitsReportExportResult,
  VisitsReportFilterInput,
  VisitsReportRow,
} from "@/lib/visits-report/types";

export type { CrmCheckinRow, CrmVisitRow } from "@/lib/crm/types";

/** Fieldwork visit-type codes that can count as a double visit: Regular (0) and
 * Campaign/Prospection (-8). The single definition shared by Double-Visit Analytics, probation
 * DV detection, the employee portal, and probation feedback. */
export const CRM_DOUBLE_VISIT_TYPE_CODES = [0, -8] as const;

/** Pure predicate: is this row a real double visit (a genuine partner on a fieldwork type)? */
export function isCrmDoubleVisitRow(row: {
  double_crm_id: number | null | undefined;
  visit_type: number | null | undefined;
}): boolean {
  return (
    row.double_crm_id != null &&
    row.double_crm_id !== 0 &&
    row.visit_type != null &&
    (CRM_DOUBLE_VISIT_TYPE_CODES as readonly number[]).includes(row.visit_type)
  );
}

/** Resigned CRM agents (owner-flagged, 2026-07-17): their iReports360 agent_crm_ids. Excluded from
 * EVERY CRM read — visits and check-ins — so resigned reps are invisible across all consumers that
 * go through this read layer. Single source; the CRM master table imports this same list. Resolved
 * from the owner's display-name list (see memory crm-resigned-agents-exclusion-list). */
export const CRM_RESIGNED_AGENT_CRM_IDS: readonly number[] = [
  832, 851, 1024, 1035, 1071, 1102, 1134, 1146, 1148, 1152, 1156, 1158, 1159, 1163, 1166, 1221,
  1222, 1236, 1246, 1247, 1249, 1272, 1280, 1284, 1286, 1288, 1295, 1303, 1304, 1330, 1345, 1351,
  1354, 1357, 1367, 1368, 1369, 1370, 1371, 1372, 1373, 1374, 1376, 1377, 1378, 1381, 1382, 1389,
  1395, 1396, 1402, 1407, 1409, 1437, 1476, 1477, 1478, 1486, 1492, 1493, 1504, 1508, 1510, 1511,
  1512, 1514, 1515, 1516, 1518, 1519, 1521, 1522, 1523, 1524, 1528,
];

/** PostgREST `in` list literal for the resigned ids, e.g. "(832,851,...)". */
const RESIGNED_IN_LIST = `(${CRM_RESIGNED_AGENT_CRM_IDS.join(",")})`;

const DEFAULT_PAGE_SIZE = 1000;

/** Shared visit filters, applied identically across every read. */
export type CrmVisitFilter = {
  /** Inclusive `visit_date` lower bound (YYYY-MM-DD). */
  dateFrom?: string;
  /** Inclusive `visit_date` upper bound (YYYY-MM-DD). */
  dateTo?: string;
  /** Restrict to these resolved agent hr ids (`agent_hr_id IN`). Empty array → no rows. */
  agentHrIds?: readonly string[];
  /** Restrict to these visit types (`visit_type IN`). */
  visitTypes?: readonly number[];
  /** Keep only rows with a real double partner (`double_crm_id` present and ≠ 0). */
  doubleOnly?: boolean;
  /** Require a resolved `agent_hr_id` (NOT NULL). */
  requireAgentHrId?: boolean;
  /** Require a resolved `double_hr_id` (NOT NULL). */
  requireDoubleHrId?: boolean;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- structural PostgREST builder shape; the
   real type is too deep to thread through a helper (see visits-report/service.ts precedent). */
type VisitFilterableQuery = {
  eq: (...args: any[]) => VisitFilterableQuery;
  gte: (...args: any[]) => VisitFilterableQuery;
  lte: (...args: any[]) => VisitFilterableQuery;
  in: (...args: any[]) => VisitFilterableQuery;
  is: (...args: any[]) => VisitFilterableQuery;
  neq: (...args: any[]) => VisitFilterableQuery;
  not: (...args: any[]) => VisitFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applyVisitFilter(query: VisitFilterableQuery, filter: CrmVisitFilter): VisitFilterableQuery {
  let result = query;
  // Resigned agents are invisible across every CRM read (single source).
  if (CRM_RESIGNED_AGENT_CRM_IDS.length > 0) result = result.not("agent_crm_id", "in", RESIGNED_IN_LIST);
  if (filter.dateFrom) result = result.gte("visit_date", filter.dateFrom);
  if (filter.dateTo) result = result.lte("visit_date", filter.dateTo);
  if (filter.agentHrIds && filter.agentHrIds.length > 0) result = result.in("agent_hr_id", [...filter.agentHrIds]);
  if (filter.visitTypes && filter.visitTypes.length > 0) result = result.in("visit_type", [...filter.visitTypes]);
  if (filter.doubleOnly) result = result.not("double_crm_id", "is", null).neq("double_crm_id", 0);
  if (filter.requireAgentHrId) result = result.not("agent_hr_id", "is", null);
  if (filter.requireDoubleHrId) result = result.not("double_hr_id", "is", null);
  return result;
}

/** Ensure the `id` column is present in a projection (needed for keyset pagination). */
function withIdColumn(columns: string): string {
  if (columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes("id") ? parts.join(", ") : ["id", ...parts].join(", ");
}

/** Ensure the `check_date` column is present (needed for check_date-keyset pagination). */
function withCheckDateColumn(columns: string): string {
  if (columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes("check_date") ? parts.join(", ") : ["check_date", ...parts].join(", ");
}

/**
 * Full keyset scan (order by `id` asc) of every `ireports360_visits` row matching `filter`.
 * Keyset (not OFFSET) pagination keeps cost linear even when the filter is weakly selective —
 * the same reason visits-report's own scans switched off `.range()`. Returns `[]` (never
 * throws) when the mirror schema isn't present yet. Callers re-sort in memory if they need a
 * display order.
 */
export async function queryVisits<T = CrmVisitRow>(
  options: CrmVisitFilter & { columns?: string; pageSize?: number },
): Promise<T[]> {
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const projection = withIdColumn(options.columns ?? "*");
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase.from(CRM_VISITS_TABLE).select(projection);
    query = applyVisitFilter(query as unknown as VisitFilterableQuery, options) as unknown as typeof query;
    query = query.order("id", { ascending: true }).limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as unknown as Array<T & { id: string }>;
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

/**
 * Bounded, DB-ordered single fetch — for "latest N" style reads that need a real order + hard
 * cap rather than a full scan. Returns `[]` (never throws) when the mirror schema is missing.
 */
export async function queryVisitsLimited<T = CrmVisitRow>(
  options: CrmVisitFilter & { columns?: string; orderBy?: string; ascending?: boolean; limit: number },
): Promise<T[]> {
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  let query = supabase.from(CRM_VISITS_TABLE).select(options.columns ?? "*");
  query = applyVisitFilter(query as unknown as VisitFilterableQuery, options) as unknown as typeof query;
  query = query
    .order(options.orderBy ?? "visit_date", { ascending: options.ascending ?? false })
    .limit(options.limit);
  const { data, error } = await query;
  if (error) {
    if (isCrmSchemaMissingError(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as unknown as T[];
}

/**
 * Full scan of double-visit rows (real partner on a fieldwork visit type). The canonical
 * double-visit predicate shared by Double-Visit Analytics, probation DV, the portal, and
 * probation feedback — so those consumers can never disagree about what counts as a double
 * visit. `visitTypes` defaults to {@link CRM_DOUBLE_VISIT_TYPE_CODES}.
 */
export async function getDoubleVisitRows<T = CrmVisitRow>(
  options: Omit<CrmVisitFilter, "doubleOnly"> & { columns?: string; pageSize?: number },
): Promise<T[]> {
  return queryVisits<T>({
    ...options,
    doubleOnly: true,
    visitTypes: options.visitTypes ?? CRM_DOUBLE_VISIT_TYPE_CODES,
  });
}

/** Shared check-in filters. */
export type CrmCheckinFilter = {
  /** Restrict to these CRM agent ids (`agent_crm_id IN`). Empty array → no rows. */
  agentCrmIds?: readonly number[];
  /** Restrict to these resolved agent hr ids (`agent_hr_id IN`). Empty array → no rows. */
  agentHrIds?: readonly string[];
  /** Inclusive `check_date` lower bound as a date (YYYY-MM-DD); expanded to `T00:00:00`. */
  dateFrom?: string;
  /** Inclusive `check_date` upper bound as a date (YYYY-MM-DD); expanded to `T23:59:59`. */
  dateTo?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- see VisitFilterableQuery note. */
type CheckinFilterableQuery = {
  gte: (...args: any[]) => CheckinFilterableQuery;
  lte: (...args: any[]) => CheckinFilterableQuery;
  in: (...args: any[]) => CheckinFilterableQuery;
  not: (...args: any[]) => CheckinFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applyCheckinFilter(query: CheckinFilterableQuery, filter: CrmCheckinFilter): CheckinFilterableQuery {
  let result = query;
  // Resigned agents are invisible across every CRM read (single source).
  if (CRM_RESIGNED_AGENT_CRM_IDS.length > 0) result = result.not("agent_crm_id", "in", RESIGNED_IN_LIST);
  if (filter.agentCrmIds && filter.agentCrmIds.length > 0) result = result.in("agent_crm_id", [...filter.agentCrmIds]);
  if (filter.agentHrIds && filter.agentHrIds.length > 0) result = result.in("agent_hr_id", [...filter.agentHrIds]);
  if (filter.dateFrom) result = result.gte("check_date", `${filter.dateFrom}T00:00:00`);
  if (filter.dateTo) result = result.lte("check_date", `${filter.dateTo}T23:59:59`);
  return result;
}

/**
 * Reads `ireports360_checkins` rows matching `filter`.
 *
 * - With an explicit `limit`: a single ordered, bounded fetch (e.g. "nearest few check-ins").
 * - Without `limit`: a full-coverage scan, keyset-paginated by `check_date`. `check_date` (not
 *   the random uuid `id`) is part of the `(agent_crm_id, check_date)` composite index this table
 *   has, so ordering by it keeps each page an index range-scan rather than a full sort — 130ms
 *   vs 12.8s on a real 30-day/112-agent production query. `check_date` is not guaranteed unique,
 *   so a `.gt()` cursor could theoretically skip a row sharing an identical device timestamp;
 *   accepted as negligible for real GPS timestamps (never observed in production).
 *
 * Returns `[]` (never throws) when the mirror schema is missing.
 */
export async function queryCheckins<T = CrmCheckinRow>(
  options: CrmCheckinFilter & { columns?: string; orderBy?: string; ascending?: boolean; limit?: number; pageSize?: number },
): Promise<T[]> {
  if (options.agentCrmIds && options.agentCrmIds.length === 0) return [];
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();

  if (options.limit != null) {
    let query = supabase.from(CRM_CHECKINS_TABLE).select(options.columns ?? "*");
    query = applyCheckinFilter(query as unknown as CheckinFilterableQuery, options) as unknown as typeof query;
    query = query.order(options.orderBy ?? "check_date", { ascending: options.ascending ?? true }).limit(options.limit);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    return (data ?? []) as unknown as T[];
  }

  const projection = withCheckDateColumn(options.columns ?? "*");
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase.from(CRM_CHECKINS_TABLE).select(projection);
    query = applyCheckinFilter(query as unknown as CheckinFilterableQuery, options) as unknown as typeof query;
    query = query.order("check_date", { ascending: true }).limit(pageSize);
    if (cursor) query = query.gt("check_date", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as unknown as Array<T & { check_date: string }>;
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].check_date;
  }
  return rows;
}

// ── Visits Report view (paginated table + export) ─────────────────────────────────
// The Super-Admin "raw CRM visits" browser and its export. Relocated verbatim from
// visits-report/service.ts; behavior unchanged.

const MAX_EXPORT_ROWS = 20000;

/**
 * Columns getVisitsReportData / getVisitsReportExportRows actually need — kept in sync with
 * mapVisitRow below. Excludes raw_payload, synced_at, and updated_at, which together are the
 * majority of each row's byte size (raw_payload alone averages ~62% of a row) and are never read
 * by either caller; select("*") was pulling all of it on every paginated report/export request.
 */
const visitReportColumns =
  "id, agent_crm_id, agent_hr_id, agent_name, ampm, attendance, call_type, comment, " +
  "contact_name, crm_save_date, crm_visit_id, customer_name, double_crm_id, double_hr_id, " +
  "double_name, visit_date, visit_date_time, visit_type, visit_type_description";

export function mapVisitRow(row: Record<string, unknown>): VisitsReportRow {
  return {
    agentCrmId: Number(row.agent_crm_id),
    agentHrId: (row.agent_hr_id as string | null) ?? null,
    agentName: (row.agent_name as string | null) ?? null,
    ampm: (row.ampm as string | null) ?? null,
    attendance: row.attendance == null ? null : Number(row.attendance),
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
type ReportFilterableQuery = {
  eq: (...args: any[]) => ReportFilterableQuery;
  gte: (...args: any[]) => ReportFilterableQuery;
  ilike: (...args: any[]) => ReportFilterableQuery;
  is: (...args: any[]) => ReportFilterableQuery;
  lte: (...args: any[]) => ReportFilterableQuery;
  not: (...args: any[]) => ReportFilterableQuery;
  or: (...args: any[]) => ReportFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applyVisitsReportFilters(
  query: ReportFilterableQuery,
  filters: VisitsReportFilterInput & { dateFrom: string; dateTo: string },
): ReportFilterableQuery {
  let result: ReportFilterableQuery = query.gte("visit_date", filters.dateFrom).lte("visit_date", filters.dateTo);
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
    .from(CRM_CHECKINS_TABLE)
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
      .from(CRM_VISITS_TABLE)
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
    .from(CRM_VISITS_TABLE)
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

  if (!(await isCrmVisitsSchemaReady())) {
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
  const baseQuery = supabase.from(CRM_VISITS_TABLE).select(visitReportColumns, { count: "exact" });
  const filteredQuery = (applyVisitsReportFilters(baseQuery as unknown as ReportFilterableQuery, { ...input, dateFrom, dateTo }) as unknown as typeof baseQuery)
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

  const rawRows = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapVisitRow);
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

  if (!(await isCrmVisitsSchemaReady())) {
    return { rows: [], totalCount: 0, truncated: false };
  }

  const supabase = getSupabaseAdmin();
  const baseQuery = supabase.from(CRM_VISITS_TABLE).select(visitReportColumns, { count: "exact" });
  const filteredQuery = (applyVisitsReportFilters(baseQuery as unknown as ReportFilterableQuery, { ...input, dateFrom, dateTo }) as unknown as typeof baseQuery)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);

  const { data, error, count } = await filteredQuery;
  if (error) throw new Error(error.message);

  const rawRows = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapVisitRow);
  const rows = await attachNearestCheckins(rawRows, dateFrom, dateTo);
  const totalCount = count ?? rows.length;

  return { rows, totalCount, truncated: totalCount > rows.length };
}
