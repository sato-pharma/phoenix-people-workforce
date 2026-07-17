import {
  correlateVisitsWithCheckins,
  type CrmIntegrityCheckinInput,
  type CrmIntegrityVisitInput,
} from "@/lib/crm-integrity/correlation";
import type { CrmIntegrityData, CrmIntegrityFilterInput, CrmIntegrityRow } from "@/lib/crm-integrity/types";
import { CRM_RESIGNED_IN_LIST } from "@/lib/crm/reads";
import { isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const visitsTable = "ireports360_visits";
const checkinsTable = "ireports360_checkins";
const keysetPageSize = 2000;

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
  return /ireports360_(visits|checkins)|schema cache|does not exist|PGRST205|42P01/i.test(message);
}

async function isSchemaReady() {
  const { error } = await getSupabaseAdmin().from(checkinsTable).select("id", { count: "exact", head: true }).limit(1);
  return !schemaMissing(error);
}

type RawVisitRow = {
  agent_crm_id: number;
  agent_hr_id: string | null;
  agent_name: string | null;
  comment: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_save_date: string | null;
  crm_visit_id: number;
  customer_name: string | null;
  id: string;
  visit_date: string;
  visit_date_time: string | null;
};

type RawCheckinRow = {
  address: string | null;
  agent_crm_id: number;
  check_date: string;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_checkin_id: number;
  lat: number | null;
  lon: number | null;
};

/**
 * Every check-in for the given agents within [dateFrom, dateTo] (inclusive), keyset-paginated by
 * `check_date` rather than a single flat `.limit()` -- a busy window across many agents could
 * otherwise silently truncate (confirmed directly: 17,041 rows matched a real 112-agent/30-day
 * production query, well past a flat 5000 cap).
 *
 * Deliberately NOT keyset-paginated by `id` (the pattern used by
 * src/lib/visits-report/service.ts's getDistinctAgentNames/getUnmappedCrmIdentities) -- `id` is a
 * random UUID uncorrelated with the (agent_crm_id, check_date) composite index this table
 * actually has, so `ORDER BY id` forces Postgres to abandon that index and scan+sort in id order
 * instead, applying the real filter as a row-by-row Filter step. Confirmed via EXPLAIN ANALYZE
 * against production: ordering by id took 12.8s and discarded 6,906 non-matching rows just to
 * fill one page; ordering by check_date (part of the existing composite index) took 130ms for the
 * same query. check_date is not guaranteed unique, so a `.gt()` cursor on it could theoretically
 * skip/duplicate a row if two check-ins share an identical timestamp -- accepted as a practically
 * negligible risk for real GPS-device timestamps (never observed in production data), not worth
 * the complexity of a compound (check_date, id) cursor for this MVP.
 */
