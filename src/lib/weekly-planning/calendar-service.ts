import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { normalizeRegionLabel, regionsWithinManagerHierarchy, reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import type { EmployeePlanActivityType, EmployeePlanKind, EmployeePlanStatus } from "@/lib/weekly-planning/plan-v1";
import {
  activityDisplayLabel,
  attachPlanningConflictWarnings,
  buildPlanningCalendarConflicts,
  planningCalendarTitle,
  planningConflictKey,
  planSlotLabel,
  sharedPlanningCalendarStatuses,
  type PlanningCalendarHolidayItem,
  type PlanningCalendarPlanItem,
  type PlanningCalendarWorkspace,
  type SameLinePlanBooking,
} from "@/lib/weekly-planning/calendar";

const CALENDAR_HEADER_LIMIT = 1000;
const CALENDAR_ITEM_LIMIT = 5000;
const ALLOWED_CALENDAR_OWNER_ROLES = new Set([
  "national sales manager",
  "product manager",
  "group product manager",
  "territory manager",
  "training manager",
  "marketing manager",
  "district manager",
  "district sales manager",
]);

type PlanCalendarHeaderRow = {
  employee_hr_id: string;
  employee_job_title: string | null;
  employee_name: string;
  id: string;
  period_end_date: string;
  period_start_date: string;
  plan_kind: EmployeePlanKind;
  status: EmployeePlanStatus;
};

type PlanCalendarItemRow = {
  activity_date: string;
  activity_title: string;
  activity_type: EmployeePlanActivityType;
  area: string | null;
  double_visit_medical_rep_hr_id: string | null;
  double_visit_medical_rep_name: string | null;
  end_time: string | null;
  id: string;
  location_text: string | null;
  notes: string | null;
  plan_id: string;
  sort_order: number | null;
  start_time: string | null;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeLowerText(value: string | null | undefined) {
  return cleanText(value).toLowerCase();
}

function normalizeHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function isHeadOfficeLine(lineName: string | null | undefined) {
  const normalized = normalizeLowerText(lineName).replace(/[^a-z0-9]/g, "");
  return ["office", "headoffice", "hq"].includes(normalized);
}

function isAllowedCalendarOwnerTitle(employeeJobTitle: string | null) {
  const role = normalizeLowerText(employeeJobTitle);
  if (!role) return false;
  if ([...ALLOWED_CALENDAR_OWNER_ROLES].some((allowedRole) => role.includes(allowedRole))) return true;
  const tokens = role.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const aliases = new Set(["nsm", "pm", "gpm", "tm", "dsm"]);
  if (tokens.some((token) => aliases.has(token))) return true;
  const hasManager = tokens.includes("manager");
  const hasTerritory = tokens.includes("territory");
  return hasManager && hasTerritory;
}

function isAllowedCalendarOwner(item: PlanningCalendarPlanItem) {
  if (isHeadOfficeLine(item.lineName)) return true;
  const title = normalizeLowerText(item.employeeJobTitle);
  return ALLOWED_CALENDAR_OWNER_ROLES.has(title) || isAllowedCalendarOwnerTitle(item.employeeJobTitle);
}

/**
 * District Manager plans need a stricter, hierarchy-based viewer rule (see
 * `isPlanItemVisibleToViewer`) instead of the line-based rule every other
 * recognized owner title gets, because a District Manager's `lineName` does not
 * reliably align with which National Sales Manager they report to.
 */
function calendarOwnerScopeKind(employeeJobTitle: string | null): "line" | "hierarchy" {
  const role = normalizeLowerText(employeeJobTitle);
  const tokens = role.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const isDistrictManager =
    role.includes("district manager") || role.includes("district sales manager") || tokens.includes("dsm");
  return isDistrictManager ? "hierarchy" : "line";
}

function sameLine(left: string | null | undefined, right: string | null | undefined) {
  const a = cleanText(left).toLowerCase();
  const b = cleanText(right).toLowerCase();
  return Boolean(a && b && a === b);
}

/**
 * Decides whether a viewer may see a given plan item on the shared planning
 * calendar. Pure and side-effect free so it can be unit-tested directly with
 * constructed fixtures instead of mocking Supabase.
 *
 * - Company-wide viewers (CEO / Super Admin / Finance Manager) and Head Office
 *   line items are always visible.
 * - An owner always sees their own submitted plan.
 * - District Manager items are scoped to the reporting hierarchy
 *   (`manager_hr_id` / vacant-seat continuity) — visible only to "his NSM" —
 *   because a District Manager's `lineName` does not reliably align with which
 *   NSM they report to. Deliberately does not climb further up the chain
 *   (Regional Manager and above); that is out of scope for now.
 * - Regional Manager items are bounded by line AND region (owner rule 2026-07-18): an RM owns one
 *   product line across a specific set of regions, derived from their own management subtree
 *   (`regionalManagerRegionKeys`, precomputed once by the caller — see `getSharedPlanningCalendarWorkspace`).
 *   Same rule shared with double-visit-analytics + the employee portal workforce view.
 * - Every other recognized owner title (NSM/PM/GPM/Territory Manager/Training
 *   Manager/Marketing Manager) uses the standard same-line rule.
 */
export function isPlanItemVisibleToViewer(
  item: PlanningCalendarPlanItem,
  access: Pick<AccessContext, "hrId" | "role" | "scope">,
  viewer: EmployeeDirectoryRow | null,
  owner: EmployeeDirectoryRow | null,
  regionalManagerRegionKeys?: ReadonlySet<string>,
): boolean {
  if (!isAllowedCalendarOwner(item)) return false;
  const isCompanyWideViewer = access.scope === "company" || access.scope === "system";
  if (isCompanyWideViewer) return true;
  if (isHeadOfficeLine(item.lineName)) return true;

  const viewerHrId = normalizeHrId(access.hrId);
  if (viewerHrId && viewerHrId === normalizeHrId(item.employeeHrId)) return true;

  if (calendarOwnerScopeKind(item.employeeJobTitle) === "hierarchy") {
    if (!owner || !viewerHrId) return false;
    return reportsToManagerSeat({ employee: owner, viewerCanonicalHrId: viewerHrId, canonicalize: normalizeHrId });
  }

  if (access.role === "Regional Manager") {
    if (!regionalManagerRegionKeys || regionalManagerRegionKeys.size === 0) return false;
    if (!sameLine(item.lineName, viewer?.lineName)) return false;
    const region = normalizeRegionLabel(item.region);
    return Boolean(region && regionalManagerRegionKeys.has(region));
  }

  return sameLine(item.lineName, viewer?.lineName);
}

function isPlanningSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

async function loadHolidayItems(year: number, month: number, start: string, end: string): Promise<PlanningCalendarHolidayItem[]> {
  try {
    const result = await getConfirmedNationalHolidays({ month, year });
    return result.holidays
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => ({
        description: holiday.description,
        endDate: holiday.endDate ?? holiday.startDate,
        id: `holiday-${holiday.id}`,
        source: "holiday" as const,
        startDate: holiday.startDate,
        title: holiday.name,
      }));
  } catch {
    return getCompanyHolidaysForMonth({ month, year })
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => ({
        description: null,
        endDate: holiday.endDate ?? holiday.startDate,
        id: `holiday-${holiday.startDate}`,
        source: "holiday" as const,
        startDate: holiday.startDate,
        title: holiday.name,
      }));
  }
}

