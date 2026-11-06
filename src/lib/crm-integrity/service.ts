import {
  correlateVisitsWithCheckins,
  type CrmIntegrityCheckinInput,
  type CrmIntegrityVisitInput,
} from "@/lib/crm-integrity/correlation";
import type { CrmIntegrityData, CrmIntegrityFilterInput, CrmIntegrityRow } from "@/lib/crm-integrity/types";
import { getVisitAgentNames, queryCheckins, queryVisitsPage } from "@/lib/crm/reads";
import { isCrmCheckinsSchemaReady } from "@/lib/crm/schema";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

const checkinColumns = "crm_checkin_id, agent_crm_id, contact_crm_id, contact_name, lat, lon, address, check_date";

/**
 * Every check-in for the given agents within [dateFrom, dateTo] (inclusive) — delegated to the
 * CRM read layer (single source), which keyset-paginates by `check_date` (part of the
 * `(agent_crm_id, check_date)` composite index) so a busy multi-agent window is not silently
 * truncated at the PostgREST row cap. See queryCheckins for the index/perf rationale.
 */
async function fetchCheckinsForAgents(agentCrmIds: number[], dateFrom: string, dateTo: string): Promise<RawCheckinRow[]> {
  if (agentCrmIds.length === 0) return [];
  return queryCheckins<RawCheckinRow>({
    agentCrmIds,
    dateFrom,
    dateTo,
    columns: checkinColumns,
    pageSize: 2000,
    // The CRM integrity page is the Super Admin's — no rep reaches it, so a started Phoenix CRM team's
    // visits count as its check-ins here (owner, 2026-10-02; src/lib/crm/phoenix-team-starts.ts lists every
    // reader that asks).
    includePhoenixVisits: true,
  });
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

export async function getCrmIntegrityData(
  input: CrmIntegrityFilterInput & { page?: number; pageSize?: number },
): Promise<CrmIntegrityData> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -30);
  const dateTo = input.dateTo || today;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, input.pageSize ?? 100));

  if (!(await isCrmCheckinsSchemaReady())) {
    return {
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

  const visitColumns =
    "id, crm_visit_id, agent_crm_id, agent_hr_id, agent_name, contact_crm_id, contact_name, " +
    "customer_name, comment, visit_date, visit_date_time, crm_save_date";
  const [{ rows: visitRows, count }, agents] = await Promise.all([
    queryVisitsPage<RawVisitRow>({
      dateFrom,
      dateTo,
      agentName: input.agentName,
      columns: visitColumns,
      orderBy: [
        { column: "visit_date", ascending: false },
        { column: "crm_visit_id", ascending: false },
      ],
      page,
      pageSize,
    }),
    getVisitAgentNames(dateFrom, dateTo),
  ]);
  if (visitRows.length === 0) {
    return {
      dateFrom,
      dateTo,
      filters: { agents },
      page,
      pageSize,
      rows: [],
      schemaReady: true,
      totalCount: count,
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
    dateFrom,
    dateTo,
    filters: { agents },
    page,
    pageSize,
    rows,
    schemaReady: true,
    totalCount: count,
  };
}
