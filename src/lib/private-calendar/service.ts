import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";
import { sharedPlanningCalendarStatuses } from "@/lib/weekly-planning/calendar";
import {
  canReadPrivateCalendarEmployee,
  configuredPrivateCalendarGlobalHrIds,
  isPrivateCalendarGlobalViewer,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapHolidayToPrivateCalendarItem,
  mapPlanRowToPrivateCalendarItem,
  mapPrivateCalendarEmployee,
  mapVacationRowToPrivateCalendarItem,
  privateCalendarHrIdKey,
  privateCalendarSources,
  resolvePrivateCalendarVisibleEmployees,
  summarizePrivateCalendarItems,
  type PrivateCalendarItem,
  type PrivateCalendarPlanRow,
  type PrivateCalendarSource,
  type PrivateCalendarWorkspace,
} from "@/lib/private-calendar/logic";

type VacationCalendarRow = {
  day_part: string | null;
  duration_days: number | string | null;
  employee_hr_id: string;
  employee_name: string | null;
  end_date: string | null;
  id: string;
  notes: string | null;
  paid_duration_days: number | string | null;
  payment_status: string | null;
  start_date: string;
  status: string | null;
  vacation_type: string | null;
};

type ExcuseCalendarRow = {
  duration_hours: number | string | null;
  employee_hr_id: string;
  employee_name: string | null;
  excuse_date: string;
  excuse_type: string | null;
  id: string;
  manager_decision_comment: string | null;
  status: string | null;
};

type PlanHeaderRow = {
  employee_hr_id: string;
  employee_name: string;
  id: string;
  plan_kind: string;
  status: string;
};

type PlanItemRow = {
  activity_date: string;
  activity_title: string | null;
  activity_type: string | null;
  area: string | null;
  end_time: string | null;
  id: string;
  location_text: string | null;
  notes: string | null;
  plan_id: string;
  sort_order: number | null;
  start_time: string | null;
};

function schemaMissing(error: unknown, ...names: string[]) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return names.some((name) => text.toLowerCase().includes(name.toLowerCase())) ||
    /schema cache|does not exist|PGRST205|42P01/i.test(text);
}

function selectedEmployeeFromRequest(input: {
  access: AccessContext;
  employees: EmployeeDirectoryRow[];
  requestedEmployeeHrId?: string | null;
  visibleEmployees: EmployeeDirectoryRow[];
}) {
  const requestedKey = privateCalendarHrIdKey(input.requestedEmployeeHrId);
  const accessKeys = [input.access.hrId, input.access.loginId].map(privateCalendarHrIdKey).filter(Boolean);
  const visibleByKey = new Map(input.visibleEmployees.map((employee) => [privateCalendarHrIdKey(employee.hrId), employee]));

  if (requestedKey) {
    const requested = input.employees.find((employee) => privateCalendarHrIdKey(employee.hrId) === requestedKey);
    if (!requested) throw new Error("Selected employee was not found.");
    if (!visibleByKey.has(requestedKey)) throw new Error("Forbidden: you cannot view this private calendar.");
    return requested;
  }

  for (const key of accessKeys) {
    const self = visibleByKey.get(key);
    if (self) return self;
  }

  const fallback = input.visibleEmployees[0] ?? null;
  if (!fallback) throw new Error("Forbidden: no private calendar is available for this account.");
  return fallback;
}

async function loadHolidayItems(year: number, month: number, start: string, end: string): Promise<PrivateCalendarItem[]> {
  try {
    const result = await getEgyptianNationalHolidays({ month, year });
    return result.holidays
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => mapHolidayToPrivateCalendarItem({
        description: holiday.description,
        endDate: holiday.endDate ?? holiday.startDate,
        id: holiday.id,
        name: holiday.name,
        startDate: holiday.startDate,
      }));
  } catch {
    return getCompanyHolidaysForMonth({ month, year })
      .filter((holiday) => rangesOverlap(holiday.startDate, holiday.endDate ?? holiday.startDate, start, end))
      .map((holiday) => mapHolidayToPrivateCalendarItem({
        description: null,
        endDate: holiday.endDate ?? holiday.startDate,
        id: holiday.startDate,
        name: holiday.name,
        startDate: holiday.startDate,
      }));
  }
}

async function loadAttendanceItems(employeeHrId: string, start: string, end: string) {
  try {
    const selectedKey = privateCalendarHrIdKey(employeeHrId);
    const report = await getFingerprintAttendanceReport({ dateFrom: start, dateTo: end, employeeHrId });
    return {
      items: report.rows
        .filter((row) => privateCalendarHrIdKey(row.employeeHrId) === selectedKey)
        .map(mapAttendanceRowToPrivateCalendarItem),
      ready: true,
    };
  } catch (error) {
    if (schemaMissing(error, "attendance_raw_punches", "attendance_policy_groups", "attendance_policy_rules")) {
      return { items: [], ready: false };
    }
    throw error;
  }
}

async function loadVacationItems(employeeHrId: string, start: string, end: string) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("id,employee_hr_id,employee_name,start_date,end_date,vacation_type,status,day_part,duration_days,paid_duration_days,payment_status,notes")
      .ilike("employee_hr_id", employeeHrId)
      .eq("status", "approved")
      .lte("start_date", end)
      .gte("end_date", start)
      .order("start_date", { ascending: true })
      .limit(100);
    if (error) throw error;
    return { items: ((data ?? []) as VacationCalendarRow[]).map(mapVacationRowToPrivateCalendarItem), ready: true };
  } catch (error) {
    if (schemaMissing(error, "v2_vacation_requests")) return { items: [], ready: false };
    throw error;
  }
}

