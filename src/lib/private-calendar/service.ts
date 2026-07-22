import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendancePolicyGroups } from "@/lib/attendance/policy-groups";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { loadDoubleVisitPrivateCalendarItems } from "@/lib/double-visit-analytics/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { listDisputesForEmployee, type PrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import {
  canReadPrivateCalendarEmployee,
  buildPrivateCalendarTeamSummary,
  configuredPrivateCalendarGlobalHrIds,
  derivePrivateCalendarExceptions,
  filterPrivateCalendarActualItems,
  isPrivateCalendarGlobalViewer,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapHolidayToPrivateCalendarItem,
  mapPlanRowToPrivateCalendarItem,
  mapPrivateCalendarEmployee,
  mapVacationRowToPrivateCalendarItem,
  privateCalendarHrIdKey,
  privateCalendarPlanStatuses,
  privateCalendarSources,
  resolvePrivateCalendarVisibleEmployees,
  summarizePrivateCalendarItems,
  type PrivateCalendarException,
  type PrivateCalendarItem,
  type PrivateCalendarPlanRow,
  type PrivateCalendarSource,
  type PrivateCalendarViewMode,
  type PrivateCalendarWorkspace,
} from "@/lib/private-calendar/logic";

type VacationCalendarRow = {
  day_part: string | null;
  duration_days: number | string | null;
  employee_hr_id: string;
  employee_name: string | null;
  end_date: string | null;
  id: string;
  manager_decision: string | null;
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

function expandHrIdLookupKeys(employeeHrIds: string[]) {
  return Array.from(
    new Set(
      employeeHrIds.flatMap((value) => hrIdLookupKeys(value)),
    ),
  );
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

function normalizeViewMode(value: string | null | undefined): PrivateCalendarViewMode {
  return value === "team" ? "team" : "employee";
}

function sortEmployees(employees: EmployeeDirectoryRow[]) {
  return [...employees].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function employeeMetadataByHrId(employees: EmployeeDirectoryRow[]) {
  return new Map(employees.map((employee) => [privateCalendarHrIdKey(employee.hrId), mapPrivateCalendarEmployee(employee)]));
}

function decorateItemsWithEmployeeMetadata(items: PrivateCalendarItem[], employees: EmployeeDirectoryRow[]) {
  const byHrId = employeeMetadataByHrId(employees);
  return items.map((item) => {
    if (!item.employeeHrId) return item;
    const employee = byHrId.get(privateCalendarHrIdKey(item.employeeHrId));
    if (!employee) return item;
    return {
      ...item,
      employeeDepartmentName: employee.departmentName,
      employeeJobTitle: employee.jobTitle,
      employeeLineName: employee.lineName,
      employeeName: item.employeeName || employee.fullName,
      managerName: employee.managerName,
    };
  });
}

function filterItemsByEmployees(items: PrivateCalendarItem[], employees: EmployeeDirectoryRow[]) {
  const allowed = new Set(employees.map((employee) => privateCalendarHrIdKey(employee.hrId)).filter(Boolean));
  return items.filter((item) => !item.employeeHrId || allowed.has(privateCalendarHrIdKey(item.employeeHrId)));
}

// An accepted data dispute never mutates the original synced item — it overlays
// a visible "Admin-verified correction" note on top, so the original source
// data stays fully auditable alongside the verified truth. Only accepted,
// item-scoped disputes annotate the matching item directly; every dispute
// (any status, item-scoped or whole-day) also gets a standalone status
// exception via appendDisputeStatusExceptions below, so the employee always
// sees where their request stands even before/without a decision.
function applyAcceptedDisputeOverlays(
  items: PrivateCalendarItem[],
  disputes: PrivateCalendarDataDispute[],
): PrivateCalendarItem[] {
  const acceptedItemScoped = disputes.filter((dispute) => dispute.status === "accepted" && dispute.itemSource != null);
  if (acceptedItemScoped.length === 0) return items;
  return items.map((item) => {
    const matching = acceptedItemScoped.find((dispute) =>
      privateCalendarHrIdKey(dispute.employeeHrId) === privateCalendarHrIdKey(item.employeeHrId)
      && dispute.disputeDate === item.startDate
      && dispute.itemSource === item.source
      && (dispute.itemSourceRecordId == null || dispute.itemSourceRecordId === item.sourceRecordId));
    if (!matching) return item;
    const note = `Admin-verified correction: ${matching.claimText} (verified via ${matching.claimSourceText})`;
    return {
      ...item,
      chipLines: [...(item.chipLines ?? [item.title]), "Admin-verified correction"],
      detailLines: [...item.detailLines, note],
    };
  });
}

// Employee-visible status/history: every review request the employee submitted
// shows up on its day, worded and colored per status — pending (info, still
// awaiting a Super Admin decision), accepted (info, same "verified correction"
// wording the item-level overlay above uses for item-scoped ones), or rejected
// (warning, with the admin's note so the employee knows why).
function appendDisputeStatusExceptions(
  exceptions: PrivateCalendarException[],
  disputes: PrivateCalendarDataDispute[],
): PrivateCalendarException[] {
  if (disputes.length === 0) return exceptions;
  const statusExceptions: PrivateCalendarException[] = disputes.map((dispute) => {
    if (dispute.status === "pending_review") {
      return {
        code: "data_review_pending",
        date: dispute.disputeDate,
        description: `You requested a review: "${dispute.claimText}" (verify via ${dispute.claimSourceText}). Awaiting a Super Admin decision.`,
        employeeHrId: dispute.employeeHrId,
        employeeName: dispute.employeeName,
        id: `private-calendar-dispute-status-${dispute.id}`,
        relatedItemIds: [],
        severity: "info",
        title: "Review Requested — Pending",
      };
    }
    if (dispute.status === "rejected") {
      return {
        code: "data_review_rejected",
        date: dispute.disputeDate,
        description: `Your review request was reviewed and declined.${dispute.adminDecisionNote ? ` Admin note: ${dispute.adminDecisionNote}` : ""}`,
        employeeHrId: dispute.employeeHrId,
        employeeName: dispute.employeeName,
        id: `private-calendar-dispute-status-${dispute.id}`,
        relatedItemIds: [],
        severity: "warning",
        title: "Review Request Declined",
      };
    }
    return {
      code: "data_correction_verified",
      date: dispute.disputeDate,
      description: `${dispute.claimText} — verified via ${dispute.claimSourceText}.${dispute.adminDecisionNote ? ` Admin note: ${dispute.adminDecisionNote}` : ""}`,
      employeeHrId: dispute.employeeHrId,
      employeeName: dispute.employeeName,
      id: `private-calendar-dispute-status-${dispute.id}`,
      relatedItemIds: [],
      severity: "info",
      title: "Data Correction Verified",
    };
  });
  return [...exceptions, ...statusExceptions];
}

type NoActivityStatusRow = {
  activity_date: string;
  admin_note: string | null;
  clarification_text: string | null;
  confirmed_no_activity: boolean;
  employee_hr_id: string;
  employee_name: string | null;
  id: string;
  resolution: "deducted" | "not_deducted" | null;
  status: "pending_review" | "resolved";
};

// Local, read-only fetch — deliberately not imported from
// no-activity-clarifications.ts, which itself imports getCompanyNoActivityDays
// from this file; importing back from there would create a circular module
// dependency. Mirrors the same inline-query pattern already used throughout
// this file (loadVacationItems, loadExcuseItems, etc.) for other domains'
// tables.
async function loadNoActivityClarificationStatuses(
  employeeHrIds: string[],
  start: string,
  end: string,
): Promise<NoActivityStatusRow[]> {
  const employeeHrKeys = expandHrIdLookupKeys(employeeHrIds.map((value) => String(value ?? "").trim()).filter(Boolean));
  if (employeeHrKeys.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_no_activity_clarifications")
    .select("id,employee_hr_id,employee_name,activity_date,clarification_text,confirmed_no_activity,status,resolution,admin_note")
    .in("employee_hr_id", employeeHrKeys)
    .gte("activity_date", start)
    .lte("activity_date", end);
  if (error) {
    if (schemaMissing(error, "private_calendar_no_activity_clarifications")) return [];
    throw error;
  }
  return (data ?? []) as NoActivityStatusRow[];
}

// Employee-visible status/history for no-activity clarifications: only
// surfaced once the employee (or the system, via the day-after clarify
// prompt) or an admin has actually acted — an untouched "No Activity
// Recorded" day already gets that label from derivePrivateCalendarExceptions,
// so a pending row with no clarification yet would just be a duplicate of
// that same message.
function appendNoActivityStatusExceptions(
  exceptions: PrivateCalendarException[],
  rows: NoActivityStatusRow[],
): PrivateCalendarException[] {
  if (rows.length === 0) return exceptions;
  const additions: PrivateCalendarException[] = [];
  for (const row of rows) {
    const hasResponse = Boolean(row.clarification_text) || row.confirmed_no_activity;
    if (row.status === "pending_review" && hasResponse) {
      additions.push({
        code: "no_activity_clarification_pending",
        date: row.activity_date,
        description: row.confirmed_no_activity && !row.clarification_text
          ? "You confirmed no activity happened this day. Awaiting Super Admin review."
          : `You clarified: "${row.clarification_text}". Awaiting Super Admin review.`,
        employeeHrId: row.employee_hr_id,
        employeeName: row.employee_name,
        id: `private-calendar-no-activity-status-${row.id}`,
        relatedItemIds: [],
        severity: "info",
        title: "Clarification Submitted — Pending",
      });
    } else if (row.status === "resolved") {
      const deducted = row.resolution === "deducted";
      additions.push({
        code: "no_activity_resolved",
        date: row.activity_date,
        description: `${deducted ? "This day was deducted from payroll." : "No deduction was applied for this day."}${row.admin_note ? ` Admin note: ${row.admin_note}` : ""}`,
        employeeHrId: row.employee_hr_id,
        employeeName: row.employee_name,
        id: `private-calendar-no-activity-status-${row.id}`,
        relatedItemIds: [],
        severity: deducted ? "danger" : "info",
        title: deducted ? "No Activity — Deducted" : "No Activity — Cleared",
      });
    }
  }
  return [...exceptions, ...additions];
}

async function loadHolidayItems(year: number, month: number, start: string, end: string): Promise<PrivateCalendarItem[]> {
  try {
    const result = await getConfirmedNationalHolidays({ month, year });
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

async function loadAttendanceItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const selectedKeys = new Set(employeeHrIds.map(privateCalendarHrIdKey).filter(Boolean));
    const report = await getFingerprintAttendanceReport({ dateFrom: start, dateTo: end });
    return {
      items: report.rows
        .filter((row) => selectedKeys.has(privateCalendarHrIdKey(row.employeeHrId)))
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

async function loadAttendancePolicyScheduleRows() {
  try {
    return await loadAttendancePolicyGroups({ activeOnly: true });
  } catch (error) {
    if (schemaMissing(error, "attendance_policy_groups")) return [];
    throw error;
  }
}

async function loadVacationItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const normalizedHrIds = employeeHrIds.map((value) => String(value ?? "").trim()).filter(Boolean);
    const employeeHrKeys = expandHrIdLookupKeys(normalizedHrIds);
    if (employeeHrKeys.length === 0) return { items: [], ready: true };
    let query = getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("id,employee_hr_id,employee_name,start_date,end_date,vacation_type,status,manager_decision,day_part,duration_days,paid_duration_days,payment_status,notes")
      .in("status", ["needs_assignment", "pending_manager", "pending_hr", "approved", "submitted"])
      .lte("start_date", end)
      .gte("end_date", start)
      .order("start_date", { ascending: true })
      .limit(100);
    query = query.in("employee_hr_id", employeeHrKeys);
    const { data, error } = await query;
    if (error) throw error;
    // Covered = the manager has signed off (manager_decision='approved', which
    // also implies status='pending_hr') or HR has recorded it (status='approved').
    // Everything else is a live pending request: it reserves the day on the
    // calendar (so attendance isn't flagged "missing") but renders as pending.
    return {
      items: ((data ?? []) as VacationCalendarRow[]).map((row) => {
        const covered = row.manager_decision === "approved" || row.status === "approved";
        return mapVacationRowToPrivateCalendarItem(row, { pending: !covered });
      }),
      ready: true,
    };
  } catch (error) {
    if (schemaMissing(error, "v2_vacation_requests")) return { items: [], ready: false };
    throw error;
  }
}

async function loadExcuseItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const normalizedHrIds = employeeHrIds.map((value) => String(value ?? "").trim()).filter(Boolean);
    const employeeHrKeys = expandHrIdLookupKeys(normalizedHrIds);
    if (employeeHrKeys.length === 0) return { items: [], ready: true };
    let query = getSupabaseAdmin()
      .from("v2_excuse_requests")
      .select("id,employee_hr_id,employee_name,excuse_date,excuse_type,duration_hours,status,manager_decision_comment")
      .eq("status", "approved")
      .gte("excuse_date", start)
      .lte("excuse_date", end)
      .order("excuse_date", { ascending: true })
      .limit(100);
    query = query.in("employee_hr_id", employeeHrKeys);
    const { data, error } = await query;
    if (error) throw error;
    return { items: ((data ?? []) as ExcuseCalendarRow[]).map(mapExcuseRowToPrivateCalendarItem), ready: true };
  } catch (error) {
    if (schemaMissing(error, "v2_excuse_requests")) return { items: [], ready: false };
    throw error;
  }
}

async function loadPlanItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const supabase = getSupabaseAdmin();
    const normalizedHrIds = employeeHrIds.map((value) => String(value ?? "").trim()).filter(Boolean);
    const employeeHrKeys = expandHrIdLookupKeys(normalizedHrIds);
    if (employeeHrKeys.length === 0) return { items: [], ready: true };
    let headersQuery = supabase
      .from("employee_plan_headers")
      .select("id,employee_hr_id,employee_name,plan_kind,status,period_start_date,period_end_date")
      .in("status", [...privateCalendarPlanStatuses])
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .order("period_start_date", { ascending: true })
      .limit(1000);
    headersQuery = headersQuery.in("employee_hr_id", employeeHrKeys);
    const { data: headersData, error: headersError } = await headersQuery;
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
      .limit(5000);
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
  // When true, planned/intended activity (source "plan") is loaded and still used
  // to derive exceptions and suppress false FP-missing flags (a field plan still
  // self-proves attendance), but is excluded from the items/summary/teamSummary
  // actually returned. The employee portal uses this so the calendar reflects only
  // what the system actually recognized that day, not what was merely planned.
  actualOnly?: boolean;
  employeeHrId?: string | null;
  month: number;
  viewMode?: PrivateCalendarViewMode | string | null;
  year: number;
}): Promise<PrivateCalendarWorkspace> {
  await assertPermission(input.access, "employee_profile", "read");
  await assertPermission(input.access, "attendance", "read");

  const { start, end } = monthBounds(input.year, input.month);
  const employees = await getEmployeeDirectoryRows();
  const globalHrIds = configuredPrivateCalendarGlobalHrIds();
  const visibleEmployees = sortEmployees(employees.filter((employee) => canReadPrivateCalendarEmployee(input.access, employee, globalHrIds)));
  const selectedEmployee = selectedEmployeeFromRequest({
    access: input.access,
    employees,
    requestedEmployeeHrId: input.employeeHrId,
    visibleEmployees,
  });
  const viewMode = normalizeViewMode(input.viewMode);
  const scopeEmployees = viewMode === "team" ? visibleEmployees : [selectedEmployee];
  const scopeHrIds = scopeEmployees.map((employee) => employee.hrId);

  const [attendance, vacations, excuses, plans, holidays, doubleVisits, attendancePolicyRows] = await Promise.all([
    loadAttendanceItems(scopeHrIds, start, end),
    loadVacationItems(scopeHrIds, start, end),
    loadExcuseItems(scopeHrIds, start, end),
    loadPlanItems(scopeHrIds, start, end),
    loadHolidayItems(input.year, input.month, start, end),
    loadDoubleVisitPrivateCalendarItems(scopeHrIds, start, end),
    loadAttendancePolicyScheduleRows(),
  ]);

  const allItems = decorateItemsWithEmployeeMetadata(filterItemsByEmployees([
    ...attendance.items,
    ...vacations.items,
    ...excuses.items,
    ...plans.items,
    ...holidays,
    ...doubleVisits.items,
  ], scopeEmployees), employees)
    .sort((left, right) => `${left.startDate}-${left.employeeName ?? ""}-${left.source}-${left.title}`.localeCompare(`${right.startDate}-${right.employeeName ?? ""}-${right.source}-${right.title}`));

  // Suppress FP attendance PROBLEMS (Late/Short day/Single punch) on days where a
  // Double Visit or any off-site/remote plan activity exists — a "late/absent"
  // flag is meaningless when the employee was legitimately away from the office.
  // A genuine Complete punch is NEVER suppressed here: real proof of presence
  // always wins, no matter what an unrelated (even unapproved) plan entry claims
  // for the same date — this used to delete a real, positive attendance record
  // whenever any field-type plan existed for that day, which is backwards.
  const fieldVisitDates = new Set<string>();
  for (const item of allItems) {
    if (item.source === "double_visit" || (item.source === "plan" && item.planCountsAsAttendance)) {
      fieldVisitDates.add(item.startDate);
    }
  }
  const items = fieldVisitDates.size > 0
    ? allItems.filter((item) => item.source !== "attendance" || item.status === "Complete" || !fieldVisitDates.has(item.startDate))
    : allItems;
  const mappedScopeEmployees = scopeEmployees.map(mapPrivateCalendarEmployee);
  const exceptions = derivePrivateCalendarExceptions({
    employees: mappedScopeEmployees,
    end,
    isExpectedWorkday: (employee, date) => {
      const policy = resolveActiveAttendancePolicy(
        { hr_id: employee.hrId, job_title: employee.jobTitle },
        attendancePolicyRows,
        date,
        date,
      );
      return isAttendanceScheduledWorkingDay({
        dateIso: date,
        jobTitle: employee.jobTitle,
        workingWeekdays: policy?.working_weekdays,
      });
    },
    items,
    start,
  });
  const sourceReadiness: Record<PrivateCalendarSource, boolean> = {
    attendance: attendance.ready,
    double_visit: doubleVisits.ready,
    excuse: excuses.ready,
    holiday: true,
    plan: plans.ready,
    vacation: vacations.ready,
  };

  const scopeEmployeeHrIds = scopeEmployees.map((employee) => employee.hrId);
  const [employeeDisputes, noActivityStatusRows] = await Promise.all([
    (await Promise.all(
      scopeEmployees.map((employee) => listDisputesForEmployee({ employeeHrId: employee.hrId, end, start }).catch(() => [])),
    )).flat(),
    loadNoActivityClarificationStatuses(scopeEmployeeHrIds, start, end).catch(() => []),
  ]);
  const itemsWithCorrections = applyAcceptedDisputeOverlays(items, employeeDisputes);
  const exceptionsWithStatuses = appendNoActivityStatusExceptions(
    appendDisputeStatusExceptions(exceptions, employeeDisputes),
    noActivityStatusRows,
  );

  const displayItems = input.actualOnly ? filterPrivateCalendarActualItems(itemsWithCorrections) : itemsWithCorrections;

  return {
    access: {
      canSelectEmployee: visibleEmployees.length > 1,
      isGlobalViewer: isPrivateCalendarGlobalViewer(input.access, globalHrIds),
    },
    items: displayItems,
    month: input.month,
    schemaReady: privateCalendarSources.every((source) => sourceReadiness[source]),
    selectedEmployee: mapPrivateCalendarEmployee(selectedEmployee),
    sourceReadiness,
    summary: summarizePrivateCalendarItems(displayItems),
    exceptions: exceptionsWithStatuses,
    teamSummary: buildPrivateCalendarTeamSummary({
      employees: mappedScopeEmployees,
      exceptions: exceptionsWithStatuses,
      items: displayItems,
    }),
    visibleEmployees: resolvePrivateCalendarVisibleEmployees(input.access, employees, globalHrIds),
    viewMode,
    weeks: buildMonthGrid(input.year, input.month),
    year: input.year,
  };
}

export type CompanyNoActivityDay = {
  date: string;
  description: string;
  employeeHrId: string;
  employeeName: string;
};

function monthsTouchedByRange(start: string, end: string): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  const seen = new Set<string>();
  let cursor = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (cursor <= stop) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    if (!seen.has(key)) {
      seen.add(key);
      months.push({ year, month });
    }
    cursor = new Date(Date.UTC(year, month, 1));
  }
  return months;
}

