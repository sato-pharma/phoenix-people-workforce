import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendancePolicyGroups } from "@/lib/attendance/policy-groups";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { loadDoubleVisitPrivateCalendarItems } from "@/lib/double-visit-analytics/service";
import { loadFieldVisitPrivateCalendarItems } from "@/lib/private-calendar/field-visits";
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
  isPrivateCalendarGlobalViewer,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapHolidayToPrivateCalendarItem,
  mapPrivateCalendarEmployee,
  mapVacationRowToPrivateCalendarItem,
  privateCalendarHrIdKey,
  privateCalendarSources,
  resolvePrivateCalendarVisibleEmployees,
  suppressFieldVisitAttendanceProblems,
  summarizePrivateCalendarItems,
  type PrivateCalendarException,
  type PrivateCalendarItem,
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

export function canUsePrivateCalendarAdminSurface(access: AccessContext) {
  return isPrivateCalendarGlobalViewer(access);
}

export async function getPrivateCalendarWorkspace(input: {
  access: AccessContext;
  // Historically distinguished "what actually happened" from planned/intended
  // activity (the Planning Calendar), which is no longer a private-calendar
  // source at all — every source returned here is already an actually
  // recorded/verified event, so this flag currently has no effect. Kept on the
  // API surface for backward compatibility with existing callers.
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

  const [attendance, vacations, excuses, holidays, doubleVisits, fieldVisits, attendancePolicyRows] =
    await Promise.all([
      loadAttendanceItems(scopeHrIds, start, end),
      loadVacationItems(scopeHrIds, start, end),
      loadExcuseItems(scopeHrIds, start, end),
      loadHolidayItems(input.year, input.month, start, end),
      loadDoubleVisitPrivateCalendarItems(scopeHrIds, start, end),
      loadFieldVisitPrivateCalendarItems(scopeHrIds, start, end),
      loadAttendancePolicyScheduleRows(),
    ]);

  const allItems = decorateItemsWithEmployeeMetadata(filterItemsByEmployees([
    ...attendance.items,
    ...vacations.items,
    ...excuses.items,
    ...holidays,
    ...doubleVisits.items,
    ...fieldVisits.items,
  ], scopeEmployees), employees)
    .sort((left, right) => `${left.startDate}-${left.employeeName ?? ""}-${left.source}-${left.title}`.localeCompare(`${right.startDate}-${right.employeeName ?? ""}-${right.source}-${right.title}`));

  // Suppress FP attendance PROBLEMS (Late/Short day/Single punch) on a Double
  // Visit day — a "late/absent" flag is meaningless when the employee was
  // legitimately away from the office on a CRM-verified visit. Scoped per
  // employee (team view holds the whole team's items) and never suppressing a
  // genuine Complete punch — see suppressFieldVisitAttendanceProblems.
  const items = suppressFieldVisitAttendanceProblems(allItems);
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
    field_visit: fieldVisits.ready,
    holiday: true,
    vacation: vacations.ready,
  };

  const employeeDisputes = (await Promise.all(
    scopeEmployees.map((employee) => listDisputesForEmployee({ employeeHrId: employee.hrId, end, start }).catch(() => [])),
  )).flat();
  const itemsWithCorrections = applyAcceptedDisputeOverlays(items, employeeDisputes);
  const exceptionsWithStatuses = appendDisputeStatusExceptions(exceptions, employeeDisputes);

  const displayItems = itemsWithCorrections;

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
 * employee's own calendar uses (so a report and what an employee sees on their
 * own calendar can never disagree), just fed the whole roster instead of one
 * employee/team. Computes only which days ARE no-activity; it decides nothing.
 *
 * Sole consumer since the No Activity Days admin module was retired: the
 * unified Deductions module's No Records Activity connector
 * (src/lib/deductions/connectors/no-records-activity.ts), which is the
 * successor surface for adjudicating these days.
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

  const [attendance, vacations, excuses, doubleVisits, fieldVisits, attendancePolicyRows, ...holidaysByMonth] =
    await Promise.all([
      loadAttendanceItems(hrIds, input.start, input.end),
      loadVacationItems(hrIds, input.start, input.end),
      loadExcuseItems(hrIds, input.start, input.end),
      loadDoubleVisitPrivateCalendarItems(hrIds, input.start, input.end),
      // A rep's OWN solo visits prove field work exactly as a double visit does.
      // Only the double-visit feed was ever wired in, so 86% of field work was
      // invisible here — see loadFieldVisitPrivateCalendarItems.
      loadFieldVisitPrivateCalendarItems(hrIds, input.start, input.end),
      loadAttendancePolicyScheduleRows(),
      ...months.map(({ year, month }) => loadHolidayItems(year, month, input.start, input.end)),
    ]);

  const allItems = decorateItemsWithEmployeeMetadata(filterItemsByEmployees([
    ...attendance.items,
    ...vacations.items,
    ...excuses.items,
    ...holidaysByMonth.flat(),
    ...doubleVisits.items,
    ...fieldVisits.items,
  ], employees), employees);

  // Same per-employee suppression the calendar workspace uses. This path spans
  // the ENTIRE roster, so keying on the date alone would let one employee's
  // double visit erase every colleague's punches for that date and report them
  // as "No Activity Recorded" — which becomes a payroll deduction candidate.
  const items = suppressFieldVisitAttendanceProblems(allItems);

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
