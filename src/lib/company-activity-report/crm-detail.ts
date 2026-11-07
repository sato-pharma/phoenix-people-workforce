/**
 * CRM visit detail for the Company Activity Report — Phoenix CRM visits through the unified read doors
 * (iReports360 rows only from before a team started on Phoenix CRM) — per employee, per day, every
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
import {
  PHOENIX_VISIT_DETAIL_COLUMNS,
  phoenixRowSight,
  phoenixVisitDetail,
  type PhoenixDetailSight,
  type PhoenixDetailViewer,
  type PhoenixVisitDetailRow,
} from "@/lib/crm/phoenix-visit-detail";
import { isIsoDate } from "@/lib/attendance/working-days";
import { classifyVisit, resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import { isUnplannedFieldVisit } from "@/lib/crm/visit-type-meaning";
import type { CompanyActivityVisitDetail } from "@/lib/company-activity-report/types";

export type CrmDetailRow = {
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
  double2_hr_id: string | null;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  double_crm_id: number | null;
  crm_save_date: string | null;
  /** A chain visit's second manager's NAME — `double2_hr_id` above is the id, which is never shown. */
  double2_name?: string | null;
} & PhoenixVisitDetailRow;

const CRM_DETAIL_COLUMNS =
  "id,crm_visit_id,visit_date,visit_type,visit_type_description,comment,customer_name,contact_name,ampm," +
  "agent_hr_id,double_hr_id,double2_hr_id,double2_name,agent_crm_id,contact_crm_id,double_crm_id,crm_save_date," +
  // THE PHOENIX FIELD SET. Selected unconditionally and printed only at the tier the reader earns: a
  // select is a string, so a list that varied by role would read `undefined` and print a blank, which
  // is indistinguishable from a visit that recorded nothing.
  PHOENIX_VISIT_DETAIL_COLUMNS.replaceAll(" ", "");

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

/** `sight` is null when the caller named no reader: the row then carries NO Phoenix detail at all.
 *  That is not the same as the `none` tier, which still shows the WORK half — products, samples, the
 *  objection — because that half is the rep's own work and every admin reader sees it. With nobody
 *  named there is no reader to judge, so the cell reads exactly as it did before this change. */
export function buildVisitDetail(row: CrmDetailRow, sight: PhoenixDetailSight | null): CompanyActivityVisitDetail {
  const classification = classifyVisit(row.visit_type, row.comment, row.visit_type_description);
  return {
    visitType: row.visit_type,
    // The door serves every Phoenix visit as type 0, so an unplanned one would read "Regular" beside its
    // Unplanned highlight; it names itself instead. An archive-day campaign visit keeps its own label.
    label: row.visit_kind && row.is_unplanned ? "Unplanned visit" : resolveVisitTypeLabel(row.visit_type, row.visit_type_description, row.comment),
    bucket: classification.bucket,
    isCampaign: isUnplannedFieldVisit(row),
    session: row.ampm,
    contactName: row.contact_name,
    customerName: row.customer_name,
    comment: row.comment,
    attributionUncertain: !row.agent_hr_id && !row.double_hr_id,
    partner2Name: row.double2_name?.trim() || null,
    // `visit_kind` is the one column only a Phoenix row carries, so it is what tells the two feeds apart
    // here — a vendor row gets null and its cell is byte-for-byte what it was before this change.
    phoenix: row.visit_kind && sight ? phoenixVisitDetail(row, sight) : null,
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
  /** Who is reading. Omitted means no Phoenix detail at all, which is what a caller with no reader to
   * name should get — never the full set by default. */
  viewer?: PhoenixDetailViewer;
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
    // A visit counts for whoever it belongs to, as the primary agent or as EITHER partner — the
    // `doubleHrIds` read already returns a slot-2 row, and dropping it here is what made a chain
    // visit's other person read as absent.
    for (const rawHrId of [visit.agent_hr_id, visit.double_hr_id, visit.double2_hr_id]) {
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
        // 🔴 AN EXPLICIT ARROW, NOT `rows.map(buildVisitDetail)`. `map` passes the INDEX as the second
        // argument, so the bare reference would have handed the sight parameter a number — and `0`
        // is not a tier, so every row would have fallen through to the widest reading.
        visits: rows.map((row) =>
          buildVisitDetail(row, input.viewer ? phoenixRowSight(input.viewer, row.agent_hr_id) : null),
        ),
        isFieldVisitDay: regularCount > 0 || hasCampaignType,
        isLeaveDay: regularCount === 0 && !hasCampaignType && hasLeaveType,
      });
    }
    byEmployeeDay.set(hrId, dayMap);
  }

  return { byEmployeeDay, unmappedCrmVisitCount };
}
