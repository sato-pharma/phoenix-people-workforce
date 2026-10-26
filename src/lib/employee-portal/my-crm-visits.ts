// Self-scoped CRM visit data for the employee portal's "My Visits" module.
//
// Deliberately NOT under src/lib/crm/ — this file only ever reads through the CRM
// "door" (src/lib/crm/reads.ts) with the caller's own hrId, never the admin
// company-wide master-table query path (src/lib/crm/master.ts). hrId is always a
// required, single, non-array function argument — never a filter-object field —
// so there is no field a future edit could leave unset or widen.
//
// ONE deliberate exception: fetchTeamVisits takes an explicit hrId SET, because a manager's tab is
// about other people by definition. It preserves the intent of the rule rather than breaking it —
// the set is a required positional argument the CALLER must resolve from their own subtree, it is
// never derived inside this file, and it FAILS CLOSED on an empty set. See its docstring.

import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { queryCheckins, queryVisits, queryVisitsLimited, resolveVisitTime } from "@/lib/crm/reads";
import type { VisitTimeSource } from "@/lib/crm/reads";
import { crmRepDisplayName } from "@/lib/crm/rep-name";
import { isFieldWorkVisit, resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { TEAM_VISIT_ROW_CAP } from "@/lib/employee-portal/my-crm-visits-constants";

export type MyCrmWindow = { dateFrom: string; dateTo: string };

type RawVisit = {
  id: string;
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  visit_date: string | null;
  ampm: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  contact_name: string | null;
  customer_name: string | null;
  double_name: string | null;
  comment: string | null;
  crm_save_date: string | null;
  crm_visit_id?: number | null;
  source?: string | null;
};

type RawDoubleVisit = {
  id: string;
  visit_date: string | null;
  ampm: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  contact_name: string | null;
  customer_name: string | null;
  agent_name: string | null;
  comment: string | null;
  crm_save_date: string | null;
  crm_visit_id?: number | null;
  source?: string | null;
};

/** A team row is a self row plus the primary agent's name — see {@link fetchTeamVisits}. */
type RawTeamVisit = RawVisit & { agent_name: string | null };

type RawCheckin = {
  id: string;
  check_date: string | null;
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  address: string | null;
};

export type MyCrmVisitRow = {
  id: string;
  visitDate: string | null;
  visitTime: string | null;
  visitTimeSource: VisitTimeSource;
  ampm: string | null;
  visitTypeDescription: string | null;
  contactName: string | null;
  customerName: string | null;
  doubleName: string | null;
  comment: string | null;
  /** A call (regular or campaign) rather than leave, a holiday, a meeting or training — the same
   *  split the KPI drill-down makes. See isFieldWorkVisit in crm/visit-types.ts. */
  fieldWork: boolean;
  /** A started Phoenix CRM team's own visit (crm/phoenix-team-starts.ts): its time is shown bare, with
   *  no GPS or "Logged" word — this page reaches the rep, who is never told his location is read
   *  (Phoenix CRM golden rule #1). Present only when true. */
  phoenixVisit?: boolean;
};

/** A subordinate's visit as a manager sees it: the self-visit shape plus whose visit it is. */
export type TeamCrmVisitRow = MyCrmVisitRow & { agentName: string | null };

export type MyCrmDoubleVisitRow = {
  id: string;
  visitDate: string | null;
  visitTime: string | null;
  ampm: string | null;
  visitTypeDescription: string | null;
  contactName: string | null;
  customerName: string | null;
  primaryAgentName: string | null;
  comment: string | null;
  /** As {@link MyCrmVisitRow.phoenixVisit}. */
  phoenixVisit?: boolean;
};

export type MyCrmCheckinRow = {
  id: string;
  checkDate: string | null;
  contactName: string | null;
  address: string | null;
};

// `crm_visit_id` and `source` say which rows are a started Phoenix CRM team's own (isPhoenixNativeVisitRow).
const VISIT_COLUMNS =
  "id,agent_crm_id,agent_hr_id,contact_crm_id,visit_date,ampm,visit_type,visit_type_description,contact_name,customer_name,double_name,comment,crm_save_date,crm_visit_id,source";
const DOUBLE_VISIT_COLUMNS =
  "id,visit_date,ampm,visit_type,visit_type_description,contact_name,customer_name,agent_name,comment,crm_save_date,crm_visit_id,source";
const TEAM_VISIT_COLUMNS = `${VISIT_COLUMNS},agent_name`;
// Imported (for fetchTeamVisits below) and re-exported (for existing server-side callers) from a
// client-safe module, so the "use client" workspace can read the cap without importing this
// server-only file — which reaches node:crypto via the employee directory. A bare
// `export { X } from "..."` would re-export without binding the name locally, so import + export.
export { TEAM_VISIT_ROW_CAP };
// `agent_hr_id` on both column lists: a rep with no CRM id matches his check-ins on it (checkin-match).
const CHECKIN_COLUMNS = "id,check_date,agent_crm_id,agent_hr_id,contact_crm_id,contact_name,address";

/** Newest day first, and inside a day the latest visit first; a visit with no known time goes last. */
function byVisitDateDesc(
  a: { visitDate: string | null; visitTime?: string | null },
  b: { visitDate: string | null; visitTime?: string | null },
): number {
  const byDay = (b.visitDate ?? "").slice(0, 10).localeCompare((a.visitDate ?? "").slice(0, 10));
  if (byDay !== 0) return byDay;
  const timeA = a.visitTime ? Date.parse(a.visitTime) : Number.NaN;
  const timeB = b.visitTime ? Date.parse(b.visitTime) : Number.NaN;
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) return Number.isNaN(timeA) ? (Number.isNaN(timeB) ? 0 : 1) : -1;
  return timeB - timeA;
}

