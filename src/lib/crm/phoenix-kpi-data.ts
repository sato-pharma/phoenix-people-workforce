/**
 * Loads what the Phoenix KPI rules need, for every rep one viewer may see.
 *
 * Called when `kpiRulesFor` has answered "phoenix" (the company-wide cutover), OR when any rep in
 * scope belongs to a team that went live before the period began (`phoenixRuleRepKeys`, the per-team
 * switch of 2026-10-07) — so it is LIVE today for every started team, on the Weekly tab and on any
 * period that starts on or after a go-live day. The rules themselves are crm/phoenix-kpi-rules.ts.
 *
 * Reads the same doors the rest of the CRM uses: Phoenix's own contact lists (the open periods of
 * `crm_contact_assignments`, via `loadPanelRows` — the rep's own list decides AM, PM and pharmacy),
 * the unified plan view and the unified visit view, which serve Phoenix's own rows from the cutover on.
 */

import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import type { DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  computePhoenixCoverageDoctors,
  computePhoenixRepKpis,
  phoenixVisitHasCheckin,
  type PhoenixCoverageDoctor,
  type PhoenixKpiWindow,
  type PhoenixPanelContact,
  type PhoenixPlanEntry,
  type PhoenixRepInput,
  type PhoenixRepKpis,
  type PhoenixVisit,
} from "@/lib/crm/phoenix-kpi-rules";
import { queryCheckins, queryVisits } from "@/lib/crm/reads";
import { scanPlanEntries } from "@/lib/crm/rep-doctor-lists";
import { loadPanelRows, narrowListType } from "@/lib/crm/rep-kpi-reports-data";
import type { RepKpiStandards } from "@/lib/crm/rep-kpi-reports";
import { canonicalHrIdKey } from "@/lib/hr-id";

// `source` and `crm_visit_id` tell a Phoenix CRM visit apart: it is its own check-in (rule 10, see
// `phoenixVisitHasCheckin`), and the check-in door never serves a vendor check-in on its day.
const VISIT_COLUMNS =
  "agent_hr_id,agent_crm_id,contact_crm_id,visit_date,visit_type,visit_type_description,comment,ampm,speciality,crm_save_date,source,crm_visit_id";

type VisitRecord = Omit<PhoenixVisit, "hasCheckin"> & {
  agent_hr_id: string | null;
  agent_crm_id: number | null;
  crm_save_date: string | null;
  source: string | null;
  crm_visit_id: number | null;
};

type CheckinRecord = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  check_date: string | null;
};

function isoDay(value: string | null | undefined): string | null {
  const day = String(value ?? "").slice(0, 10);
  return day.length === 10 ? day : null;
}

export type PhoenixEmployeeDates = { hrId: string; hireDate: string | null; lastWorkingDate: string | null };

export type PhoenixKpiLoad = {
  /** Every rep's Phoenix KPIs, by canonical hr id. A rep with nothing loaded scores zeroes. */
  kpisFor: (hrKey: string | null) => PhoenixRepKpis;
  /** One rep's planned doctors for the Coverage tab, from the same inputs as `kpisFor`. */
  coverageDoctorsFor: (hrKey: string | null) => PhoenixCoverageDoctor[];
  holidaysComplete: boolean;
};

export async function loadPhoenixRepKpis(input: {
  scope: DoctorCoverageScope;
  window: PhoenixKpiWindow;
  month: { start: string; end: string };
  today: string;
  employees: readonly PhoenixEmployeeDates[];
  standards?: RepKpiStandards;
}): Promise<PhoenixKpiLoad> {
  const hasWindow = input.window.dateTo >= input.month.start;
  const [panelRows, planRows, visitRows, checkinRows, holidays] = await Promise.all([
    loadPanelRows(),
    scanPlanEntries(input.month.start, input.month.end),
    hasWindow
      ? queryVisits<VisitRecord>({
          dateFrom: input.month.start,
          dateTo: input.window.dateTo,
          columns: VISIT_COLUMNS,
          collapseDoubleVisits: true,
        })
      : Promise.resolve([] as VisitRecord[]),
    // Company-wide for the window, exactly as collect.ts reads it: correlation is by
    // agent+contact+day, so a wider read cannot leak a check-in into the wrong rep's credit.
    hasWindow
      ? queryCheckins<CheckinRecord>({
          dateFrom: input.month.start,
          dateTo: input.window.dateTo,
          columns: "agent_crm_id, agent_hr_id, contact_crm_id, check_date",
        })
      : Promise.resolve([] as CheckinRecord[]),
    loadCallRateHolidays(input.month.start, input.month.end),
  ]);

  // Rule 10 (owner, 2026-09-20): which Regular visits have a matching GPS check-in. The SAME
  // agent+contact+Cairo-day matcher every other CRM surface uses (checkin-match.ts) — a visit
  // resolves to the same check-in here as it does on the Visits Report and the CRM master tab. A
  // Phoenix CRM visit is its own check-in, exactly as the old call rate already counts it.
  const checkinIndex = indexCheckinsByAgentContactDay(checkinRows);
  const visitsWithCheckin = visitRows.map((row) => ({
    ...row,
    hasCheckin: phoenixVisitHasCheckin(
      row,
      pickCheckinForVisit(
        {
          agentCrmId: row.agent_crm_id,
          agentHrId: row.agent_hr_id,
          contactCrmId: row.contact_crm_id,
          visitDay: isoDay(row.visit_date),
          crmSaveDate: row.crm_save_date,
        },
        checkinIndex,
      ) !== null,
    ),
  }));

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
    bucket.push({
      contactCrmId: row.contact_crm_id,
      planDate: row.plan_date,
      grade: row.contact_grade,
      speciality: row.speciality,
      contactName: row.contact_name,
    });
    plansByRep.set(key, bucket);
  }

  const visitsByRep = new Map<string, PhoenixVisit[]>();
  for (const row of visitsWithCheckin) {
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

  // ONE input per rep for both readers, so the doctor list and the KPIs are scored from the same rows.
  const inputFor = (key: string): PhoenixRepInput => {
    const dates = datesByRep.get(key);
    return {
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
    };
  };

  const cache = new Map<string, PhoenixRepKpis>();
  const kpisFor = (hrKey: string | null): PhoenixRepKpis => {
    const key = canonicalHrIdKey(hrKey) ?? "";
    const cached = cache.get(key);
    if (cached) return cached;
    const computed = computePhoenixRepKpis(inputFor(key));
    cache.set(key, computed);
    return computed;
  };

  // Not cached: the Coverage tab asks for one rep per page load.
  const coverageDoctorsFor = (hrKey: string | null): PhoenixCoverageDoctor[] =>
    computePhoenixCoverageDoctors(inputFor(canonicalHrIdKey(hrKey) ?? ""));

  return { kpisFor, coverageDoctorsFor, holidaysComplete: holidays.complete };
}
