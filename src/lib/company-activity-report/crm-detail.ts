/**
 * CRM (iReports360) visit detail for the Company Activity Report — per employee, per day, every
 * visit with its display label and campaign flag, plus the same "regular > CP > AV" field/leave
 * classification the payroll digest engine uses (crmDayVisitTypeStatus), reused rather than
 * re-derived so this report can never disagree with it about what a given visit type means.
 *
 * Fetch strategy mirrors attendance/crm-day-maps.ts exactly: for a bounded roster, two pushdown
 * reads (as agent, as double) merged and deduped by id; above that threshold, one full-window
 * scan. Duplicate submissions (the same real stop saved twice by the mobile client) are collapsed
 * ONCE on the fully-merged set via the shared collapseDuplicateVisitSubmissions, so visit counts
 * here are accurate rather than inflated by client-side re-saves.
 */

import { collapseDuplicateVisitSubmissions, queryVisits, scanVisitsForRange } from "@/lib/crm/reads";
import { crmDayVisitTypeStatus } from "@/lib/attendance/crm-day-maps";
import { mergeDayMapVisitPages } from "@/lib/attendance/crm-day-maps";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isIsoDate } from "@/lib/attendance/working-days";
import { CAMPAIGN_TYPE, classifyVisit, resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import type { CompanyActivityVisitDetail } from "@/lib/company-activity-report/types";

type CrmDetailRow = {
  id: string;
  crm_visit_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  customer_name: string | null;
  contact_name: string | null;
  ampm: string | null;
  agent_hr_id: string | null;
  double_hr_id: string | null;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  double_crm_id: number | null;
  crm_save_date: string | null;
};

const CRM_DETAIL_COLUMNS =
  "id,crm_visit_id,visit_date,visit_type,visit_type_description,comment,customer_name,contact_name,ampm,agent_hr_id,double_hr_id,agent_crm_id,contact_crm_id,double_crm_id,crm_save_date";

/** Same threshold as attendance/crm-day-maps.ts — above this many distinct employees, a full
 * window scan is cheaper than per-employee pushdown reads. */
const CRM_DETAIL_PUSHDOWN_MAX_IDS = 40;

async function fetchCrmDetailVisits(dateFromIso: string, dateToIso: string, wantedIds: string[]): Promise<CrmDetailRow[]> {
  if (wantedIds.length > CRM_DETAIL_PUSHDOWN_MAX_IDS) {
    return scanVisitsForRange<CrmDetailRow>({ dateFrom: dateFromIso, dateTo: dateToIso, columns: CRM_DETAIL_COLUMNS });
  }
  const [asAgent, asDouble] = await Promise.all([
    queryVisits<CrmDetailRow>({ dateFrom: dateFromIso, dateTo: dateToIso, columns: CRM_DETAIL_COLUMNS, agentHrIds: wantedIds }),
    queryVisits<CrmDetailRow>({ dateFrom: dateFromIso, dateTo: dateToIso, columns: CRM_DETAIL_COLUMNS, doubleHrIds: wantedIds }),
  ]);
  return mergeDayMapVisitPages<CrmDetailRow>([asAgent, asDouble]);
}

function buildVisitDetail(row: CrmDetailRow): CompanyActivityVisitDetail {
  const classification = classifyVisit(row.visit_type, row.comment, row.visit_type_description);
  return {
    visitType: row.visit_type,
    label: resolveVisitTypeLabel(row.visit_type, row.visit_type_description, row.comment),
    bucket: classification.bucket,
    isCampaign: row.visit_type === CAMPAIGN_TYPE,
    session: row.ampm,
    contactName: row.contact_name,
    customerName: row.customer_name,
    comment: row.comment,
    attributionUncertain: !row.agent_hr_id && !row.double_hr_id,
  };
}

export type CompanyActivityCrmDay = {
  visits: CompanyActivityVisitDetail[];
  /** A regular visit or a CP-type activity won the day — same precedence as
   * attendance/crm-day-maps.ts's getCrmActivityDayMaps. */
  isFieldVisitDay: boolean;
  /** Only true when neither a regular visit nor a CP-type activity exists for the day, and an
   * Annual-Vacation (-4) entry does. */
  isLeaveDay: boolean;
};

export type CompanyActivityCrmResult = {
  /** Map<normalizeAttendanceHrId-keyed hrId, Map<dateIso, CompanyActivityCrmDay>>. */
  byEmployeeDay: Map<string, Map<string, CompanyActivityCrmDay>>;
  /** Visits in range with neither agent_hr_id nor double_hr_id resolved — a company-wide
   * attribution blind spot, only computed on the full-scan path where every in-range visit is
   * already in memory. Null (never a fabricated 0) on the pushdown path, which has no visibility
   * into visits outside the wanted id set. */
  unmappedCrmVisitCount: number | null;
};

export async function loadCompanyActivityCrmDetail(input: {
  employeeHrIds: string[];
  dateFromIso: string;
  dateToIso: string;
}): Promise<CompanyActivityCrmResult> {
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) {
    return { byEmployeeDay: new Map(), unmappedCrmVisitCount: null };
  }
  const wanted = new Set(
    input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value)),
  );
  if (wanted.size === 0) return { byEmployeeDay: new Map(), unmappedCrmVisitCount: null };

  const wantedIds = [...wanted];
  const isFullScan = wantedIds.length > CRM_DETAIL_PUSHDOWN_MAX_IDS;
  const rawVisits = await fetchCrmDetailVisits(input.dateFromIso, input.dateToIso, wantedIds);
  const visits = collapseDuplicateVisitSubmissions(rawVisits);

  const unmappedCrmVisitCount = isFullScan
    ? visits.filter((visit) => !visit.agent_hr_id && !visit.double_hr_id).length
    : null;

  const byEmployeeDate = new Map<string, Map<string, CrmDetailRow[]>>();
  for (const visit of visits) {
    const dateIso = (visit.visit_date ?? "").slice(0, 10);
    if (!dateIso) continue;
    // A visit counts for whoever it belongs to, as the primary agent or as a double.
    for (const rawHrId of [visit.agent_hr_id, visit.double_hr_id]) {
      const hrId = normalizeAttendanceHrId(rawHrId ?? "");
      if (!hrId || !wanted.has(hrId)) continue;
      const byDate = byEmployeeDate.get(hrId) ?? new Map<string, CrmDetailRow[]>();
      const list = byDate.get(dateIso) ?? [];
      list.push(visit);
      byDate.set(dateIso, list);
      byEmployeeDate.set(hrId, byDate);
    }
  }

  const byEmployeeDay = new Map<string, Map<string, CompanyActivityCrmDay>>();
  for (const [hrId, byDate] of byEmployeeDate) {
    const dayMap = new Map<string, CompanyActivityCrmDay>();
    for (const [dateIso, rows] of byDate) {
      let regularCount = 0;
      let hasCampaignType = false;
      let hasLeaveType = false;
      for (const row of rows) {
        const visitType = Number(row.visit_type ?? 0);
        if (visitType === 0) {
          regularCount += 1;
          continue;
        }
        const status = crmDayVisitTypeStatus(visitType);
        if (status === "CP") hasCampaignType = true;
        else if (status === "AV") hasLeaveType = true;
      }
      dayMap.set(dateIso, {
        visits: rows.map(buildVisitDetail),
        isFieldVisitDay: regularCount > 0 || hasCampaignType,
        isLeaveDay: regularCount === 0 && !hasCampaignType && hasLeaveType,
      });
    }
    byEmployeeDay.set(hrId, dayMap);
  }

  return { byEmployeeDay, unmappedCrmVisitCount };
}