/**
 * The caller's own raw check-ins for the window, SHARED WHILE IN FLIGHT (2026-10-01, "slow to
 * transfer between page and page"). The My Visits page asks for the same person's same 90 days twice
 * at once — {@link fetchMyVisits} for the GPS/Logged badge, {@link fetchMyCheckins} for the check-in
 * tab — so the second caller now waits on the first's read instead of running it again. Nothing is
 * kept once it settles, a failure included, and neither caller mutates the rows (one indexes them,
 * the other maps them into new objects), so sharing one array changes nothing either sees.
 */
const myCheckinsInFlight = new Map<string, Promise<RawCheckin[]>>();

function readMyCheckinRows(hrId: string, window: MyCrmWindow): Promise<RawCheckin[]> {
  const key = `${hrId}|${window.dateFrom}|${window.dateTo}`;
  const inFlight = myCheckinsInFlight.get(key);
  if (inFlight) return inFlight;
  const request: Promise<RawCheckin[]> = queryCheckins<RawCheckin>({
    agentHrIds: [hrId],
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    columns: CHECKIN_COLUMNS,
  }).finally(() => {
    if (myCheckinsInFlight.get(key) === request) myCheckinsInFlight.delete(key);
  });
  myCheckinsInFlight.set(key, request);
  return request;
}

/** The caller's own GPS check-in log — also used internally by {@link fetchMyVisits} to
 * resolve the GPS/Logged visit-time badge. */
export async function fetchMyCheckins(hrId: string, window: MyCrmWindow): Promise<MyCrmCheckinRow[]> {
  const rows = await readMyCheckinRows(hrId, window);
  return rows
    .map((row) => ({ address: row.address, checkDate: row.check_date, contactName: row.contact_name, id: row.id }))
    .sort((a, b) => (b.checkDate ?? "").localeCompare(a.checkDate ?? ""));
}

/** Visits the caller personally logged as the primary agent, with the same GPS/Logged
 * visit-time resolution the admin CRM master table uses (resolveVisitTime + the shared
 * checkin-match correlator — see src/lib/crm/checkin-match.ts), and the same duplicate
 * collapse as every other consumer of the CRM door. */