async function loadSubmittedPlanItems(start: string, end: string): Promise<{
  directoryByHrId: Map<string, EmployeeDirectoryRow>;
  hasMoreHeaders: boolean;
  hasMoreItems: boolean;
  items: PlanningCalendarPlanItem[];
  loadedHeaderCount: number;
  loadedItemCount: number;
}> {
  const supabase = getSupabaseAdmin();
  const [directoryRows, headersResult] = await Promise.all([
    getEmployeeDirectoryRows(),
    supabase
      .from("employee_plan_headers")
      .select("id,employee_hr_id,employee_name,employee_job_title,plan_kind,status,period_start_date,period_end_date")
      .in("status", [...sharedPlanningCalendarStatuses])
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .order("period_start_date", { ascending: true })
      .limit(CALENDAR_HEADER_LIMIT + 1),
  ]);
  if (headersResult.error) throw headersResult.error;

  const loadedHeaders = (headersResult.data ?? []) as PlanCalendarHeaderRow[];
  const hasMoreHeaders = loadedHeaders.length > CALENDAR_HEADER_LIMIT;
  const headers = loadedHeaders.slice(0, CALENDAR_HEADER_LIMIT);
  const headerById = new Map(headers.map((header) => [header.id, header]));
  const planIds = headers.map((header) => header.id);
  const directoryByHrId = new Map(directoryRows.map((row) => [normalizeHrId(row.hrId), row]));
  if (planIds.length === 0) {
    return {
      directoryByHrId,
      hasMoreHeaders,
      hasMoreItems: false,
      items: [],
      loadedHeaderCount: headers.length,
      loadedItemCount: 0,
    };
  }

  const { data: rawRows, error } = await supabase
    .from("employee_plan_items")
    .select("id,plan_id,activity_date,start_time,end_time,activity_type,activity_title,location_text,area,double_visit_medical_rep_hr_id,double_visit_medical_rep_name,notes,sort_order")
    .in("plan_id", planIds)
    .gte("activity_date", start)
    .lte("activity_date", end)
    .order("activity_date", { ascending: true })
    .order("sort_order", { ascending: true })
    .limit(CALENDAR_ITEM_LIMIT + 1);
  if (error) throw error;

  const loadedRows = (rawRows ?? []) as PlanCalendarItemRow[];
  const hasMoreItems = loadedRows.length > CALENDAR_ITEM_LIMIT;
  const rows = loadedRows.slice(0, CALENDAR_ITEM_LIMIT);

  const items = rows.flatMap((row) => {
    const header = headerById.get(row.plan_id);
    if (!header) return [];
    const employee = directoryByHrId.get(normalizeHrId(header.employee_hr_id));
    const lineName = employee?.lineName ?? null;
    const region = cleanText(row.location_text) || null;
    const area = cleanText(row.area) || null;
    const activityTitle = activityDisplayLabel(row.activity_type, row.activity_title);
    const medicalRepHrId = cleanText(row.double_visit_medical_rep_hr_id) || null;
    const medicalRepName = cleanText(row.double_visit_medical_rep_name) || null;
    const medicalRepEmployee = medicalRepHrId ? directoryByHrId.get(normalizeHrId(medicalRepHrId)) : undefined;
    const medicalRepDisplayName = medicalRepEmployee?.displayName || medicalRepName;
    const conflictKey = planningConflictKey(row.activity_date, lineName, medicalRepHrId ?? medicalRepName);
    const item: PlanningCalendarPlanItem = {
      activityTitle,
      activityType: row.activity_type,
      area,
      conflictKey,
      conflictWarning: null,
      employeeHrId: header.employee_hr_id,
      employeeJobTitle: header.employee_job_title,
      employeeName: header.employee_name,
      employeeDisplayName: employee?.displayName || header.employee_name,
      endDate: row.activity_date,
      id: `plan-${row.id}`,
      lineName,
      medicalRepHrId,
      medicalRepName,
      medicalRepDisplayName,
      notes: cleanText(row.notes) || null,
      planId: header.id,
      planKind: header.plan_kind,
      region,
      source: "plan",
      startDate: row.activity_date,
      status: header.status,
      time: planSlotLabel(row.start_time, row.end_time),
      title: planningCalendarTitle(header.employee_name, region, area, activityTitle),
    };
    return [item];
  });

  return {
    directoryByHrId,
    hasMoreHeaders,
    hasMoreItems,
    items,
    loadedHeaderCount: headers.length,
    loadedItemCount: rows.length,
  };
}

