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
import { KPI_NARROW_MAX_CRM_IDS, resolveKpiBoardAgents, type KpiBoardAgents } from "@/lib/crm/kpi-board-agents";
import { queryCheckins, queryVisits } from "@/lib/crm/reads";
import { inPlanEntryOrder, scanPlanEntries } from "@/lib/crm/rep-doctor-lists";
import { loadPanelRows, narrowListType } from "@/lib/crm/rep-kpi-reports-data";
import type { RepKpiStandards } from "@/lib/crm/rep-kpi-reports";
import { canonicalHrIdKey, hrIdAliasSources } from "@/lib/hr-id";

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

/** The contact list's CRM id → rep map that places a plan or visit row with no hr id. Built over EVERY
 * open assignment, the last one for a CRM id winning, exactly as the loader has always built it.
 * Pure, exported for its test. */
export function phoenixHrKeyByCrmId(panelRows: readonly { agent_crm_id: number | null; agent_hr_id: string | null }[]): Map<number, string> {
  const hrKeyByCrmId = new Map<number, string>();
  for (const row of panelRows) {
    const key = canonicalHrIdKey(row.agent_hr_id);
    if (!key) continue;
    if (row.agent_crm_id != null) hrKeyByCrmId.set(row.agent_crm_id, key);
  }
  return hrKeyByCrmId;
}

/** Whose row this is: its own hr id, else the rep the contact list gives its CRM id. Pure, exported
 * for its test. */
export function phoenixRowKey(hrKeyByCrmId: ReadonlyMap<number, string>, hrId: string | null, crmId: number | null): string | null {
  return canonicalHrIdKey(hrId) ?? (crmId != null ? (hrKeyByCrmId.get(crmId) ?? null) : null);
}

// ── A scope of a few reps reads only their rows (2026-10-23) ───────────────────────────────────
// 🔴 WHY. This loader read the WHOLE company's month of plans, visits and check-ins on every KPIs board
// load, then kept the rows of the reps its viewer may see. Each company-wide window is read one day per
// request (reads.ts, "Company-wide date-range scans"), so one load was about 66 requests to the unified
// views, every one of which rebuilds every Phoenix entry day (phoenix_crm_rep_entry_days) before it
// filters. Measured on production 2026-10-23: a single day's visit request 150 ms at night and a mean of
// 270–420 ms by day, those views the top database time since the 22 Oct 14:25 Cairo restart, and calls
// to the visits view 2.8× their morning rate in the 22 Oct stall. A medical rep's landing tile asks this
// board for his own row. The board's doctor-list half was narrowed for the same reason on 2026-10-01
// (kpi-board-agents.ts); this half never was.
//
// WHY THESE ARE THE SAME ROWS. A row counts for a rep when `phoenixRowKey` names him. So the read keeps:
//   · every row carrying an in-scope hr id (any casing, any legacy alias) — the hr-id half;
//   · every row of a CRM id the contact list gives an in-scope rep — the rows with no hr id;
//   · every row of a CRM id an in-scope rep's own visit or plan carries in the month (the discovery of
//     kpi-board-agents.ts) — so the duplicate collapse, which keys on the agent, sees all of that
//     agent's rows, and every check-in a scoped visit can match (`checkinAgentKey`: its CRM id, else
//     its hr id) is in the read.
// Rows of other people the CRM-id half lets through are dropped by the same scope gate as before.
// Bounded like the doctor-list half (KPI_NARROW_MAX_PEOPLE / KPI_NARROW_MAX_CRM_IDS), and a discovery
// that fails reads company-wide: slower, never wrong.

export type PhoenixKpiNarrowing = { crmIds: number[]; hrIds: string[] };

export async function narrowPhoenixKpiReads(
  input: {
    scope: DoctorCoverageScope;
    window: { from: string; to: string };
    panelRows: readonly { agent_crm_id: number | null; agent_hr_id: string | null }[];
  },
  /** Injected only by the test — production discovers through the CRM doors. */
  discover: (scope: DoctorCoverageScope, window: { from: string; to: string }) => Promise<KpiBoardAgents | null> = resolveKpiBoardAgents,
): Promise<PhoenixKpiNarrowing | null> {
  if (input.scope.kind !== "agents") return null;
  const agents = await discover(input.scope, input.window);
  if (!agents) return null;
  if (agents.hrIds.length === 0) return { crmIds: [], hrIds: [] };
  const crmIds = new Set(agents.crmIds);
  for (const [crmId, key] of phoenixHrKeyByCrmId(input.panelRows)) {
    if (isAgentInScope(input.scope, key)) crmIds.add(crmId);
  }
  if (crmIds.size > KPI_NARROW_MAX_CRM_IDS) return null;
  const hrIds = new Set<string>();
  for (const hrId of agents.hrIds) {
    hrIds.add(hrId);
    for (const alias of hrIdAliasSources(hrId)) hrIds.add(alias);
  }
  return { crmIds: [...crmIds].sort((left, right) => left - right), hrIds: [...hrIds] };
}