async function loadExcuseItems(employeeHrId: string, start: string, end: string) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("v2_excuse_requests")
      .select("id,employee_hr_id,employee_name,excuse_date,excuse_type,duration_hours,status,manager_decision_comment")
      .ilike("employee_hr_id", employeeHrId)
      .eq("status", "approved")
      .gte("excuse_date", start)
      .lte("excuse_date", end)
      .order("excuse_date", { ascending: true })
      .limit(100);
    if (error) throw error;
    return { items: ((data ?? []) as ExcuseCalendarRow[]).map(mapExcuseRowToPrivateCalendarItem), ready: true };
  } catch (error) {
    if (schemaMissing(error, "v2_excuse_requests")) return { items: [], ready: false };
    throw error;
  }
}

async function loadPlanItems(employeeHrId: string, start: string, end: string) {
  try {
    const supabase = getSupabaseAdmin();
    const { data: headersData, error: headersError } = await supabase
      .from("employee_plan_headers")
      .select("id,employee_hr_id,employee_name,plan_kind,status,period_start_date,period_end_date")
      .ilike("employee_hr_id", employeeHrId)
      .in("status", [...sharedPlanningCalendarStatuses])
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .order("period_start_date", { ascending: true })
      .limit(100);
    if (headersError) throw headersError;

    const headers = (headersData ?? []) as PlanHeaderRow[];
    const headerById = new Map(headers.map((header) => [header.id, header]));
    const planIds = headers.map((header) => header.id);
    if (planIds.length === 0) return { items: [], ready: true };

    const { data: itemsData, error: itemsError } = await supabase
      .from("employee_plan_items")
      .select("id,plan_id,activity_date,start_time,end_time,activity_type,activity_title,location_text,area,notes,sort_order")
      .in("plan_id", planIds)
      .gte("activity_date", start)
      .lte("activity_date", end)
      .order("activity_date", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(500);
    if (itemsError) throw itemsError;

    const items = ((itemsData ?? []) as PlanItemRow[]).flatMap((item) => {
      const header = headerById.get(item.plan_id);
      if (!header) return [];
      const row: PrivateCalendarPlanRow = {
        activity_date: item.activity_date,
        activity_title: item.activity_title,
        activity_type: item.activity_type,
        area: item.area,
        employee_hr_id: header.employee_hr_id,
        employee_name: header.employee_name,
        end_time: item.end_time,
        id: item.id,
        location_text: item.location_text,
        notes: item.notes,
        plan_kind: header.plan_kind,
        start_time: item.start_time,
        status: header.status,
      };
      return [mapPlanRowToPrivateCalendarItem(row)];
    });
    return { items, ready: true };
  } catch (error) {
    if (schemaMissing(error, "employee_plan_headers", "employee_plan_items")) return { items: [], ready: false };
    throw error;
  }
}

export function canUsePrivateCalendarAdminSurface(access: AccessContext) {
  return isPrivateCalendarGlobalViewer(access);
}

export async function getPrivateCalendarWorkspace(input: {
  access: AccessContext;
  employeeHrId?: string | null;
  month: number;
  year: number;
}): Promise<PrivateCalendarWorkspace> {
  await assertPermission(input.access, "employee_profile", "read");
  await assertPermission(input.access, "attendance", "read");

  const { start, end } = monthBounds(input.year, input.month);
  const employees = await getEmployeeDirectoryRows();
  const globalHrIds = configuredPrivateCalendarGlobalHrIds();
  const visibleEmployees = employees.filter((employee) => canReadPrivateCalendarEmployee(input.access, employee, globalHrIds));
  const selectedEmployee = selectedEmployeeFromRequest({
    access: input.access,
    employees,
    requestedEmployeeHrId: input.employeeHrId,
    visibleEmployees,
  });
  const selectedHrId = selectedEmployee.hrId;

  const [attendance, vacations, excuses, plans, holidays] = await Promise.all([
    loadAttendanceItems(selectedHrId, start, end),
    loadVacationItems(selectedHrId, start, end),
    loadExcuseItems(selectedHrId, start, end),
    loadPlanItems(selectedHrId, start, end),
    loadHolidayItems(input.year, input.month, start, end),
  ]);

  const items = [
    ...attendance.items,
    ...vacations.items,
    ...excuses.items,
    ...plans.items,
    ...holidays,
  ].sort((left, right) => `${left.startDate}-${left.source}-${left.title}`.localeCompare(`${right.startDate}-${right.source}-${right.title}`));
  const sourceReadiness: Record<PrivateCalendarSource, boolean> = {
    attendance: attendance.ready,
    excuse: excuses.ready,
    holiday: true,
    plan: plans.ready,
    vacation: vacations.ready,
  };

  return {
    access: {
      canSelectEmployee: visibleEmployees.length > 1,
      isGlobalViewer: isPrivateCalendarGlobalViewer(input.access, globalHrIds),
    },
    items,
    month: input.month,
    schemaReady: privateCalendarSources.every((source) => sourceReadiness[source]),
    selectedEmployee: mapPrivateCalendarEmployee(selectedEmployee),
    sourceReadiness,
    summary: summarizePrivateCalendarItems(items),
    visibleEmployees: resolvePrivateCalendarVisibleEmployees(input.access, employees, globalHrIds),
    weeks: buildMonthGrid(input.year, input.month),
    year: input.year,
  };
}
