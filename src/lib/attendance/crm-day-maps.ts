// CRM-aware day maps for the weekly-digest reconciliation gate (see
// digest-reconcile.ts). Owner-confirmed addendum (2026-07-21): the digest
// engine previously only checked Phoenix's own vacation_requests/
// excuse_requests tables and (Tier-2 only) the weekly plan -- it had no
// awareness of CRM (iReports360) at all, so a day covered only by a
// CRM-recorded leave, or explained only by a real CRM field visit, was judged
// purely on device-punch timing. This module reads through the sanctioned CRM
// door (scanVisitsForRange) once per digest week and classifies each active
// employee's days using the SAME three-tier precedence as dayCellValue
// (field-workforce-compliance/ireports360-source.ts) and the leaver CRM
// classifier (automated-payroll/recommend.ts): a real regular visit always
// wins (proves a genuine field day); otherwise a CP-type entry (Conference,
// Group Meeting, Campaign, Training, Meeting, Traveling) ALSO counts as a
// legitimate field day — owner-confirmed 2026-07-21 after a post-settlement
// audit found two employees deducted on days they'd logged a real Campaign/
// Meeting visit — matching the precedent already used in those two other
// places rather than silently diverging from it; only when neither a regular
// nor a CP-type visit exists does an Annual-Vacation/Health-Day entry count
// as CRM-recorded leave.

import { scanVisitsForRange } from "@/lib/crm/reads";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isIsoDate } from "@/lib/attendance/working-days";

/** iReports360 visit types that represent a leave day, not a field visit — mirrors
 * the AV half of VISIT_TYPE_TO_STATUS / LEAVER_VISIT_TYPE_TO_STATUS (Annual
 * Vacation, Health Day). */
const CRM_LEAVE_VISIT_TYPES = new Set<number>([-4, -15]);

/** iReports360 visit types that represent a real (non-desk) work activity that
 * isn't a plain customer visit — mirrors the CP half of VISIT_TYPE_TO_STATUS /
 * LEAVER_VISIT_TYPE_TO_STATUS (Conference, Group Meeting, Campaign/Prospection,
 * Training, Meeting, Traveling). Treated identically to a regular visit for
 * this module's purposes: proof the employee was doing real field/CRM-logged
 * work that day, same "regular > CP > AV" precedence as dayCellValue. */
const CRM_CAMPAIGN_VISIT_TYPES = new Set<number>([-1, -2, -8, -9, -11, -12]);

type CrmDayVisitRow = {
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  customer_name: string | null;
  agent_hr_id: string | null;
  double_hr_id: string | null;
};

/** Short human-readable label for the CRM entry that won a day (regular > CP > AV, same
 * precedence as the classification loop below) — so a consumer showing "CRM field visit" can
 * also show WHAT it was (e.g. "Meeting: Digital marketing meeting") instead of a bare boolean. */
function describeCrmDay(rows: CrmDayVisitRow[]): string | null {
  const regular = rows.find((row) => Number(row.visit_type ?? 0) === 0);
  const campaign = rows.find((row) => CRM_CAMPAIGN_VISIT_TYPES.has(Number(row.visit_type ?? 0)));
  const leave = rows.find((row) => CRM_LEAVE_VISIT_TYPES.has(Number(row.visit_type ?? 0)));
  const winner = regular ?? campaign ?? leave;
  if (!winner) return null;
  const label = winner.visit_type_description?.trim() || (regular ? "Visit" : null);
  const detail = (winner.customer_name?.trim() || winner.comment?.trim() || "").slice(0, 120);
  if (!label) return detail || null;
  return detail ? `${label}: ${detail}` : label;
}