export async function getSharedPlanningCalendarWorkspace(
  access: AccessContext,
  year: number,
  month: number,
): Promise<PlanningCalendarWorkspace> {
  await assertPermission(access, "weekly_plans", "read");
  const { start, end } = monthBounds(year, month);
  const viewerHrId = normalizeHrId(access.hrId);

  try {
    const [{
      directoryByHrId,
      hasMoreHeaders,
      hasMoreItems,
      items: rawPlanItems,
      loadedHeaderCount,
      loadedItemCount,
    }, holidays] = await Promise.all([
      loadSubmittedPlanItems(start, end),
      loadHolidayItems(year, month, start, end),
    ]);
    const viewer = directoryByHrId.get(viewerHrId) ?? null;
    // Precomputed ONCE (not per item) so isPlanItemVisibleToViewer stays a pure per-item check.
    const regionalManagerRegionKeys =
      access.role === "Regional Manager" && viewerHrId
        ? regionsWithinManagerHierarchy(Array.from(directoryByHrId.values()), viewerHrId, normalizeHrId)
        : undefined;
    const planItems = rawPlanItems.filter((item) =>
      isPlanItemVisibleToViewer(
        item,
        access,
        viewer,
        directoryByHrId.get(normalizeHrId(item.employeeHrId)) ?? null,
        regionalManagerRegionKeys,
      ),
    );
    const conflicts = buildPlanningCalendarConflicts(planItems);
    const warnedPlanItems = attachPlanningConflictWarnings(planItems, conflicts);
    const submittedOwners = new Set(planItems.map((item) => normalizeHrId(item.employeeHrId)).filter(Boolean));
    return {
      conflicts,
      hasMoreHeaders,
      hasMoreItems,
      headerLimit: CALENDAR_HEADER_LIMIT,
      items: [...holidays, ...warnedPlanItems].sort((left, right) => `${left.startDate}-${left.title}`.localeCompare(`${right.startDate}-${right.title}`)),
      itemLimit: CALENDAR_ITEM_LIMIT,
      loadedHeaderCount,
      loadedItemCount,
      month,
      schemaReady: true,
      summary: {
        conflictCount: conflicts.length,
        holidayCount: holidays.length,
        planCount: planItems.length,
        submittedOwnerCount: submittedOwners.size,
      },
      viewerLineName: viewer?.lineName ?? null,
      weeks: buildMonthGrid(year, month),
      year,
    };
  } catch (error) {
    if (!isPlanningSchemaMissing(error)) throw error;
    const holidays = await loadHolidayItems(year, month, start, end);
    return {
      conflicts: [],
      hasMoreHeaders: false,
      hasMoreItems: false,
      headerLimit: CALENDAR_HEADER_LIMIT,
      items: holidays,
      itemLimit: CALENDAR_ITEM_LIMIT,
      loadedHeaderCount: 0,
      loadedItemCount: 0,
      month,
      schemaReady: false,
      summary: {
        conflictCount: 0,
        holidayCount: holidays.length,
        planCount: 0,
        submittedOwnerCount: 0,
      },
      viewerLineName: null,
      weeks: buildMonthGrid(year, month),
      year,
    };
  }
}

export async function getSameLinePlanBookings(
  access: AccessContext,
  start: string,
  end: string,
): Promise<SameLinePlanBooking[]> {
  await assertPermission(access, "weekly_plans", "read");
  const { directoryByHrId, items } = await loadSubmittedPlanItems(start, end);
  const viewer = directoryByHrId.get(normalizeHrId(access.hrId));
  if (!viewer?.lineName) return [];
  return items.flatMap((item) => {
    const medicalRepIdentity = item.medicalRepHrId ?? item.medicalRepName;
    if (!medicalRepIdentity || !sameLine(item.lineName, viewer.lineName)) return [];
    return [{
      activityTitle: item.activityTitle,
      area: item.area,
      date: item.startDate,
      employeeHrId: item.employeeHrId,
      employeeName: item.employeeName,
      employeeDisplayName: item.employeeDisplayName,
      lineName: item.lineName,
      medicalRepHrId: medicalRepIdentity,
      medicalRepName: item.medicalRepName ?? medicalRepIdentity,
      region: item.region,
    }];
  });
}