export async function fetchMyVisits(hrId: string, window: MyCrmWindow): Promise<MyCrmVisitRow[]> {
  const [visits, checkins] = await Promise.all([
    // collapseDoubleVisits routes through collapseDuplicateVisitSubmissions, the one place that
    // decides what a re-save is. Reading the raw mirror instead made "My Visits (N)" disagree with
    // the "Double Visits" tab beside it and with the portal Team Calendar, which both collapse —
    // one employee, one module, two different totals for the same day's work.
    queryVisits<RawVisit>({
      agentHrIds: [hrId],
      collapseDoubleVisits: true,
      columns: VISIT_COLUMNS,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
    }),
    // The same read fetchMyCheckins makes for the check-in tab — shared while in flight.
    readMyCheckinRows(hrId, window),
  ]);
  const index = indexCheckinsByAgentContactDay(checkins);
  const rows = visits.map((row): MyCrmVisitRow => {
    const match = pickCheckinForVisit(
      {
        agentCrmId: row.agent_crm_id,
          agentHrId: row.agent_hr_id,
        contactCrmId: row.contact_crm_id,
        crmSaveDate: row.crm_save_date,
        visitDay: row.visit_date ? row.visit_date.slice(0, 10) : null,
      },
      index,
    );
    const resolved = resolveVisitTime({ crmSaveDate: row.crm_save_date, nearestCheckinTime: match?.check_date ?? null });
    return {
      ampm: row.ampm,
      comment: row.comment,
      contactName: row.contact_name,
      customerName: row.customer_name,
      doubleName: crmRepDisplayName(row.double_name),
      fieldWork: isFieldWorkVisit(row.visit_type, row.comment, row.visit_type_description),
      id: row.id,
      visitDate: row.visit_date,
      visitTime: resolved.time,
      visitTimeSource: resolved.source,
      visitTypeDescription: resolveVisitTypeLabel(row.visit_type, row.visit_type_description, row.comment),
      ...(isPhoenixNativeVisitRow(row) ? { phoenixVisit: true } : {}),
    };
  });
  return rows.sort(byVisitDateDesc);
}

/**
 * Visits logged by the people a MANAGER is responsible for.
 *
 * This is the one function in this module that takes a SET of hrIds, so it is worth being explicit
 * about why that does not weaken the invariant in the file header. The set is never derived here: the
 * caller must resolve it from the viewer's own management subtree and pass it in, exactly the way the
 * page does. Two properties keep it safe:
 *
 *   - it FAILS CLOSED — an empty (or all-blank) set returns [] without touching the database, so a
 *     caller that forgets to resolve a subtree gets nothing rather than everything;
 *   - it still reads through the same CRM "door" (queryVisits) with an explicit agent list, never the
 *     admin company-wide master-table path.
 *
 * Rows carry `agentName` because a manager's list is only meaningful if you can tell whose visit each
 * row is — the self-scoped {@link fetchMyVisits} has no such column since every row is the caller's.
 * GPS/Logged resolution is identical to fetchMyVisits: the check-ins are fetched for the same agent
 * set, so each visit is correlated against its OWN agent's check-ins.
 */
