// Self-scoped CRM visit data for the employee portal's "My Visits" module.
//
// Deliberately NOT under src/lib/crm/ — this file only ever reads through the CRM
// "door" (src/lib/crm/reads.ts) with the caller's own hrId, never the admin
// company-wide master-table query path (src/lib/crm/master.ts). hrId is always a
// required, single, non-array function argument — never a filter-object field —
// so there is no field a future edit could leave unset or widen.

import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { queryCheckins, queryVisits, resolveVisitTime } from "@/lib/crm/reads";
import type { VisitTimeSource } from "@/lib/crm/reads";

export type MyCrmWindow = { dateFrom: string; dateTo: string };

type RawVisit = {
  id: string;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  visit_date: string | null;
  ampm: string | null;
  visit_type_description: string | null;
  contact_name: string | null;
  customer_name: string | null;
  double_name: string | null;
  comment: string | null;
  crm_save_date: string | null;
};

type RawJointVisit = {
  id: string;
  visit_date: string | null;
  ampm: string | null;
  visit_type_description: string | null;
  contact_name: string | null;
  customer_name: string | null;
  agent_name: string | null;
  comment: string | null;
  crm_save_date: string | null;
};

type RawCheckin = {
  id: string;
  check_date: string | null;
  agent_crm_id: number | null;
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
};

export type MyCrmJointVisitRow = {
  id: string;
  visitDate: string | null;
  visitTime: string | null;
  ampm: string | null;
  visitTypeDescription: string | null;
  contactName: string | null;
  customerName: string | null;
  primaryAgentName: string | null;
  comment: string | null;
};

export type MyCrmCheckinRow = {
  id: string;
  checkDate: string | null;
  contactName: string | null;
  address: string | null;
};

const VISIT_COLUMNS =
  "id,agent_crm_id,contact_crm_id,visit_date,ampm,visit_type_description,contact_name,customer_name,double_name,comment,crm_save_date";
const JOINT_VISIT_COLUMNS =
  "id,visit_date,ampm,visit_type_description,contact_name,customer_name,agent_name,comment,crm_save_date";
const CHECKIN_COLUMNS = "id,check_date,agent_crm_id,contact_crm_id,contact_name,address";

function byVisitDateDesc(a: { visitDate: string | null }, b: { visitDate: string | null }): number {
  return (b.visitDate ?? "").localeCompare(a.visitDate ?? "");
}

/** The caller's own GPS check-in log — also used internally by {@link fetchMyVisits} to
 * resolve the GPS/Logged visit-time badge. */
export async function fetchMyCheckins(hrId: string, window: MyCrmWindow): Promise<MyCrmCheckinRow[]> {
  const rows = await queryCheckins<RawCheckin>({
    agentHrIds: [hrId],
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    columns: CHECKIN_COLUMNS,
  });
  return rows
    .map((row) => ({ address: row.address, checkDate: row.check_date, contactName: row.contact_name, id: row.id }))
    .sort((a, b) => (b.checkDate ?? "").localeCompare(a.checkDate ?? ""));
}

/** Visits the caller personally logged as the primary agent, with the same GPS/Logged
 * visit-time resolution the admin CRM master table uses (resolveVisitTime + the shared
 * checkin-match correlator — see src/lib/crm/checkin-match.ts). */
export async function fetchMyVisits(hrId: string, window: MyCrmWindow): Promise<MyCrmVisitRow[]> {
  const [visits, checkins] = await Promise.all([
    queryVisits<RawVisit>({ agentHrIds: [hrId], columns: VISIT_COLUMNS, dateFrom: window.dateFrom, dateTo: window.dateTo }),
    queryCheckins<RawCheckin>({ agentHrIds: [hrId], columns: CHECKIN_COLUMNS, dateFrom: window.dateFrom, dateTo: window.dateTo }),
  ]);
  const index = indexCheckinsByAgentContactDay(checkins);
  const rows = visits.map((row): MyCrmVisitRow => {
    const match = pickCheckinForVisit(
      {
        agentCrmId: row.agent_crm_id,
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
      doubleName: row.double_name,
      id: row.id,
      visitDate: row.visit_date,
      visitTime: resolved.time,
      visitTimeSource: resolved.source,
      visitTypeDescription: row.visit_type_description,
    };
  });
  return rows.sort(byVisitDateDesc);
}

/** Visits where the caller was the accompanying "double" partner, not the primary agent.
 * Deliberately a separate function/tab from {@link fetchMyVisits} — never merged into the
 * same query — and deliberately has no GPS/Logged badge: correlating one would require
 * querying the PRIMARY agent's check-ins, which is out of this caller's own scope. The
 * visit time shown is the save-time tier only (crm_save_date), same as a visit with no
 * check-in match. */
export async function fetchMyJointVisits(hrId: string, window: MyCrmWindow): Promise<MyCrmJointVisitRow[]> {
  const rows = await queryVisits<RawJointVisit>({
    columns: JOINT_VISIT_COLUMNS,
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    doubleHrIds: [hrId],
  });
  return rows
    .map((row): MyCrmJointVisitRow => {
      const resolved = resolveVisitTime({ crmSaveDate: row.crm_save_date, nearestCheckinTime: null });
      return {
        ampm: row.ampm,
        comment: row.comment,
        contactName: row.contact_name,
        customerName: row.customer_name,
        id: row.id,
        primaryAgentName: row.agent_name,
        visitDate: row.visit_date,
        visitTime: resolved.time,
        visitTypeDescription: row.visit_type_description,
      };
    })
    .sort(byVisitDateDesc);
}