/**
 * Company-wide "No Activity Recorded" days across every active employee for
 * the given date range — the same derivePrivateCalendarExceptions engine the
 * employee's own calendar uses (guaranteeing the admin report and what an
 * employee sees on their calendar can never disagree), just fed the whole
 * roster instead of one employee/team. Backs the No Activity Days report
 * (src/lib/private-calendar/no-activity-clarifications.ts) — this function
 * only computes which days ARE no-activity; it does not touch clarifications
 * or deduction decisions.
 */
export async function getCompanyNoActivityDays(input: {
  access: AccessContext;
  end: string;
  start: string;
}): Promise<CompanyNoActivityDay[]> {
  await assertPermission(input.access, "deductions", "read");

  const employees = await getEmployeeDirectoryRows();
  const hrIds = employees.map((employee) => employee.hrId);
  const months = monthsTouchedByRange(input.start, input.end);

  const [attendance, vacations, excuses, doubleVisits, attendancePolicyRows, ...holidaysByMonth] = await Promise.all([
    loadAttendanceItems(hrIds, input.start, input.end),
    loadVacationItems(hrIds, input.start, input.end),
    loadExcuseItems(hrIds, input.start, input.end),
    loadDoubleVisitPrivateCalendarItems(hrIds, input.start, input.end),
    loadAttendancePolicyScheduleRows(),
    ...months.map(({ year, month }) => loadHolidayItems(year, month, input.start, input.end)),
  ]);

  const allItems = decorateItemsWithEmployeeMetadata(filterItemsByEmployees([
    ...attendance.items,
    ...vacations.items,
    ...excuses.items,
    ...holidaysByMonth.flat(),
    ...doubleVisits.items,
  ], employees), employees);

  const fieldVisitDates = new Set<string>();
  for (const item of allItems) {
    if (item.source === "double_visit") fieldVisitDates.add(item.startDate);
  }
  const items = fieldVisitDates.size > 0
    ? allItems.filter((item) => item.source !== "attendance" || !fieldVisitDates.has(item.startDate))
    : allItems;

  const mappedEmployees = employees.map(mapPrivateCalendarEmployee);
  const exceptions = derivePrivateCalendarExceptions({
    employees: mappedEmployees,
    end: input.end,
    isExpectedWorkday: (employee, date) => {
      const policy = resolveActiveAttendancePolicy(
        { hr_id: employee.hrId, job_title: employee.jobTitle },
        attendancePolicyRows,
        date,
        date,
      );
      return isAttendanceScheduledWorkingDay({
        dateIso: date,
        jobTitle: employee.jobTitle,
        workingWeekdays: policy?.working_weekdays,
      });
    },
    items,
    start: input.start,
  });

  return exceptions
    .filter((exception) => exception.title === "No Activity Recorded" && exception.employeeHrId)
    .map((exception) => ({
      date: exception.date,
      description: exception.description,
      employeeHrId: exception.employeeHrId as string,
      employeeName: exception.employeeName ?? exception.employeeHrId as string,
    }));
}