export async function loadPhoenixRepKpis(input: {
  scope: DoctorCoverageScope;
  window: PhoenixKpiWindow;
  month: { start: string; end: string };
  today: string;
  employees: readonly PhoenixEmployeeDates[];
  standards?: RepKpiStandards;
  /** Read only the scope's reps when it is a few people (see above). The KPIs board passes false for
   * its Coverage tab, which keeps the company-wide read exactly as its doctor-list half does. */
  narrowToScope?: boolean;
  /** Opt-in, DISPLAY readers only: the company-wide visits and check-ins may come from the shared copy up
   * to a minute old (crm/reads.ts, "A dashboard may reuse a company window"). Defaults OFF, so the system
   * audit and any future reader that decides money read live; a narrowed read names people and never shares. */
  reuseRecentWindow?: boolean;
}): Promise<PhoenixKpiLoad> {
  const reuseRecentWindow = input.reuseRecentWindow === true;
  const hasWindow = input.window.dateTo >= input.month.start;
  const [panelRows, holidays] = await Promise.all([
    loadPanelRows(),
    loadCallRateHolidays(input.month.start, input.month.end),
  ]);
  const narrowed = input.narrowToScope
    ? await narrowPhoenixKpiReads({
        scope: input.scope,
        window: {
          from: input.month.start,
          to: input.window.dateTo > input.month.end ? input.window.dateTo : input.month.end,
        },
        panelRows,
      })
    : null;
  const people = narrowed ? { agentCrmOrHrIds: { crmIds: narrowed.crmIds, hrIds: narrowed.hrIds } } : {};
  const [planRows, visitRows, checkinRows] = await Promise.all([
    narrowed
      ? // Two passes (CRM ids, then hr ids) come back one after the other; the company-wide read
        // comes back in entry-id order, so the union is put back into it.
        scanPlanEntries(input.month.start, input.month.end, { agentCrmIds: narrowed.crmIds, agentHrIds: narrowed.hrIds }).then(inPlanEntryOrder)
      : scanPlanEntries(input.month.start, input.month.end),
    hasWindow
      ? queryVisits<VisitRecord>({
          dateFrom: input.month.start,
          dateTo: input.window.dateTo,
          columns: VISIT_COLUMNS,
          collapseDoubleVisits: true,
          reuseRecentWindow,
          ...people,
        })
      : Promise.resolve([] as VisitRecord[]),
    // Company-wide for the window, exactly as collect.ts reads it: correlation is by
    // agent+contact+day, so a wider read cannot leak a check-in into the wrong rep's credit. A
    // narrowed read keeps every check-in a scoped visit can match (see above).
    hasWindow
      ? queryCheckins<CheckinRecord>({
          dateFrom: input.month.start,
          dateTo: input.window.dateTo,
          columns: "agent_crm_id, agent_hr_id, contact_crm_id, check_date",
          reuseRecentWindow,
          ...people,
        })
      : Promise.resolve([] as CheckinRecord[]),
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
  const hrKeyByCrmId = phoenixHrKeyByCrmId(panelRows);
  const panelByRep = new Map<string, PhoenixPanelContact[]>();
  for (const row of panelRows) {
    const key = canonicalHrIdKey(row.agent_hr_id);
    if (!key) continue;
    if (!isAgentInScope(input.scope, row.agent_hr_id)) continue;
    const listType = narrowListType(row.list_type);
    if (!listType || row.contact_crm_id == null) continue;
    const bucket = panelByRep.get(key) ?? [];
    bucket.push({ contactCrmId: row.contact_crm_id, listType, grade: row.contact_grade });
    panelByRep.set(key, bucket);
  }

  const keyOf = (hrId: string | null, crmId: number | null): string | null => phoenixRowKey(hrKeyByCrmId, hrId, crmId);

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

  // Not cached: the Coverage and Frequency tabs ask once per rep on screen per page load (the team's
  // brick table reads every list), and each call reads only that rep's own buckets.
  const coverageDoctorsFor = (hrKey: string | null): PhoenixCoverageDoctor[] =>
    computePhoenixCoverageDoctors(inputFor(canonicalHrIdKey(hrKey) ?? ""));

  return { kpisFor, coverageDoctorsFor, holidaysComplete: holidays.complete };
}
