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
import { loadCallRateHolidays, type CallRateHolidayLookup } from "@/lib/crm/call-rate-holidays";
import { getCrmCutoverSetting, NO_CRM_CUTOVER } from "@/lib/crm/cutover";
import { kpiRulesFor, phoenixRuleRepKeys } from "@/lib/crm/phoenix-kpi-rules";
import { loadStartedRepWindows } from "@/lib/crm/phoenix-started-reps";
import type { StartedRepWindow } from "@/lib/crm/phoenix-team-starts";
import { collapseDuplicateVisitSubmissions, queryCheckins, queryVisits } from "@/lib/crm/reads";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";

// `crm_visit_id` and `phoenix_customer_validated` are what the rate reads off a Phoenix CRM row: the
// first marks it as one (it proves itself), the second keeps a visit to a customer not validated yet
// out of the rate (crm/phoenix-team-starts.ts; the migration adding it is applied before this ships).
const VISIT_COLUMNS =
  "agent_crm_id,agent_hr_id,agent_name,ampm,comment,contact_crm_id,crm_save_date,crm_visit_id,double_crm_id,phoenix_customer_validated,speciality,visit_date,visit_type,visit_type_description";
// `agent_hr_id` is what matches a check-in to the visit of a rep hired after the CRM cutover: both
// carry a NULL CRM id, so without it every one of his visits reads as unproved.
const CHECKIN_COLUMNS = "agent_crm_id,agent_hr_id,contact_crm_id,check_date";

type CheckinRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  check_date: string | null;
};

export type CallRateInput = {
  dateFrom: string;
  dateTo: string;
  /** Restrict to one rep by CRM agent id. Omit (with `agentHrId`) for the whole field force. */
  agentCrmId?: number | null;
  /** Restrict to one rep hired after the CRM cutover, who has no CRM id. Read only when `agentCrmId` is null. */
  agentHrId?: string | null;
  /** Overrides the owner's daily campaign limit of 3. Only for a caller that exposes the control. */
  campaignLimit?: number;
  /**
   * The holiday lookup for these same dates, when the caller has already read it — the visits page
   * reads it once and hands the SAME set to the rate and to the visit list, so a holiday can never
   * be out of one and in the other. Omitted, the report reads its own.
   */
  holidays?: CallRateHolidayLookup;
  /**
   * Read only these reps' visits and check-ins, by either id — the KPIs board's narrowing for a
   * scope of a few people (crm/kpi-board-agents.ts says how the ids are chosen, and why the rows are
   * then exactly the ones the whole-field-force read gives those reps). Every rate is still computed
   * per rep by the same code from the same rows; this only stops reading everyone else's month.
   * Omitted, the whole field force is read as before.
   */
  agents?: { crmIds: readonly number[]; hrIds: readonly string[] };
  /**
   * Opt-in, DISPLAY callers only: a whole-company window (no `agents`) may come from a copy up to a
   * minute old, shared by every viewer of the same window (crm/reads.ts, "A dashboard may reuse a
   * company window"). Each viewer's scope is still applied to those rows afterwards, so the copy holds
   * company rows, never one viewer's board. Never for a read that decides money, a deduction, an
   * approval or a notification. A read narrowed to `agents` always reads live.
   */
  reuseRecentWindow?: boolean;
  /** Who is counted from Phoenix CRM, when the caller is already reading it — the KPIs board. Omitted, the
   * report reads its own. */
  startedWindows?: Promise<StartedRepWindow[]>;
};

/**
 * Narrows the rows to one rep, or hands them back whole when no rep is named.
 *
 * A rep with a CRM id is matched on it exactly as before. A rep hired after the CRM cutover has none,
 * so his native visits and check-ins are matched on the CANONICAL hr id instead — never a raw
 * equality, because hr ids are stored in mixed case and a plain `===` would under-return.
 */
export function scopeCallRateRows<
  V extends { agent_crm_id: number | null; agent_hr_id: string | null },
  C extends { agent_crm_id: number | null; agent_hr_id?: string | null },
>(
  visits: readonly V[],
  checkins: readonly C[],
  rep: { agentCrmId?: number | null; agentHrId?: string | null },
): { visits: V[]; checkins: C[] } {
  const crmId = rep.agentCrmId;
  if (crmId != null) {
    return {
      visits: visits.filter((visit) => visit.agent_crm_id === crmId),
      checkins: checkins.filter((checkin) => checkin.agent_crm_id === crmId),
    };
  }
  const hrKey = canonicalHrIdKey(rep.agentHrId);
  if (!hrKey) return { visits: [...visits], checkins: [...checkins] };
  return {
    visits: visits.filter((visit) => canonicalHrIdKey(visit.agent_hr_id) === hrKey),
    checkins: checkins.filter((checkin) => canonicalHrIdKey(checkin.agent_hr_id) === hrKey),
  };
}

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
  // The duplicate collapse below keys on the agent's CRM id, and the rate matches a check-in to a
  // visit of the SAME agent, so neither ever looks across reps: these reps' rows give these reps'
  // figures whether or not anyone else's month was read beside them.
  const narrowTo = input.agents ? { agentCrmOrHrIds: { crmIds: input.agents.crmIds, hrIds: input.agents.hrIds } } : {};
  const reuseRecentWindow = input.reuseRecentWindow === true;
  const [rawVisits, checkins, holidays, cutover, startedWindows] = await Promise.all([
    queryVisits<VisitForCallRate & { crm_visit_id: number | null; double_crm_id: number | null }>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: VISIT_COLUMNS,
      reuseRecentWindow,
      // Counts visits: only the rows that count (counts_in_kpi — never a campaign, archived or uncounted copied old visit).
      kpiOnly: true,
      ...narrowTo,
    }),
    queryCheckins<CheckinRow>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: CHECKIN_COLUMNS,
      reuseRecentWindow,
      ...narrowTo,
    }),
    input.holidays ?? loadCallRateHolidays(input.dateFrom, input.dateTo),
    // Phase 6: from the CRM cutover every submitted regular visit counts. With no date set, or an
    // unreadable setting, this answers the old rule and nothing on any screen moves.
    getCrmCutoverSetting().catch(() => NO_CRM_CUTOVER),
    // THE SWITCH IS PER GO-LIVE TEAM (owner, 2026-10-07). The global cutover date above is still null
    // and a team start never sets it, so asking it alone judged a started rep's submitted visits
    // against the vendor's GPS rule. Fails OPEN — an unreadable answer is "no started team", which
    // leaves every row exactly where it was.
    input.startedWindows ?? loadStartedRepWindows(),
  ]);
  const rules = kpiRulesFor(cutover, input.dateFrom, input.dateTo);
  // Per rep, so one report can hold both rules: his team's go-live decides his row.
  const phoenixBasisHrKeys = phoenixRuleRepKeys(startedWindows, input.dateFrom);

  // The same collapse every other CRM consumer applies, so this cannot disagree with the visit
  // count shown beside it on the same screen.
  const collapsed = collapseDuplicateVisitSubmissions(rawVisits);
  const { visits, checkins: scopedCheckins } = scopeCallRateRows(collapsed, checkins, input);

  const report = computeCallRate(visits, scopedCheckins, {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    campaignLimit: input.campaignLimit,
    holidays: holidays.dates,
    basis: rules.rules === "phoenix" ? "submitted" : "verified",
    phoenixBasisHrKeys,
  });
  return { ...report, basisNote: rules.note, holidaysComplete: holidays.complete };
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