async function scanCompanyVisitsByEmployee(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds: string[];
}): Promise<Map<string, Map<string, CrmDayVisitRow[]>>> {
  const result = new Map<string, Map<string, CrmDayVisitRow[]>>();
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) return result;

  const wanted = new Set(
    input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value)),
  );
  if (wanted.size === 0) return result;

  const visits = await scanVisitsForRange<CrmDayVisitRow>({
    dateFrom: input.dateFromIso,
    dateTo: input.dateToIso,
    columns: "visit_date,visit_type,visit_type_description,comment,customer_name,agent_hr_id,double_hr_id",
  });

  for (const visit of visits) {
    const dateIso = (visit.visit_date ?? "").slice(0, 10);
    if (!dateIso) continue;
    // A visit counts for whoever it belongs to, whether as the primary agent
    // or as a double — either role means the employee was genuinely present.
    for (const rawHrId of [visit.agent_hr_id, visit.double_hr_id]) {
      const hrId = normalizeAttendanceHrId(rawHrId ?? "");
      if (!hrId || !wanted.has(hrId)) continue;
      const byDate = result.get(hrId) ?? new Map<string, CrmDayVisitRow[]>();
      const list = byDate.get(dateIso) ?? [];
      list.push(visit);
      byDate.set(dateIso, list);
      result.set(hrId, byDate);
    }
  }
  return result;
}

export type CrmActivityDayMaps = {
  /** Map<employeeHrId, Set<dateIso>> of CRM-recorded leave days (universal cancel in reconcileDay). */
  leaveMap: Map<string, Set<string>>;
  /** Map<employeeHrId, Set<dateIso>> of days with a real CRM field visit — a regular visit or a
   * CP-type activity (universal cancel in reconcileDay). */
  fieldVisitMap: Map<string, Set<string>>;
  /** Map<employeeHrId, Map<dateIso, string>> — a short label describing the winning CRM entry for
   * every date present in leaveMap/fieldVisitMap, for display only (never a branching key). */
  detailMap: Map<string, Map<string, string>>;
};

/**
 * Classifies every active employee's CRM activity for a digest week into two
 * day-sets in a single scan: real field-visit days (a regular visit OR a
 * CP-type activity — Conference/Meeting/Campaign/Training/Traveling — wins the
 * day, same "regular > CP > AV" precedence as dayCellValue/computeLeaverCrmDates)
 * and CRM-recorded leave days (Annual Vacation / Health Day, only on a day with
 * neither a regular visit nor a CP-type activity). Both feed reconcileDay as
 * universal cancels.
 */
export async function getCrmActivityDayMaps(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds: string[];
}): Promise<CrmActivityDayMaps> {
  const byEmployee = await scanCompanyVisitsByEmployee(input);
  const leaveMap = new Map<string, Set<string>>();
  const fieldVisitMap = new Map<string, Set<string>>();
  const detailMap = new Map<string, Map<string, string>>();

  for (const [hrId, byDate] of byEmployee) {
    const leaveDates = new Set<string>();
    const fieldDates = new Set<string>();
    const dayDetails = new Map<string, string>();
    for (const [dateIso, rows] of byDate) {
      let regularCount = 0;
      let hasCampaignType = false;
      let hasLeaveType = false;
      for (const row of rows) {
        const visitType = Number(row.visit_type ?? 0);
        if (visitType === 0) regularCount += 1;
        else if (CRM_CAMPAIGN_VISIT_TYPES.has(visitType)) hasCampaignType = true;
        else if (CRM_LEAVE_VISIT_TYPES.has(visitType)) hasLeaveType = true;
      }
      if (regularCount > 0 || hasCampaignType) fieldDates.add(dateIso);
      else if (hasLeaveType) leaveDates.add(dateIso);
      else continue;
      const detail = describeCrmDay(rows);
      if (detail) dayDetails.set(dateIso, detail);
    }
    if (leaveDates.size > 0) leaveMap.set(hrId, leaveDates);
    if (fieldDates.size > 0) fieldVisitMap.set(hrId, fieldDates);
    if (dayDetails.size > 0) detailMap.set(hrId, dayDetails);
  }

  return { detailMap, fieldVisitMap, leaveMap };
}
