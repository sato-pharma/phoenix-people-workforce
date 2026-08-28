// ─────────────────────────────────────────────────────────────────────────────
// The reader half of the split call rate. Rules live in crm/call-rate.ts, which
// is pure; this file only fetches the rows and hands them over.
//
// Reads go through crm/reads.ts — the CRM mirror's single-source door, enforced
// by the "crm single-source door" test. That door also applies the departed-agent
// exclusion, so these totals reconcile with SFE analytics, DV Analytics and the
// CRM master tab rather than quietly counting reps who have left.
// ─────────────────────────────────────────────────────────────────────────────

import { computeCallRate, type CallRateReport, type VisitForCallRate } from "@/lib/crm/call-rate";
import { collapseDuplicateVisitSubmissions, queryCheckins, queryVisits } from "@/lib/crm/reads";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

const VISIT_COLUMNS =
  "agent_crm_id,agent_hr_id,agent_name,ampm,comment,contact_crm_id,crm_save_date,crm_visit_id,double_crm_id,visit_date,visit_type,visit_type_description";
const CHECKIN_COLUMNS = "agent_crm_id,contact_crm_id,check_date";

type CheckinRow = { agent_crm_id: number | null; contact_crm_id: number | null; check_date: string | null };

export type CallRateInput = {
  dateFrom: string;
  dateTo: string;
  /** Restrict to one rep by CRM agent id. Omit for the whole field force. */
  agentCrmId?: number | null;
  /** Overrides the owner's daily campaign limit of 3. Only for a caller that exposes the control. */
  campaignLimit?: number;
};

/** The split call rate for a period, per rep. */
export async function loadCallRateReport(input: CallRateInput): Promise<CallRateReport> {
  const [rawVisits, checkins] = await Promise.all([
    queryVisits<VisitForCallRate & { crm_visit_id: number | null; double_crm_id: number | null }>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: VISIT_COLUMNS,
    }),
    queryCheckins<CheckinRow>({ dateFrom: input.dateFrom, dateTo: input.dateTo, columns: CHECKIN_COLUMNS }),
  ]);

  // The same collapse every other CRM consumer applies, so this cannot disagree with the visit
  // count shown beside it on the same screen.
  const collapsed = collapseDuplicateVisitSubmissions(rawVisits);
  const visits =
    input.agentCrmId == null ? collapsed : collapsed.filter((visit) => visit.agent_crm_id === input.agentCrmId);
  const scopedCheckins =
    input.agentCrmId == null ? checkins : checkins.filter((checkin) => checkin.agent_crm_id === input.agentCrmId);

  return computeCallRate(visits, scopedCheckins, {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    campaignLimit: input.campaignLimit,
  });
}

/**
 * hr id (LOWER-cased) -> the person's real name, for a board that must never print a CRM login
 * handle. The CRM's own `agent_name` is a handle with a territory bolted on, so the directory is
 * the only place a real name exists; crm/reps-plans.ts does the joining.
 *
 * Inactive rows are included on purpose: a rep who left mid-month still has that month's visits on
 * the board and has to be named, not shown as a handle.
 *
 * `getEmployeeDirectoryRows` caches, so calling this beside loadCallRateReport costs no extra
 * round trip on a warm process.
 */
export async function loadRepNamesByHrId(): Promise<Map<string, string>> {
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const byHrId = new Map<string, string>();
  for (const employee of directory) {
    const hrId = employee.hrId.trim().toLowerCase();
    if (!hrId) continue;
    byHrId.set(hrId, employee.displayName || employee.fullName);
  }
  return byHrId;
}