export async function fetchTeamVisits(hrIds: string[], window: MyCrmWindow): Promise<TeamCrmVisitRow[]> {
  const agentHrIds = Array.from(
    new Set(hrIds.map((hrId) => String(hrId ?? "").trim()).filter((hrId) => hrId.length > 0)),
  );
  if (agentHrIds.length === 0) return [];

  const [visits, checkins, names] = await Promise.all([
    // Hard-capped, DB-ordered (newest first) — NOT the full-scan queryVisits the self tabs use.
    // A manager's set is one-to-two orders of magnitude larger than one person's: the live Regional
    // Manager's 17-person subtree logged 9,253 visits in a 90-day window, which rendered a 5.1 MB
    // payload in 43s before this cap. The UI paginates anyway, so shipping the whole history was
    // pure waste. TEAM_VISIT_ROW_CAP bounds the response; the tab tells the viewer when it is hit.
    queryVisitsLimited<RawTeamVisit>({
      agentHrIds,
      columns: TEAM_VISIT_COLUMNS,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      limit: TEAM_VISIT_ROW_CAP,
    }),
    queryCheckins<RawCheckin>({
      agentHrIds,
      columns: CHECKIN_COLUMNS,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
    }),
    // The rep's HR name: the CRM's agent_name is a login handle, and a few are a territory alone
    // ("( Alex Center 2 / P )"), which names nobody.
    namesByHrId(agentHrIds),
  ]);

  const index = indexCheckinsByAgentContactDay(checkins);
  return visits
    .map((row): TeamCrmVisitRow => {
      const match = pickCheckinForVisit(
        {
          agentCrmId: row.agent_crm_id,
          agentHrId: row.agent_hr_id,
          contactCrmId: row.contact_crm_id,
          crmSaveDate: row.crm_save_date,
          visitDay: row.visit_date ? row.visit_date.slice(0, 10) : null,
        },
        index,
      );
      const resolved = resolveVisitTime({ crmSaveDate: row.crm_save_date, nearestCheckinTime: match?.check_date ?? null });
      return {
        agentName: tidyAllCapitalsName(names.get(row.agent_hr_id) ?? "") || crmRepDisplayName(row.agent_name),
        ampm: row.ampm,
        comment: row.comment,
        contactName: row.contact_name,
        customerName: row.customer_name,
        doubleName: crmRepDisplayName(row.double_name),
        fieldWork: isFieldWorkVisit(row.visit_type, row.comment, row.visit_type_description),
        id: row.id,
        visitDate: row.visit_date,
        visitTime: resolved.time,
        visitTimeSource: resolved.source,
        visitTypeDescription: resolveVisitTypeLabel(row.visit_type, row.visit_type_description, row.comment),
        ...(isPhoenixNativeVisitRow(row) ? { phoenixVisit: true } : {}),
      };
    })
    .sort(byVisitDateDesc);
}

/** Visits where the caller was the accompanying "double" partner, not the primary agent.
 * Deliberately a separate function/tab from {@link fetchMyVisits} — never merged into the
 * same query — and deliberately has no GPS/Logged badge: correlating one would require
 * querying the PRIMARY agent's check-ins, which is out of this caller's own scope. The
 * visit time shown is the save-time tier only (crm_save_date), same as a visit with no
 * check-in match. */
export async function fetchMyDoubleVisits(hrId: string, window: MyCrmWindow): Promise<MyCrmDoubleVisitRow[]> {
  const rows = await queryVisits<RawDoubleVisit>({
    columns: DOUBLE_VISIT_COLUMNS,
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    doubleHrIds: [hrId],
    // Collapse burst-duplicate re-saves so the "Double Visits (N)" tab badge/list doesn't show the
    // same ride-along stop multiple times.
    collapseDoubleVisits: true,
  });
  return rows
    .map((row): MyCrmDoubleVisitRow => {
      const resolved = resolveVisitTime({ crmSaveDate: row.crm_save_date, nearestCheckinTime: null });
      return {
        ampm: row.ampm,
        comment: row.comment,
        contactName: row.contact_name,
        customerName: row.customer_name,
        id: row.id,
        primaryAgentName: crmRepDisplayName(row.agent_name),
        visitDate: row.visit_date,
        visitTime: resolved.time,
        visitTypeDescription: resolveVisitTypeLabel(row.visit_type, row.visit_type_description, row.comment),
        ...(isPhoenixNativeVisitRow(row) ? { phoenixVisit: true } : {}),
      };
    })
    .sort(byVisitDateDesc);
}
