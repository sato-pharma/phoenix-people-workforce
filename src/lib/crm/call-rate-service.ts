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
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
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

/**
 * The split call rate for a period, per rep, with national holidays already out of the denominator.
 *
 * `holidaysComplete` rides along rather than living on the pure {@link CallRateReport}, because it
 * describes the READ and not the arithmetic. A caller that prints a rate must surface it — false
 * means a public holiday may still be sitting in the denominator, which makes every rep look worse
 * than he is. See crm/call-rate-holidays.ts.
 */
export async function loadCallRateReport(
  input: CallRateInput,
): Promise<CallRateReport & { holidaysComplete: boolean }> {
  const [rawVisits, checkins, holidays] = await Promise.all([
    queryVisits<VisitForCallRate & { crm_visit_id: number | null; double_crm_id: number | null }>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: VISIT_COLUMNS,
    }),
    queryCheckins<CheckinRow>({ dateFrom: input.dateFrom, dateTo: input.dateTo, columns: CHECKIN_COLUMNS }),
    loadCallRateHolidays(input.dateFrom, input.dateTo),
  ]);

  // The same collapse every other CRM consumer applies, so this cannot disagree with the visit
  // count shown beside it on the same screen.
  const collapsed = collapseDuplicateVisitSubmissions(rawVisits);
  const visits =
    input.agentCrmId == null ? collapsed : collapsed.filter((visit) => visit.agent_crm_id === input.agentCrmId);
  const scopedCheckins =
    input.agentCrmId == null ? checkins : checkins.filter((checkin) => checkin.agent_crm_id === input.agentCrmId);

  const report = computeCallRate(visits, scopedCheckins, {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    campaignLimit: input.campaignLimit,
    holidays: holidays.dates,
  });
  return { ...report, holidaysComplete: holidays.complete };
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

/**
 * hr id (LOWER-cased) -> the person's HR job title, for anyone the SALES organogram has no seat for.
 *
 * `au_v_org_tree` is the sales seat model. It has no marketing branch, so a Product Manager holds no
 * seat in it and never will — B-155 (Product Manager), A-10 (Product Manager) and A-8 (Group Product
 * Manager) are all off it by design, verified against production 2026-08-28. Saying "not in
 * organogram" of such a person is technically true and reads as an accusation, which is exactly what
 * the owner objected to when the first build of this board said it of his District Managers.
 *
 * So the directory answers when the organogram is silent. It supplies a LABEL only — the organogram
 * still decides who carries the 2 AM / 10 PM target, because a job title is free text and a KPI
 * denominator built on it would move the moment somebody fixed a spelling.
 *
 * Same cached `getEmployeeDirectoryRows` call as the names above, so this costs no extra round trip.
 */
export async function loadJobTitlesByHrId(): Promise<Map<string, string>> {
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const byHrId = new Map<string, string>();
  for (const employee of directory) {
    const hrId = employee.hrId.trim().toLowerCase();
    const jobTitle = (employee.jobTitle ?? "").trim();
    if (!hrId || !jobTitle) continue;
    byHrId.set(hrId, jobTitle);
  }
  return byHrId;
}