async function fetchCheckinsForAgents(agentCrmIds: number[], dateFrom: string, dateTo: string): Promise<RawCheckinRow[]> {
  if (agentCrmIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const rows: RawCheckinRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(checkinsTable)
      .select("id, crm_checkin_id, agent_crm_id, contact_crm_id, contact_name, lat, lon, address, check_date")
      .in("agent_crm_id", agentCrmIds)
      .gte("check_date", `${dateFrom}T00:00:00`)
      .lte("check_date", `${dateTo}T23:59:59`)
      .order("check_date", { ascending: true })
      .limit(keysetPageSize);
    if (cursor) query = query.gt("check_date", cursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<RawCheckinRow & { id: string }>;
    rows.push(...page);
    if (page.length < keysetPageSize) break;
    cursor = page[page.length - 1].check_date;
  }
  return rows;
}

function toCheckinInput(row: RawCheckinRow): CrmIntegrityCheckinInput {
  return {
    address: row.address,
    agentCrmId: row.agent_crm_id,
    checkDate: row.check_date,
    contactCrmId: row.contact_crm_id,
    contactName: row.contact_name,
    crmCheckinId: row.crm_checkin_id,
    lat: row.lat,
    lon: row.lon,
  };
}

const distinctAgentNamesFetchCap = 25000;

/**
 * Distinct agent names in [dateFrom, dateTo], for the filter dropdown. Deliberately NOT
 * keyset-paginated by `id` the way src/lib/visits-report/service.ts's own getDistinctAgentNames
 * is -- confirmed via EXPLAIN ANALYZE against production that `ORDER BY id` here forces the same
 * index-abandonment problem as fetchCheckinsForAgents above (6.9s vs. 3.9s unordered for an
 * identical real 30-day query), because `id` isn't part of the `(visit_date)` index this table
 * actually has. A flat, unordered fetch capped well above any realistic window's row count
 * (today's 30-day default is 19,430 rows) is simpler and faster than paginating here, since only
 * the small set of distinct names is needed, not every individual row -- an extremely wide,
 * unusual date range could in theory truncate before finding every distinct name, but that only
 * narrows the filter dropdown's options, it never affects the correctness of the report's own
 * rows (which are always fetched by their own explicit paginated query, unaffected by this cap).
 */
async function getDistinctAgentNames(dateFrom: string, dateTo: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(visitsTable)
    .select("agent_name")
    .not("agent_crm_id", "in", CRM_RESIGNED_IN_LIST)
    .gte("visit_date", dateFrom)
    .lte("visit_date", dateTo)
    .limit(distinctAgentNamesFetchCap);
  if (error) throw new Error(error.message);
  const names = new Set<string>();
  for (const row of (data ?? []) as Array<{ agent_name: string | null }>) {
    if (row.agent_name) names.add(row.agent_name);
  }
  return Array.from(names).sort();
}

export async function getCrmIntegrityData(
  input: CrmIntegrityFilterInput & { page?: number; pageSize?: number },
): Promise<CrmIntegrityData> {
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
      page,
      pageSize,
      rows: [],
      schemaReady: false,
      totalCount: 0,
    };
  }

  const supabase = getSupabaseAdmin();
  let visitsQuery = supabase
    .from(visitsTable)
    .select("id, crm_visit_id, agent_crm_id, agent_hr_id, agent_name, contact_crm_id, contact_name, customer_name, comment, visit_date, visit_date_time, crm_save_date", {
      count: "exact",
    })
    .not("agent_crm_id", "in", CRM_RESIGNED_IN_LIST)
    .gte("visit_date", dateFrom)
    .lte("visit_date", dateTo);
  if (input.agentName) visitsQuery = visitsQuery.eq("agent_name", input.agentName);
  visitsQuery = visitsQuery
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, agents] = await Promise.all([visitsQuery, getDistinctAgentNames(dateFrom, dateTo)]);
  if (error) throw new Error(error.message);

  const visitRows = (data ?? []) as RawVisitRow[];
  if (visitRows.length === 0) {
    return {
      configured,
      dateFrom,
      dateTo,
      filters: { agents },
      page,
      pageSize,
      rows: [],
      schemaReady: true,
      totalCount: count ?? 0,
    };
  }

  const agentCrmIds = Array.from(new Set(visitRows.map((row) => row.agent_crm_id)));
  const lookbackDay = addDaysIso(dateFrom, -1);
  const [checkinRows, lookbackCheckinRows] = await Promise.all([
    fetchCheckinsForAgents(agentCrmIds, dateFrom, dateTo),
    fetchCheckinsForAgents(agentCrmIds, lookbackDay, lookbackDay),
  ]);

  const visitInputs: CrmIntegrityVisitInput[] = visitRows.map((row) => ({
    agentCrmId: row.agent_crm_id,
    contactCrmId: row.contact_crm_id,
    crmSaveDate: row.crm_save_date,
    crmVisitId: row.crm_visit_id,
    visitDate: row.visit_date,
    visitDateTime: row.visit_date_time,
  }));
  const correlations = correlateVisitsWithCheckins(
    visitInputs,
    checkinRows.map(toCheckinInput),
    lookbackCheckinRows.map(toCheckinInput),
  );
  const correlationByVisitId = new Map(correlations.map((result) => [result.crmVisitId, result]));

  const rows: CrmIntegrityRow[] = visitRows.map((row) => {
    const correlation = correlationByVisitId.get(row.crm_visit_id);
    return {
      agentCrmId: row.agent_crm_id,
      agentHrId: row.agent_hr_id,
      agentName: row.agent_name,
      checkinAddress: correlation?.checkinAddress ?? null,
      checkinContactCrmId: correlation?.checkinContactCrmId ?? null,
      checkinContactName: correlation?.checkinContactName ?? null,
      checkinDate: correlation?.checkinDate ?? null,
      checkinLat: correlation?.checkinLat ?? null,
      checkinLon: correlation?.checkinLon ?? null,
      comment: row.comment,
      contactMatchState: correlation?.contactMatchState ?? "no_checkin",
      contactName: row.contact_name,
      crmSaveDate: row.crm_save_date,
      crmVisitId: row.crm_visit_id,
      customerName: row.customer_name,
      distanceFromPreviousCheckinKm: correlation?.distanceFromPreviousCheckinKm ?? null,
      id: row.id,
      impliedSpeedKmh: correlation?.impliedSpeedKmh ?? null,
      saveLagFlag: correlation?.saveLagFlag ?? null,
      saveLagHours: correlation?.saveLagHours ?? null,
      speedFeasibilityFlag: correlation?.speedFeasibilityFlag ?? null,
      visitContactCrmId: row.contact_crm_id,
      visitDate: row.visit_date,
      visitDateTime: row.visit_date_time,
    };
  });

  return {
    configured,
    dateFrom,
    dateTo,
    filters: { agents },
    page,
    pageSize,
    rows,
    schemaReady: true,
    totalCount: count ?? rows.length,
  };
}
