/**
 * Loads what the Phoenix KPI rules need, for every rep one viewer may see.
 *
 * Only ever called once `kpiRulesFor` has answered "phoenix", which needs a CRM cutover date. Until
 * that date is set nothing reaches this file. The rules themselves are crm/phoenix-kpi-rules.ts.
 *
 * Reads the same doors the rest of the CRM uses: Phoenix's own contact lists (the open periods of
 * `crm_contact_assignments`, via `loadPanelRows` — the rep's own list decides AM, PM and pharmacy),
 * the unified plan view and the unified visit view, which serve Phoenix's own rows from the cutover on.
 */

import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import type { DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  computePhoenixRepKpis,
  type PhoenixPanelContact,
  type PhoenixPlanEntry,
  type PhoenixRepKpis,
  type PhoenixVisit,
} from "@/lib/crm/phoenix-kpi-rules";
import { queryVisits } from "@/lib/crm/reads";
import { scanPlanEntries } from "@/lib/crm/rep-doctor-lists";
import { loadPanelRows, narrowListType } from "@/lib/crm/rep-kpi-reports-data";
import type { RepKpiStandards } from "@/lib/crm/rep-kpi-reports";
import { canonicalHrIdKey } from "@/lib/hr-id";

const VISIT_COLUMNS =
  "agent_hr_id,agent_crm_id,contact_crm_id,visit_date,visit_type,visit_type_description,comment,ampm,speciality";

type VisitRecord = PhoenixVisit & { agent_hr_id: string | null; agent_crm_id: number | null };

export type PhoenixEmployeeDates = { hrId: string; hireDate: string | null; lastWorkingDate: string | null };

export type PhoenixKpiLoad = {
  /** Every rep's Phoenix KPIs, by canonical hr id. A rep with nothing loaded scores zeroes. */
  kpisFor: (hrKey: string | null) => PhoenixRepKpis;
  holidaysComplete: boolean;
};

export async function loadPhoenixRepKpis(input: {
  scope: DoctorCoverageScope;
  window: { dateFrom: string; dateTo: string; windowEnd: string };
  month: { start: string; end: string };
  today: string;
  employees: readonly PhoenixEmployeeDates[];
  standards?: RepKpiStandards;
}): Promise<PhoenixKpiLoad> {
  const [panelRows, planRows, visitRows, holidays] = await Promise.all([
    loadPanelRows(),
    scanPlanEntries(input.month.start, input.month.end),
    input.window.dateTo < input.month.start
      ? Promise.resolve([] as VisitRecord[])
      : queryVisits<VisitRecord>({
          dateFrom: input.month.start,
          dateTo: input.window.dateTo,
          columns: VISIT_COLUMNS,
          collapseDoubleVisits: true,
        }),
    loadCallRateHolidays(input.month.start, input.month.end),
  ]);

  // The plan view and the visit view leave the hr id blank on many vendor rows; the contact list
  // carries both ids, so it resolves the rest. A row neither can place is left out — the scope gate
  // cannot judge a row with no hr id, and failing closed is the only safe direction.
  const hrKeyByCrmId = new Map<number, string>();
  const panelByRep = new Map<string, PhoenixPanelContact[]>();
  for (const row of panelRows) {
    const key = canonicalHrIdKey(row.agent_hr_id);
    if (!key) continue;
    if (row.agent_crm_id != null) hrKeyByCrmId.set(row.agent_crm_id, key);
    if (!isAgentInScope(input.scope, row.agent_hr_id)) continue;
    const listType = narrowListType(row.list_type);
    if (!listType || row.contact_crm_id == null) continue;
    const bucket = panelByRep.get(key) ?? [];
    bucket.push({ contactCrmId: row.contact_crm_id, listType, grade: row.contact_grade });
    panelByRep.set(key, bucket);
  }

  const keyOf = (hrId: string | null, crmId: number | null): string | null =>
    canonicalHrIdKey(hrId) ?? (crmId != null ? (hrKeyByCrmId.get(crmId) ?? null) : null);

  const plansByRep = new Map<string, PhoenixPlanEntry[]>();
  for (const row of planRows) {
    const key = keyOf(row.agent_hr_id, row.agent_crm_id);
    if (!key || !isAgentInScope(input.scope, key)) continue;
    const bucket = plansByRep.get(key) ?? [];
    bucket.push({ contactCrmId: row.contact_crm_id, planDate: row.plan_date, grade: row.contact_grade, speciality: row.speciality });
    plansByRep.set(key, bucket);
  }

  const visitsByRep = new Map<string, PhoenixVisit[]>();
  for (const row of visitRows) {
    const key = keyOf(row.agent_hr_id, row.agent_crm_id);
    if (!key || !isAgentInScope(input.scope, key)) continue;
    const bucket = visitsByRep.get(key) ?? [];
    bucket.push(row);
    visitsByRep.set(key, bucket);
  }

  const datesByRep = new Map<string, PhoenixEmployeeDates>();
  for (const employee of input.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) datesByRep.set(key, employee);
  }

  const cache = new Map<string, PhoenixRepKpis>();
  const kpisFor = (hrKey: string | null): PhoenixRepKpis => {
    const key = canonicalHrIdKey(hrKey) ?? "";
    const cached = cache.get(key);
    if (cached) return cached;
    const dates = datesByRep.get(key);
    const computed = computePhoenixRepKpis({
      window: input.window,
      month: input.month,
      today: input.today,
      hireDate: dates?.hireDate ?? null,
      lastWorkingDate: dates?.lastWorkingDate ?? null,
      holidays: holidays.dates,
      panel: panelByRep.get(key) ?? [],
      planEntries: plansByRep.get(key) ?? [],
      visits: visitsByRep.get(key) ?? [],
      standards: input.standards,
    });
    cache.set(key, computed);
    return computed;
  };

  return { kpisFor, holidaysComplete: holidays.complete };
}
