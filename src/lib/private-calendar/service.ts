import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendancePolicyGroups } from "@/lib/attendance/policy-groups";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";
import { monthBounds, rangesOverlap, buildMonthGrid } from "@/lib/calendar/logic";
import { loadDoubleVisitPrivateCalendarItems } from "@/lib/double-visit-analytics/service";
import { loadFieldVisitPrivateCalendarItems } from "@/lib/private-calendar/field-visits";
import { loadManagerOwnVisitPrivateCalendarItems } from "@/lib/private-calendar/manager-own-visit-items";
import { loadPhoenixWorkEvidencePrivateCalendarItems, withoutDoorCoveredPhoenixWork } from "@/lib/private-calendar/phoenix-work-evidence-items";
import { getEmployeeDirectoryRows, isActiveDirectoryEmployee, isWithinNoticePeriod } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { listDisputesForEmployee, type PrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { listMessagesForDisputes } from "@/lib/private-calendar/dispute-messages";
import { loadPlanPrivateCalendarItems } from "@/lib/private-calendar/plan-items";
import { attachVisitDetails, loadPrivateCalendarVisitDetails } from "@/lib/private-calendar/visit-detail-items";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getCompanyHolidaysForMonth } from "@/lib/vacation/company-holidays";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import {
  buildPrivateCalendarHierarchyIndex,
  canReadPrivateCalendarEmployee,
  buildAcceptedCorrectionItems,
  buildPrivateCalendarTeamSummary,
  configuredPrivateCalendarGlobalHrIds,
  derivePrivateCalendarExceptions,
  isPrivateCalendarGlobalViewer,
  isWithinEmploymentWindow,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapHolidayToPrivateCalendarItem,
  mapPrivateCalendarEmployee,
  mapVacationRowToPrivateCalendarItem,
  privateCalendarHrIdKey,
  privateCalendarItemOccursOn,
  privateCalendarSources,
  readAllPrivateCalendarRows,
  resolvePrivateCalendarVisibleEmployees,
  suppressFieldVisitAttendanceProblems,
  summarizePrivateCalendarItems,
  withoutCorrectedDayFindings,
  type PrivateCalendarEmployeeOption,
  type PrivateCalendarException,
  type PrivateCalendarItem,
  type PrivateCalendarSource,
  type PrivateCalendarReviewMessage,
  type PrivateCalendarReviewRequest,
  type PrivateCalendarViewMode,
  type PrivateCalendarWorkspace,
} from "@/lib/private-calendar/logic";
import { summarizePrivateCalendarVisits } from "@/lib/private-calendar/activity-kinds";

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
  // The area the day tile falls back to when an entry names none of its own (field-visit and own-visit entries carry no area).
  const areaByHrId = new Map(employees.map((employee) => [privateCalendarHrIdKey(employee.hrId), employee.areaName]));
  return items.map((item) => {
    if (!item.employeeHrId) return item;
    const employee = byHrId.get(privateCalendarHrIdKey(item.employeeHrId));
    if (!employee) return item;
    return {
      ...item,
      employeeAreaName: areaByHrId.get(privateCalendarHrIdKey(item.employeeHrId)) ?? null,
      employeeDepartmentName: employee.departmentName,
      employeeJobTitle: employee.jobTitle,
      employeeLineName: employee.lineName,
      // The directory's display name wins over the one a source row carries: a vacation row
      // stores the legal name the request was filed under ("Mina Farouk Nawar Rizkallah"),
      // which made one person read as two different people across a team calendar.
      employeeName: employee.fullName || item.employeeName,
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
    // ONE EMPLOYEE → HIS REPORT ONLY (2026-10-01, "slow to transfer between page and page"): unlocked,
    // the report builds the whole company's month — every punch, and six per-person lookups for
    // everyone who punched — for a calendar showing one person. Locked with exactEmployeeHrId, as the
    // self-service attendance page already is (employee-attendance.ts), it reads only his punches and
    // builds only his rows, which are the rows the filter below kept from the company-wide report. The
    // filter stays the authority on what is shown.
    const report = await getFingerprintAttendanceReport(
      employeeHrIds.length === 1
        ? { dateFrom: start, dateTo: end, exactEmployeeHrId: employeeHrIds[0] }
        : { dateFrom: start, dateTo: end },
    );
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
    // Paged — never a fixed limit (see readAllPrivateCalendarRows).
    const rows = await readAllPrivateCalendarRows<VacationCalendarRow>((from, to) => getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("id,employee_hr_id,employee_name,start_date,end_date,vacation_type,status,manager_decision,day_part,duration_days,paid_duration_days,payment_status,notes")
      .in("status", ["needs_assignment", "pending_manager", "pending_hr", "approved", "submitted"])
      .in("employee_hr_id", employeeHrKeys)
      .lte("start_date", end)
      .gte("end_date", start)
      .order("start_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to));
    // Covered = the manager has signed off (manager_decision='approved', which
    // also implies status='pending_hr') or HR has recorded it (status='approved').
    // Everything else is a live pending request: it reserves the day on the
    // calendar (so attendance isn't flagged "missing") but renders as pending.
    return {
      items: rows.map((row) => {
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
    const rows = await readAllPrivateCalendarRows<ExcuseCalendarRow>((from, to) => getSupabaseAdmin()
      .from("v2_excuse_requests")
      .select("id,employee_hr_id,employee_name,excuse_date,excuse_type,duration_hours,status,manager_decision_comment")
      .eq("status", "approved")
      .in("employee_hr_id", employeeHrKeys)
      .gte("excuse_date", start)
      .lte("excuse_date", end)
      .order("excuse_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to));
    return { items: rows.map(mapExcuseRowToPrivateCalendarItem), ready: true };
  } catch (error) {
    if (schemaMissing(error, "v2_excuse_requests")) return { items: [], ready: false };
    throw error;
  }
}

// One expected-workday rule for both engines below. The employee's attendance policy decides
// the weekly-off days; the employment window then removes every day before the hire date and
// after the last working date (isWithinEmploymentWindow) — the directory row carries both.
function expectedWorkdayResolver(
  employees: EmployeeDirectoryRow[],
  attendancePolicyRows: Awaited<ReturnType<typeof loadAttendancePolicyScheduleRows>>,
) {
  const employmentWindows = new Map(employees.map((employee) => [
    privateCalendarHrIdKey(employee.hrId),
    { hireDate: employee.hireDate, lastWorkingDate: employee.lastWorkingDate },
  ]));
  return (employee: PrivateCalendarEmployeeOption, date: string) => {
    const employmentWindow = employmentWindows.get(privateCalendarHrIdKey(employee.hrId));
    if (employmentWindow && !isWithinEmploymentWindow(date, employmentWindow)) return false;
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
  };
}

export function canUsePrivateCalendarAdminSurface(access: AccessContext) {
  return isPrivateCalendarGlobalViewer(access);
}

/**
 * The employees the Private Calendar reads for a window starting on `fromDate`: the active directory,
 * plus anyone still inside a notice period that the window reaches.
 *
 * 🔴 WHY THE WIDER READ (owner, 2026-10-23: "drop after his resignation date not submission date").
 * `employees.employment_status` flips to `resigned` and `organogram_visible` to false the moment a
 * resignation is SUBMITTED, which took a Medical Representative off this calendar on 18 October for a
 * last working day of 31 October — while she went on logging 10 and 12 customer visits a day. Her
 * calendar could not be opened, and `getPrivateCalendarDayEvidence` answered the System Audit with an
 * empty day, which it reported as 22 logged visits "lost at the calendar itself" (VISIT-S4-MISSING).
 * A leaver drops off the day AFTER their exit day, never at submission.
 *
 * `isWithinEmploymentWindow` still decides each individual DAY (see the attendance read below), so a
 * person included here contributes nothing outside their own employment — this only decides whose
 * data is read at all.
 *
 * NOT used by `getCompanyNoActivityDays`, which keeps the active-only roster on purpose; see the note
 * there.
 */
async function privateCalendarEmployees(fromDate: string): Promise<EmployeeDirectoryRow[]> {
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  return rows.filter((employee) => isActiveDirectoryEmployee(employee) || isWithinNoticePeriod(employee, fromDate));
}

export async function getPrivateCalendarWorkspace(input: {
  access: AccessContext;
  // Historically distinguished "what actually happened" from planned/intended activity, and it has
  // no effect: it does NOT drop the approved-plan source, which joined the calendar on 2026-10-07.
  // Deliberately so — the employee's own portal is the one caller that passes `true`, and he is
  // precisely the person whose approved Travel day used to read "No Activity Recorded". Hiding the
  // plan from him while letting it excuse the day would leave a blank day with no exception and
  // nothing on screen that explains either. Kept on the API surface for existing callers.
  actualOnly?: boolean;
  employeeHrId?: string | null;
  month: number;
  viewMode?: PrivateCalendarViewMode | string | null;
  year: number;
}): Promise<PrivateCalendarWorkspace> {
  await assertPermission(input.access, "employee_profile", "read");
  await assertPermission(input.access, "attendance", "read");

  const { start, end } = monthBounds(input.year, input.month);
  const employees = await privateCalendarEmployees(start);
  const globalHrIds = configuredPrivateCalendarGlobalHrIds();
  const byCanonicalHrId = buildPrivateCalendarHierarchyIndex(employees);
  const visibleEmployees = sortEmployees(
    employees.filter((employee) => canReadPrivateCalendarEmployee(input.access, employee, globalHrIds, { byCanonicalHrId })),
  );
  const selectedEmployee = selectedEmployeeFromRequest({
    access: input.access,
    employees,
    requestedEmployeeHrId: input.employeeHrId,
    visibleEmployees,
  });
  const viewMode = normalizeViewMode(input.viewMode);
  const scopeEmployees = viewMode === "team" ? visibleEmployees : [selectedEmployee];
  const scopeHrIds = scopeEmployees.map((employee) => employee.hrId);

  const [attendance, vacations, excuses, holidays, doubleVisits, fieldVisits, phoenixWork, managerOwnVisits, plans, attendancePolicyRows, disputesByEmployee, visitDetails] =
    await Promise.all([
      loadAttendanceItems(scopeHrIds, start, end),
      loadVacationItems(scopeHrIds, start, end),
      loadExcuseItems(scopeHrIds, start, end),
      loadHolidayItems(input.year, input.month, start, end),
      loadDoubleVisitPrivateCalendarItems(scopeHrIds, start, end),
      // The CRM accounts ride along so the field-visit read can find each person's own visits by
      // account as well as by HR id (see loadFieldVisitPrivateCalendarItems).
      loadFieldVisitPrivateCalendarItems(scopeHrIds, start, end, scopeEmployees.map((employee) => employee.crmId)),
      // The Phoenix CRM work the read door above does NOT carry — a team the Super Admin has not
      // started yet. Without it those days render empty and read as "No Activity Recorded".
      loadPhoenixWorkEvidencePrivateCalendarItems(scopeHrIds, start, end),
      // His OWN single visits (owner, 2026-10-19): since 16 Oct they are written to his own record,
      // which no door above reads — a manager's whole day of them rendered empty here.
      // The workspace names every visit in full (owner, 2026-10-20); the company-wide pass below stays a count.
      loadManagerOwnVisitPrivateCalendarItems(scopeHrIds, start, end, { details: true }),
      // The approved weekly plan — the only evidence a manager-approved Travel, Admin or Meeting day
      // ever produces. It covers the day for those types only; see lib/private-calendar/plan-items.ts.
      loadPlanPrivateCalendarItems(scopeHrIds, start, end),
      loadAttendancePolicyScheduleRows(),
      // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): a dispute is read by
      // employee and date range alone — nothing loaded beside it feeds it — so it loads with the
      // sources instead of after them. Each employee's read still falls back to none on failure.
      Promise.all(
        scopeEmployees.map((employee) => listDisputesForEmployee({ employeeHrId: employee.hrId, end, start }).catch(() => [])),
      ),
      // EVERY Phoenix CRM visit in full, not only a manager's own (owner, 2026-10-21: "everyone, exactly as Mina
      // Farouk") — hung on the entry that already counts it, never an entry of its own. Best-effort: none on failure.
      loadPrivateCalendarVisitDetails(scopeHrIds, start, end),
    ]);

  const allItems = attachVisitDetails(decorateItemsWithEmployeeMetadata(filterItemsByEmployees([
    ...attendance.items,
    ...vacations.items,
    ...excuses.items,
    ...holidays,
    ...doubleVisits.items,
    ...fieldVisits.items,
    ...withoutDoorCoveredPhoenixWork(phoenixWork.items, [...fieldVisits.items, ...doubleVisits.items]),
    ...managerOwnVisits.items,
    ...plans.items,
  ], scopeEmployees), employees), visitDetails)
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
    isExpectedWorkday: expectedWorkdayResolver(scopeEmployees, attendancePolicyRows),
    items,
    start,
  });
  const sourceReadiness: Record<PrivateCalendarSource, boolean> = {
    attendance: attendance.ready,
    // Review requests are read best-effort (none on failure), never a source the day depends on.
    correction: true,
    double_visit: doubleVisits.ready,
    excuse: excuses.ready,
    // One readiness flag, because both loaders answer the same question: is this employee's own
    // field work readable? A degraded answer from either leaves the day under-covered.
    field_visit: fieldVisits.ready && phoenixWork.ready && managerOwnVisits.ready,
    holiday: true,
    plan: plans.ready,
    vacation: vacations.ready,
  };

  const employeeDisputes = disputesByEmployee.flat();
  const itemsWithCorrections = applyAcceptedDisputeOverlays(items, employeeDisputes);
  // An accepted whole-day request is an entry of its own, and the day it verifies stops reading "No Activity Recorded".
  const correctionItems = decorateItemsWithEmployeeMetadata(buildAcceptedCorrectionItems(employeeDisputes), employees);
  const exceptionsWithStatuses = appendDisputeStatusExceptions(withoutCorrectedDayFindings(exceptions, correctionItems), employeeDisputes);

  // The reply thread under each request. One batched read for the whole month, and best-effort: a
  // thread that fails to load must leave the calendar itself intact, so it falls back to none — the
  // same contract the dispute read above already has.
  const messagesByDispute = await listMessagesForDisputes(employeeDisputes.map((dispute) => dispute.id))
    .catch(() => new Map<string, PrivateCalendarReviewMessage[]>());
  const reviewRequests: PrivateCalendarReviewRequest[] = employeeDisputes
    .map((dispute) => ({
      claimSourceText: dispute.claimSourceText,
      claimText: dispute.claimText,
      createdAt: dispute.createdAt,
      date: dispute.disputeDate,
      decidedAt: dispute.decidedAt,
      decisionNote: dispute.adminDecisionNote,
      employeeHrId: dispute.employeeHrId,
      employeeName: dispute.employeeName,
      id: dispute.id,
      messages: messagesByDispute.get(dispute.id) ?? [],
      status: dispute.status,
    }))
    .sort((left, right) => `${left.date}-${left.createdAt}`.localeCompare(`${right.date}-${right.createdAt}`));

  const displayItems = [...itemsWithCorrections, ...correctionItems]
    .sort((left, right) => `${left.startDate}-${left.employeeName ?? ""}-${left.source}-${left.title}`.localeCompare(`${right.startDate}-${right.employeeName ?? ""}-${right.source}-${right.title}`));

  return {
    access: {
      canSelectEmployee: visibleEmployees.length > 1,
      isGlobalViewer: isPrivateCalendarGlobalViewer(input.access, globalHrIds),
    },
    items: displayItems,
    month: input.month,
    reviewRequests,
    schemaReady: privateCalendarSources.every((source) => sourceReadiness[source]),
    selectedEmployee: mapPrivateCalendarEmployee(selectedEmployee),
    sourceReadiness,
    summary: summarizePrivateCalendarItems(displayItems),
    visitSummary: summarizePrivateCalendarVisits(displayItems),
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

  // ACTIVE ONLY, deliberately — unlike the calendar reads above, which cover a notice period
  // (isWithinNoticePeriod). This engine is what the Deductions No Records Activity connector and the
  // weekly gap notice call, so widening it would start raising deduction candidates against people
  // working out their notice. That is the owner's call in the Deductions module, not a side effect here.
  const employees = await getEmployeeDirectoryRows();
  const hrIds = employees.map((employee) => employee.hrId);
  const months = monthsTouchedByRange(input.start, input.end);

  const [attendance, vacations, excuses, doubleVisits, fieldVisits, phoenixWork, managerOwnVisits, plans, attendancePolicyRows, ...holidaysByMonth] =
    await Promise.all([
      loadAttendanceItems(hrIds, input.start, input.end),
      loadVacationItems(hrIds, input.start, input.end),
      loadExcuseItems(hrIds, input.start, input.end),
      loadDoubleVisitPrivateCalendarItems(hrIds, input.start, input.end),
      // A rep's OWN solo visits prove field work exactly as a double visit does.
      // Only the double-visit feed was ever wired in, so 86% of field work was
      // invisible here — see loadFieldVisitPrivateCalendarItems.
      loadFieldVisitPrivateCalendarItems(hrIds, input.start, input.end),
      // 🔴 AND THE PHOENIX CRM WORK THE DOOR ABOVE CANNOT SERVE. The door's Phoenix branches are
      // inner-joined to the STARTED teams, so a rep on a team the Super Admin has not started yet
      // arrives here with nothing at all and his worked day becomes a deduction candidate. Measured
      // on production 2026-10-12: 121 Phoenix visits over 17 person-days, 7–12 October, each of those
      // days carrying 0 iReports360 rows. See phoenix-work-evidence-items.ts.
      loadPhoenixWorkEvidencePrivateCalendarItems(hrIds, input.start, input.end),
      // 🔴 AND A MANAGER'S OWN SINGLE VISITS (owner, 2026-10-19, "count it on both"). Since 16 Oct a
      // district manager's own visit goes to his own record, which neither door above reads, so a day
      // he spent entirely on them arrived here as nothing at all. Measured on production 2026-10-19:
      // two district managers with no CRM row, no punch, no vacation and no trip between them.
      loadManagerOwnVisitPrivateCalendarItems(hrIds, input.start, input.end),
      // The SAME approved-plan source the calendar workspace reads. It has to be here too: this path
      // is what the Deductions module's No Records Activity connector adjudicates, so a day the
      // employee's own calendar shows as covered by an approved plan must not arrive there as a
      // deduction candidate — the two can never be allowed to disagree.
      loadPlanPrivateCalendarItems(hrIds, input.start, input.end),
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
    ...withoutDoorCoveredPhoenixWork(phoenixWork.items, [...fieldVisits.items, ...doubleVisits.items]),
    ...managerOwnVisits.items,
    ...plans.items,
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
    isExpectedWorkday: expectedWorkdayResolver(employees, attendancePolicyRows),
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

// ── What Phoenix already holds for one disputed day ──────────────────────────────────────────────

export type PrivateCalendarDayEvidence = {
  date: string;
  employeeHrId: string;
  /** Every calendar item Phoenix holds for that employee on that day, from the SAME seven sources the calendar reads. */
  items: PrivateCalendarItem[];
  /**
   * Sources that could not be read at all. Load-bearing: without it an unreadable source would
   * render as "Phoenix has nothing for this day", which is exactly the confident blank that makes a
   * reviewer reject a true claim.
   */
  unreadableSources: PrivateCalendarSource[];
};

function dayEvidenceKey(employeeHrId: string, date: string) {
  return `${privateCalendarHrIdKey(employeeHrId)}|${date}`;
}

/**
 * The calendar record behind a handful of specific (employee, day) pairs — what the Calendar
 * Disputes inbox puts in front of the reviewer so he can answer "what is she disputing about?"
 * without opening her calendar and without asking her manager.
 *
 * Reads through the workspace's OWN loaders over a one-day window per pair, so the inbox and the
 * employee's calendar can never disagree about what that day holds. Deliberately NOT
 * getPrivateCalendarWorkspace: that one builds a whole month for one employee behind an
 * `employee_profile` + `attendance` permission assertion, and this is called for a set of employees
 * at once from a Super-Admin-only surface that has already gated itself.
 *
 * Returns nothing for a pair it could not resolve. Intended for small sets (the pending dispute
 * queue); it is not a reporting path.
 */
export async function getPrivateCalendarDayEvidence(
  days: ReadonlyArray<{ date: string; employeeHrId: string }>,
): Promise<Map<string, PrivateCalendarDayEvidence>> {
  const out = new Map<string, PrivateCalendarDayEvidence>();
  const wanted = days.filter((day) => day.employeeHrId && /^\d{4}-\d{2}-\d{2}$/.test(day.date));
  if (wanted.length === 0) return out;

  const start = wanted.map((day) => day.date).sort()[0];
  const end = wanted.map((day) => day.date).sort().at(-1) as string;
  const wantedKeys = new Set(wanted.map((day) => privateCalendarHrIdKey(day.employeeHrId)).filter(Boolean));

  const directory = await privateCalendarEmployees(start);
  const employees = directory.filter((employee) => wantedKeys.has(privateCalendarHrIdKey(employee.hrId)));
  if (employees.length === 0) return out;
  // Which of the asked employees the loaders below actually read. See the skip in the day loop.
  const read = new Set(employees.map((employee) => privateCalendarHrIdKey(employee.hrId)));
  const hrIds = employees.map((employee) => employee.hrId);
  const months = monthsTouchedByRange(start, end);

  const [visitDetails, attendance, vacations, excuses, doubleVisits, fieldVisits, phoenixWork, managerOwnVisits, plans, ...holidaysByMonth] = await Promise.all([
    // A reviewer reads every visit of the disputed day in full, the same record the calendar shows (owner, 2026-10-21).
    loadPrivateCalendarVisitDetails(hrIds, start, end),
    loadAttendanceItems(hrIds, start, end),
    loadVacationItems(hrIds, start, end),
    loadExcuseItems(hrIds, start, end),
    loadDoubleVisitPrivateCalendarItems(hrIds, start, end),
    loadFieldVisitPrivateCalendarItems(hrIds, start, end, employees.map((employee) => employee.crmId)),
    // Load-bearing on THIS pass above all: this is what a reviewer reads for a disputed day, and
    // without it a day the rep spent logging Phoenix CRM visits renders as "Phoenix has nothing for
    // this day" — the confident blank that makes a reviewer reject a true claim.
    loadPhoenixWorkEvidencePrivateCalendarItems(hrIds, start, end),
    // Load-bearing here for the same reason: a district manager disputing a day he spent on his own
    // single visits would otherwise be read against a blank (owner, 2026-10-19).
    loadManagerOwnVisitPrivateCalendarItems(hrIds, start, end, { details: true }),
    loadPlanPrivateCalendarItems(hrIds, start, end),
    ...months.map(({ year, month }) => loadHolidayItems(year, month, start, end)),
  ]);

  const unreadableSources: PrivateCalendarSource[] = [];
  if (!attendance.ready) unreadableSources.push("attendance");
  if (!vacations.ready) unreadableSources.push("vacation");
  if (!excuses.ready) unreadableSources.push("excuse");
  if (!doubleVisits.ready) unreadableSources.push("double_visit");
  if (!fieldVisits.ready || !phoenixWork.ready || !managerOwnVisits.ready) unreadableSources.push("field_visit");
  if (!plans.ready) unreadableSources.push("plan");

  // The same two passes the workspace runs: employee metadata on, then the field-visit suppression
  // keyed on (employee, date). Skipping the suppression would show a "Late" or "Single punch" flag
  // beside a CRM-verified visit and invite a rejection on a flag the calendar itself hides.
  const items = suppressFieldVisitAttendanceProblems(
    attachVisitDetails(decorateItemsWithEmployeeMetadata(
      [
        ...attendance.items,
        ...vacations.items,
        ...excuses.items,
        ...doubleVisits.items,
        ...fieldVisits.items,
        ...withoutDoorCoveredPhoenixWork(phoenixWork.items, [...fieldVisits.items, ...doubleVisits.items]),
        ...managerOwnVisits.items,
        ...plans.items,
      ],
      directory,
    ), visitDetails),
  );
  // Holidays carry no employee, so they are matched by date alone and appended per pair below.
  const holidays = holidaysByMonth.flat();

  for (const day of wanted) {
    const key = dayEvidenceKey(day.employeeHrId, day.date);
    if (out.has(key)) continue;
    const employeeKey = privateCalendarHrIdKey(day.employeeHrId);
    // 🔴 AN EMPLOYEE NOBODY READ IS NOT A DAY WITH NOTHING ON IT. Every loader above was given
    // `hrIds` — the asked employees this calendar covers — so for anyone else the filter below can
    // only ever return [], and writing the entry anyway answered "readable, and the day is empty".
    // That confident blank is what made the System Audit report 12 logged customer visits as "lost
    // at the calendar itself" (VISIT-S4-MISSING, 23 October 2026) and would have had a dispute
    // reviewer read a true claim against a blank. No entry at all is the honest answer, and every
    // caller already reads a missing one as "could not be read".
    if (!employeeKey || !read.has(employeeKey)) continue;
    out.set(key, {
      date: day.date,
      employeeHrId: day.employeeHrId,
      items: [
        ...items.filter(
          (item) => privateCalendarHrIdKey(item.employeeHrId) === employeeKey && privateCalendarItemOccursOn(item, day.date),
        ),
        ...holidays.filter((item) => privateCalendarItemOccursOn(item, day.date)),
      ],
      unreadableSources,
    });
  }
  return out;
}
