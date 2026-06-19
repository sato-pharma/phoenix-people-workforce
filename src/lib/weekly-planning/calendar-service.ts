import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";
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

function normalizeHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function sameLine(left: string | null | undefined, right: string | null | undefined) {
  const a = cleanText(left).toLowerCase();
  const b = cleanText(right).toLowerCase();
  return Boolean(a && b && a === b);
}

function isPlanningSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

async function loadHolidayItems(year: number, month: number, start: string, end: string): Promise<PlanningCalendarHolidayItem[]> {
  try {
    const result = await getEgyptianNationalHolidays({ month, year });
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
      endDate: row.activity_date,
      id: `plan-${row.id}`,
      lineName,
      medicalRepHrId,
      medicalRepName,
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
    const conflicts = buildPlanningCalendarConflicts(rawPlanItems);
    const planItems = attachPlanningConflictWarnings(rawPlanItems, conflicts);
    const submittedOwners = new Set(planItems.map((item) => normalizeHrId(item.employeeHrId)).filter(Boolean));
    return {
      conflicts,
      hasMoreHeaders,
      hasMoreItems,
      headerLimit: CALENDAR_HEADER_LIMIT,
      items: [...holidays, ...planItems].sort((left, right) => `${left.startDate}-${left.title}`.localeCompare(`${right.startDate}-${right.title}`)),
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
      lineName: item.lineName,
      medicalRepHrId: medicalRepIdentity,
      medicalRepName: item.medicalRepName ?? medicalRepIdentity,
      region: item.region,
    }];
  });
}
