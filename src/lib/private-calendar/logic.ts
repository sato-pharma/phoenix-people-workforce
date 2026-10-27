import { canonicalHrIdKey, normalizeHrIdForAccess } from "@/lib/hr-id";
import { sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import type { AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";
import { VACATION_DAY_PARTS } from "@/lib/vacation/types";
import type { VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import type { ManagerDayPlan } from "@/lib/phoenix-crm/manager-day-plan";
import type { ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import type { DisputeAttachment } from "@/lib/dispute-center/types.ts";
import { isWithinManagerHierarchy, type SeatContinuitySubject } from "@/lib/workforce/hierarchy-resolver";
import {
  summarizePrivateCalendarVisits,
  type PrivateCalendarActivityKind,
  type PrivateCalendarVisitRecord,
  type PrivateCalendarVisitSummary,
} from "@/lib/private-calendar/activity-kinds";

export type PrivateCalendarSource = "attendance" | "double_visit" | "excuse" | "field_visit" | "holiday" | "plan" | "vacation";
export type PrivateCalendarSeverity = "danger" | "info" | "success" | "warning";
export type PrivateCalendarViewMode = "employee" | "team";

export const privateCalendarSources = ["attendance", "vacation", "excuse", "holiday", "double_visit", "field_visit", "plan"] as const satisfies readonly PrivateCalendarSource[];

export const privateCalendarSourceLabels: Record<PrivateCalendarSource, string> = {
  attendance: "Attendance",
  double_visit: "Double Visit",
  excuse: "Excuse",
  field_visit: "Field Visit",
  holiday: "National vacation",
  plan: "Approved plan",
  vacation: "Vacation",
};

// The HR Manager sees every private calendar. That person also holds the system-administrator
// console, so both of their HR_IDs qualify — sourced from the shared-identity groups rather than
// listed here, which previously covered "admin-HR" but silently missed "PHX-1".
export const defaultPrivateCalendarGlobalHrIds: readonly string[] = Array.from(sharedIdentityKeys("B-10"));

export type PrivateCalendarEmployeeOption = {
  departmentName: string | null;
  fullName: string;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
};

export type PrivateCalendarReportDetails = {
  checkIn: string | null;
  checkOut: string | null;
  scheduledTime: string | null;
  workingHours: string | null;
};

/** A person a visit entry was made with, as the day tile names them. */
export type PrivateCalendarTilePerson = { hrId: string | null; name: string };

export type PrivateCalendarItem = {
  // The colour the item wears — who went (single, double, chain) crossed with regular or campaign
  // for a CRM visit; attendance, vacation, excuse, holiday or other CRM activity otherwise. Absent
  // on items that predate the colour key: privateCalendarItemKind falls back by source.
  activityKind?: PrivateCalendarActivityKind;
  approvalImpact: string | null;
  // Short, stacked lines for the cramped month-grid day-cell chip (e.g. ["Double · Regular",
  // "With Omar", "AM 4 · PM 8 · Pharmacies 2", "Nasr City"]). Falls back to `title` on a single
  // line when absent.
  chipLines?: string[];
  description: string | null;
  detailLines: string[];
  employeeAreaName?: string | null;
  employeeDepartmentName: string | null;
  employeeHrId: string | null;
  employeeJobTitle: string | null;
  employeeLineName: string | null;
  employeeName: string | null;
  endDate: string;
  exceptionFlags: string[];
  id: string;
  managerName: string | null;
  // Only on a `plan` item: whether Phoenix records that kind of day nowhere else (Travel, Admin,
  // Meeting, Training, Event, Other), so somebody comparing the plan against the actual should expect
  // to find nothing beside it. False on a planned Field, Double Visit, Office, Vacation, Excuse or
  // National Vacation day, where the CRM, the fingerprint, the leave request or the holiday calendar
  // is the record — see lib/private-calendar/plan-items.ts. 🔴 A DISPLAY fact only: a weekly plan
  // excuses no day, whatever its title (owner, 2026-10-12). The flag is decided at read time and
  // carried on the item so the exceptions engine below stays free of a database import.
  plannedActivityIsRecordedNowhereElse?: boolean;
  reportDetails?: PrivateCalendarReportDetails | null;
  severity: PrivateCalendarSeverity;
  source: PrivateCalendarSource;
  sourceLabel: string;
  sourceRecordId: string | null;
  sourceSystem: string;
  sourceTable: string | null;
  startDate: string;
  status: string | null;
  // The areas a visit entry covered and the people it was made with, as plain lists, for the month grid's day tile
  // (owner, 2026-10-23: the tile shows counts and tags, never a customer). Set by the loaders that know them; the tile
  // reads them through privateCalendarDayTile and falls back to the employee's own area. Never parsed back out of `chipLines`.
  tileAreas?: string[];
  tileWith?: string[];
  // The same people as `tileWith`, each WITH their HR id where the loader knows it. The tile dedupes on the id, because
  // one person reaches it under two spellings — the visit mirror's full name and Phoenix's nickname — and printed twice
  // ("With Hana Abdelaziz Samir Abdelaziz, Hana Abdelaziz", audit 2026-10-26).
  tileWithPeople?: PrivateCalendarTilePerson[];
  time: string | null;
  title: string;
  // A CRM visit item's visits, AM · PM · Pharmacies apart (never a pharmacy inside PM). Null on
  // every other item.
  visitCounts?: VisitCountSplit | null;
  // The physical visits behind a double or chain item. The same visit sits on the calendar of
  // everyone on it, so a team view counts it once by these ids (summarizePrivateCalendarVisits).
  visitRecords?: PrivateCalendarVisitRecord[];
  // A district manager's OWN single visits behind a `manager-own-visit` item, in full — customer, address, brick,
  // half, clock, who came along (owner, 2026-10-20). Since 2026-10-23 the item's `visitCounts` carries their split, in his figures alone.
  managerVisits?: ManagerDayVisit[];
  // The day's plan behind those visits, so a screen can set the two side by side (owner, 2026-10-20). Absent when the
  // plan was not asked for; `managerPlanUnread` says it was asked for and could not be read.
  managerPlan?: ManagerDayPlan;
  managerPlanUnread?: boolean;
};

export type PrivateCalendarException = {
  code: string;
  date: string;
  description: string;
  employeeHrId: string | null;
  employeeName: string | null;
  id: string;
  relatedItemIds: string[];
  severity: Exclude<PrivateCalendarSeverity, "success">;
  title: string;
};

export type PrivateCalendarTeamSummary = PrivateCalendarEmployeeOption & {
  exceptionCount: number;
  itemCount: number;
  sourceCounts: Record<PrivateCalendarSource, number>;
  // Every visit on this person's calendar — single, double and chain — AM · PM · Pharmacies apart.
  visitCounts: VisitCountSplit;
};

/** One reply on a review request. The author's NAME, never his id — the owner's standing rule. */
export type PrivateCalendarReviewMessage = {
  /** Pictures riding on this reply (owner, 2026-10-09: "upload a picture in both"). */
  attachments?: DisputeAttachment[];
  authorHrId: string;
  authorIsAdmin: boolean;
  authorName: string | null;
  body: string;
  createdAt: string;
  id: string;
};

/**
 * A review request on one day, with the conversation under it.
 *
 * The request's own `claimText` is the first thing said in that conversation and is NOT repeated in
 * `messages` — whoever renders the thread shows the claim, then the replies.
 */
export type PrivateCalendarReviewRequest = {
  claimSourceText: string;
  claimText: string;
  createdAt: string;
  date: string;
  decidedAt: string | null;
  decisionNote: string | null;
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  messages: PrivateCalendarReviewMessage[];
  /** Pictures the employee attached to the request itself. */
  openingAttachments?: DisputeAttachment[];
  status: "accepted" | "pending_review" | "rejected";
};

export type PrivateCalendarWorkspace = {
  access: {
    canSelectEmployee: boolean;
    isGlobalViewer: boolean;
  };
  exceptions: PrivateCalendarException[];
  items: PrivateCalendarItem[];
  month: number;
  /** The review requests touching the month in view, each carrying its own reply thread. */
  reviewRequests: PrivateCalendarReviewRequest[];
  schemaReady: boolean;
  selectedEmployee: PrivateCalendarEmployeeOption;
  sourceReadiness: Record<PrivateCalendarSource, boolean>;
  summary: Record<PrivateCalendarSource, number> & { total: number };
  teamSummary: PrivateCalendarTeamSummary[];
  // The visits in view per colour, AM · PM · Pharmacies apart — a double or chain visit counted
  // once however many of the people on it the view holds.
  visitSummary: PrivateCalendarVisitSummary;
  visibleEmployees: PrivateCalendarEmployeeOption[];
  viewMode: PrivateCalendarViewMode;
  weeks: Array<Array<{ date: string | null; inMonth: boolean }>>;
  year: number;
};

export type PrivateCalendarAttendanceRow = {
  actualFirstPunch: string;
  actualLastPunch: string;
  dateIso: string;
  deductionDays: string;
  earlyLeaveMinutes: string;
  employeeHrId: string;
  employeeName: string;
  // Set when an approved Am/Pm-Only vacation covered the other half of this
  // day — a "Complete" status here means the (halved) required presence was
  // met, not that the employee worked a full day.
  halfDayVacationPart?: "am_only" | "pm_only";
  hasException?: boolean;
  lateMinutes: string;
  recommendedAction: string;
  scheduledEnd: string;
  scheduledStart: string;
  status: string;
  timeLong: string;
};

export type PrivateCalendarVacationRow = {
  day_part?: string | null;
  duration_days?: number | string | null;
  employee_hr_id: string;
  employee_name?: string | null;
  end_date: string | null;
  id: string;
  notes?: string | null;
  paid_duration_days?: number | string | null;
  payment_status?: string | null;
  start_date: string;
  status: string | null;
  vacation_type?: string | null;
};

export type PrivateCalendarExcuseRow = {
  duration_hours?: number | string | null;
  employee_hr_id: string;
  employee_name?: string | null;
  excuse_date: string;
  excuse_type: string | null;
  id: string;
  manager_decision_comment?: string | null;
  status: string | null;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const text = cleanText(value);
  return text ? text : null;
}

export function privateCalendarHrIdKey(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  const a = privateCalendarHrIdKey(left);
  const b = privateCalendarHrIdKey(right);
  return Boolean(a && b && a === b);
}

export function configuredPrivateCalendarGlobalHrIds() {
  const configured = String(process.env.PHOENIX_PRIVATE_CALENDAR_GLOBAL_HR_IDS ?? "")
    .split(",")
    .map((value) => privateCalendarHrIdKey(value))
    .filter(Boolean);
  const defaults = defaultPrivateCalendarGlobalHrIds.map((value) => privateCalendarHrIdKey(value));
  return Array.from(new Set([...defaults, ...configured]));
}

export function isPrivateCalendarGlobalViewer(
  access: AccessContext,
  globalHrIds: readonly string[] = configuredPrivateCalendarGlobalHrIds(),
) {
  // HR Resourcing — the Talent Acquisition seat — added 2026-10-08: the owner ticked Private
  // Calendars for her on the access blueprint.
  if (
    access.scope === "system" ||
    access.role === "CEO" ||
    access.role === "Super Admin" ||
    access.role === "HR Resourcing"
  ) {
    return true;
  }
  const allowed = new Set(globalHrIds.map((value) => privateCalendarHrIdKey(value)).filter(Boolean));
  return [access.hrId, access.loginId].some((value) => allowed.has(privateCalendarHrIdKey(value)));
}

export function canReadPrivateCalendarEmployee(
  access: AccessContext,
  employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId"> & { pendingManagerReplacementForHrId?: string | null },
  globalHrIds?: readonly string[],
  options?: { byCanonicalHrId?: ReadonlyMap<string, SeatContinuitySubject> },
) {
  if (isPrivateCalendarGlobalViewer(access, globalHrIds)) return true;
  if (hrIdsMatch(access.hrId, employee.hrId) || hrIdsMatch(access.loginId, employee.hrId)) return true;
  if (hrIdsMatch(access.hrId, employee.managerHrId) || hrIdsMatch(access.loginId, employee.managerHrId)) return true;
  // EVERY MANAGER SEAT SEES HIS WHOLE TEAM BENEATH HIM, NOT ONLY HIS DIRECT REPORTS (owner,
  // 2026-10-27: "apply that same whole-team rule"). A Marketing Manager whose Product Manager
  // reports to his Group Product Manager could pick the Group Product Manager and not the Product
  // Manager below her. The seats are the fingerprint attendance's isHierarchyAttendanceViewer —
  // `hierarchy` (Regional), `line` (National Sales, Product, Group Product, Marketing) and `team`
  // (District Manager, Manager) — so a manager who can open someone's attendance can open his
  // calendar too. Downward only: a peer or a manager above is never reached.
  if (
    options?.byCanonicalHrId &&
    (access.scope === "hierarchy" || access.scope === "line" || access.scope === "team")
  ) {
    const viewerKey = canonicalHrIdKey(access.hrId);
    if (!viewerKey) return false;
    return isWithinManagerHierarchy({
      employee: {
        managerHrId: employee.managerHrId,
        pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId ?? null,
      },
      byCanonicalHrId: options.byCanonicalHrId,
      viewerCanonicalHrId: viewerKey,
      canonicalize: (value) => canonicalHrIdKey(value),
    });
  }
  return false;
}

/** The seat-continuity index canReadPrivateCalendarEmployee climbs for a Regional or National Sales Manager. */
export function buildPrivateCalendarHierarchyIndex(
  rows: readonly (Pick<EmployeeDirectoryRow, "hrId" | "managerHrId"> & { pendingManagerReplacementForHrId?: string | null })[],
): Map<string, SeatContinuitySubject> {
  const index = new Map<string, SeatContinuitySubject>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (!key) continue;
    index.set(key, {
      managerHrId: row.managerHrId,
      pendingManagerReplacementForHrId: row.pendingManagerReplacementForHrId ?? null,
    });
  }
  return index;
}

export function mapPrivateCalendarEmployee(employee: EmployeeDirectoryRow): PrivateCalendarEmployeeOption {
  return {
    departmentName: employee.departmentName,
    fullName: employee.displayName,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle || employee.positionTitle,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    managerName: employee.managerName,
  };
}

export function resolvePrivateCalendarVisibleEmployees(
  access: AccessContext,
  employees: EmployeeDirectoryRow[],
  globalHrIds?: readonly string[],
) {
  const byCanonicalHrId = buildPrivateCalendarHierarchyIndex(employees);
  return employees
    .filter((employee) => canReadPrivateCalendarEmployee(access, employee, globalHrIds, { byCanonicalHrId }))
    .map(mapPrivateCalendarEmployee)
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function displayEnum(value: string | null | undefined, fallback = "Other") {
  const text = cleanText(value);
  if (!text) return fallback;
  return text
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

// "Complete" reads as "Full day" (an office-hours label the employee recognizes);
// every other status keeps its own wording (Late, Short day, Single punch, ...).
// EXCEPT when an approved half-day vacation covered the other half of the shift —
// that "Complete" was judged against a halved requirement, so it must read "Half
// day" (a normal half working day, the other half being a normal half-day
// vacation), never "Full day" — the employee did not work the full day.
function attendanceStatusLabel(status: string, halfDayVacationPart?: "am_only" | "pm_only") {
  if (status === "Complete" && halfDayVacationPart) return "Half day";
  return status === "Complete" ? "Full day" : status || "Recorded";
}

// A day with ONE punch cannot say whether that punch was the arrival or the departure (a
// 5:06 PM punch is almost certainly a check-out), so it reads as a bare "Punch", never "From".
function attendanceTitle(status: string, checkIn: string | null, checkOut: string | null, halfDayVacationPart?: "am_only" | "pm_only") {
  const statusLabel = attendanceStatusLabel(status, halfDayVacationPart);
  if (checkIn && checkOut) return `Office ${checkIn} to ${checkOut} - ${statusLabel}`;
  if (checkIn) return `Office punch ${checkIn} - ${statusLabel}`;
  return `Attendance - ${statusLabel}`;
}

// Stacked chip lines for the month-grid day cell: Office / From ** / To ** / Full day.
function attendanceChipLines(status: string, checkIn: string | null, checkOut: string | null, halfDayVacationPart?: "am_only" | "pm_only") {
  const statusLabel = attendanceStatusLabel(status, halfDayVacationPart);
  if (checkIn && checkOut) return ["Office", `From ${checkIn}`, `To ${checkOut}`, statusLabel];
  if (checkIn) return ["Office", `Punch ${checkIn}`, statusLabel];
  return ["Attendance", statusLabel];
}

// The chip's colour follows the SAME judgement the exception strip makes, never the raw status
// word: a "Short day" or "Late" that lands in a zero-deduction band raises no flag (see
// attendanceExceptionFlags), so it must not paint amber either — it used to, which showed an
// employee a warning on a day the strip itself said needed no review.
function attendanceSeverity(status: string, flags: string[], hasException?: boolean): PrivateCalendarSeverity {
  const problems = flags.filter((flag) => flag !== "Approved attendance exception");
  if (problems.includes("Absence risk")) return "danger";
  if (problems.length > 0) return "warning";
  if (hasException || status === "Complete") return "success";
  return "info";
}

function positiveNumber(value: unknown) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0;
}

function attendanceExceptionFlags(row: PrivateCalendarAttendanceRow) {
  const flags: string[] = [];
  const status = cleanText(row.status);
  const action = cleanText(row.recommendedAction);
  // A missing punch is never auto-deducted (see evaluateFlexibleHoursDay) — it's
  // routed to a human verification chain before any deduction is even decided,
  // so its deductionDays is always a placeholder 0, not a real "no cost" answer.
  // It must stay flagged regardless of that placeholder.
  if (/single punch/i.test(status) || (!row.actualLastPunch && row.actualFirstPunch)) flags.push("Single punch");
  // Every other attendance status is already fully computed against the policy's
  // deduction brackets, so deductionDays reliably tells us whether this specific
  // day will cost the employee anything. Late/short/early minutes can exist yet
  // still land in a zero-deduction band (grace usage, a dead zone below the
  // first bracket, an early-leave/late combo where the other side "wins") — those
  // must read as plain informational status, not a "needs review" warning flag.
  const causesDeduction = positiveNumber(row.deductionDays);
  if (causesDeduction && (positiveNumber(row.lateMinutes) || /late/i.test(status))) flags.push("Late arrival");
  if (causesDeduction && (positiveNumber(row.earlyLeaveMinutes) || /early/i.test(status))) flags.push("Early leave");
  if (causesDeduction && (/short/i.test(status) || /short/i.test(action))) flags.push("Short day");
  if (causesDeduction && /absence|absent/i.test(status)) flags.push("Absence risk");
  if (row.hasException) flags.push("Approved attendance exception");
  return Array.from(new Set(flags));
}

export function mapAttendanceRowToPrivateCalendarItem(row: PrivateCalendarAttendanceRow): PrivateCalendarItem {
  const firstPunch = cleanText(row.actualFirstPunch);
  const lastPunch = cleanText(row.actualLastPunch);
  const scheduledStart = cleanText(row.scheduledStart);
  const scheduledEnd = cleanText(row.scheduledEnd);
  const scheduledTime = scheduledStart || scheduledEnd ? [scheduledStart, scheduledEnd].filter(Boolean).join(" - ") : null;
  const workingHours = nullableText(row.timeLong);
  const time = firstPunch && lastPunch ? `${firstPunch} - ${lastPunch}` : firstPunch || lastPunch || null;
  const exceptionFlags = attendanceExceptionFlags(row);
  const detailLines = [
    scheduledTime ? `Schedule: ${scheduledTime}` : null,
    workingHours ? `Working hours: ${workingHours}` : null,
    row.lateMinutes ? `Late: ${row.lateMinutes} min` : null,
    row.earlyLeaveMinutes ? `Early leave: ${row.earlyLeaveMinutes} min` : null,
    row.deductionDays ? `Deduction days: ${row.deductionDays}` : null,
    row.recommendedAction ? `Action: ${row.recommendedAction}` : null,
  ].filter((value): value is string => Boolean(value));
  return {
    approvalImpact: null,
    chipLines: attendanceChipLines(row.status, firstPunch || null, lastPunch || null, row.halfDayVacationPart),
    description: row.recommendedAction || null,
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: row.employeeHrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: row.employeeName,
    endDate: row.dateIso,
    exceptionFlags,
    id: `attendance-${privateCalendarHrIdKey(row.employeeHrId)}-${row.dateIso}`,
    managerName: null,
    reportDetails: {
      checkIn: firstPunch || null,
      checkOut: lastPunch || null,
      scheduledTime,
      workingHours,
    },
    severity: attendanceSeverity(row.status, exceptionFlags, row.hasException),
    source: "attendance",
    sourceLabel: "Imported fingerprint punches",
    sourceRecordId: `${privateCalendarHrIdKey(row.employeeHrId)}-${row.dateIso}`,
    sourceSystem: "Fingerprint attendance",
    sourceTable: "attendance_raw_punches",
    startDate: row.dateIso,
    status: row.status,
    time,
    title: attendanceTitle(row.status, firstPunch || null, lastPunch || null, row.halfDayVacationPart),
  };
}

// The vacation module's own wording ("AM only", "PM only"), never the title-cased enum
// ("Am Only") the generic displayEnum produced.
function vacationDayPartLabel(value: string | null | undefined) {
  const text = cleanText(value);
  if (!text) return null;
  return VACATION_DAY_PARTS.find((part) => part.value === text)?.label ?? displayEnum(text);
}

export function mapVacationRowToPrivateCalendarItem(
  row: PrivateCalendarVacationRow,
  options?: { pending?: boolean },
): PrivateCalendarItem {
  const type = displayEnum(row.vacation_type, "Vacation");
  const duration = cleanText(row.duration_days);
  const paid = cleanText(row.paid_duration_days);
  const pending = Boolean(options?.pending);
  return {
    approvalImpact: pending
      ? "A pending vacation request reserves the day on the private calendar until the manager approves or rejects it."
      : "Approved vacation appears on the employee private calendar and explains the covered attendance day.",
    description: nullableText(row.notes),
    detailLines: [
      duration ? `Duration: ${duration} day(s)` : null,
      paid ? `Paid: ${paid} day(s)` : null,
      row.payment_status ? `Payment: ${displayEnum(row.payment_status)}` : null,
      row.day_part ? `Day part: ${vacationDayPartLabel(row.day_part)}` : null,
    ].filter((value): value is string => Boolean(value)),
    employeeDepartmentName: null,
    employeeHrId: row.employee_hr_id,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: nullableText(row.employee_name),
    endDate: row.end_date || row.start_date,
    exceptionFlags: [],
    id: `vacation-${row.id}`,
    managerName: null,
    severity: pending ? "warning" : "info",
    source: "vacation",
    sourceLabel: pending ? "Vacation request (pending approval)" : "Approved vacation request",
    sourceRecordId: row.id,
    sourceSystem: "Vacation workflow",
    sourceTable: "v2_vacation_requests",
    startDate: row.start_date,
    status: row.status,
    time: row.day_part && row.day_part !== "full_day" ? vacationDayPartLabel(row.day_part) : "Full day",
    title: pending ? `${type} Vacation (pending)` : `${type} Vacation`,
  };
}

export function mapExcuseRowToPrivateCalendarItem(row: PrivateCalendarExcuseRow): PrivateCalendarItem {
  const excuseType = cleanText(row.excuse_type).toLowerCase() === "afternoon" ? "Afternoon" : "Morning";
  const duration = cleanText(row.duration_hours) || "2";
  return {
    approvalImpact: "Approved excuse appears on the employee private calendar as a 2-hour covered block.",
    description: nullableText(row.manager_decision_comment),
    detailLines: [`Duration: ${duration} hour(s)`],
    employeeDepartmentName: null,
    employeeHrId: row.employee_hr_id,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: nullableText(row.employee_name),
    endDate: row.excuse_date,
    exceptionFlags: [],
    id: `excuse-${row.id}`,
    managerName: null,
    // An APPROVED excuse is covered time, not something to review — "warning" painted it the
    // same amber as a late punch and tinted its export row as a problem.
    severity: "info",
    source: "excuse",
    sourceLabel: "Approved excuse request",
    sourceRecordId: row.id,
    sourceSystem: "Excuse workflow",
    sourceTable: "v2_excuse_requests",
    startDate: row.excuse_date,
    status: row.status,
    time: `${excuseType} (${duration}h)`,
    title: `${excuseType} Excuse`,
  };
}

export function mapHolidayToPrivateCalendarItem(input: {
  description?: string | null;
  endDate?: string | null;
  id: string;
  name: string;
  startDate: string;
}): PrivateCalendarItem {
  return {
    approvalImpact: null,
    description: input.description ?? null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: null,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: input.endDate || input.startDate,
    exceptionFlags: [],
    id: `holiday-${input.id}`,
    managerName: null,
    severity: "success",
    source: "holiday",
    sourceLabel: "Configured national vacation",
    sourceRecordId: input.id,
    sourceSystem: "Holiday calendar",
    sourceTable: null,
    startDate: input.startDate,
    status: "holiday",
    time: "Full day",
    title: input.name,
  };
}

// PostgREST answers at most 1,000 rows per request, and both leave loaders used to stop at a
// fixed 100 — a team or company-wide month past 100 leave rows silently lost the rest, and every
// lost day then read "No Activity Recorded" although the leave was approved. Reads page by page
// until a short page; a caller orders on a unique column last so pages never overlap.
export const PRIVATE_CALENDAR_PAGE_SIZE = 1000;

export async function readAllPrivateCalendarRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PRIVATE_CALENDAR_PAGE_SIZE) {
    const { data, error } = await page(from, from + PRIVATE_CALENDAR_PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PRIVATE_CALENDAR_PAGE_SIZE) return rows;
  }
}

export function privateCalendarItemOccursOn(item: PrivateCalendarItem, date: string) {
  return date >= item.startDate && date <= item.endDate;
}

/**
 * Suppress fingerprint attendance PROBLEMS (Late/Short day/Single punch) on a
 * day the SAME employee was out on a CRM-verified double visit — a "late" flag
 * is meaningless when the employee was legitimately away from the office.
 *
 * Two rules make this safe to run over a multi-employee item set, and both are
 * load-bearing because this feeds the company No Activity Days report, whose
 * output becomes payroll deduction candidates:
 *   1. Suppression is keyed on (employee, date). One employee's double visit
 *      must never hide a DIFFERENT employee's attendance — that would make the
 *      other person look like they recorded no activity at all.
 *   2. A genuine "Complete" punch is never suppressed. Real proof of presence
 *      always wins over the field-visit heuristic.
 */
export function suppressFieldVisitAttendanceProblems(items: PrivateCalendarItem[]): PrivateCalendarItem[] {
  const fieldVisitKeys = new Set<string>();
  for (const item of items) {
    if (item.source !== "double_visit") continue;
    const employeeKey = privateCalendarHrIdKey(item.employeeHrId);
    // An unattributable double visit suppresses nothing: losing a Late flag is
    // cheaper than manufacturing a "No Activity Recorded" day for someone else.
    if (!employeeKey) continue;
    fieldVisitKeys.add(`${employeeKey}|${item.startDate}`);
  }
  if (fieldVisitKeys.size === 0) return items;
  return items.filter((item) => {
    if (item.source !== "attendance") return true;
    if (item.status === "Complete") return true;
    const employeeKey = privateCalendarHrIdKey(item.employeeHrId);
    if (!employeeKey) return true;
    return !fieldVisitKeys.has(`${employeeKey}|${item.startDate}`);
  });
}

export function summarizePrivateCalendarItems(items: PrivateCalendarItem[]): PrivateCalendarWorkspace["summary"] {
  const summary = {
    attendance: 0,
    double_visit: 0,
    excuse: 0,
    field_visit: 0,
    holiday: 0,
    plan: 0,
    total: items.length,
    vacation: 0,
  };
  for (const item of items) {
    summary[item.source] += 1;
  }
  return summary;
}

function sourceCounts() {
  return {
    attendance: 0,
    double_visit: 0,
    excuse: 0,
    field_visit: 0,
    holiday: 0,
    plan: 0,
    vacation: 0,
  } satisfies Record<PrivateCalendarSource, number>;
}

export function buildPrivateCalendarTeamSummary(input: {
  employees: PrivateCalendarEmployeeOption[];
  exceptions: PrivateCalendarException[];
  items: PrivateCalendarItem[];
}) {
  return input.employees.map((employee) => {
    const employeeKey = privateCalendarHrIdKey(employee.hrId);
    const counts = sourceCounts();
    const employeeItems: PrivateCalendarItem[] = [];
    for (const item of input.items) {
      if (item.employeeHrId && privateCalendarHrIdKey(item.employeeHrId) !== employeeKey) continue;
      if (!item.employeeHrId && item.source !== "holiday") continue;
      counts[item.source] += 1;
      employeeItems.push(item);
    }
    return {
      ...employee,
      // Counts what needs review only. An "info" exception is a review request's own status
      // (pending, verified) — news for the employee, never a warning against them.
      exceptionCount: input.exceptions.filter((exception) =>
        exception.severity !== "info" && privateCalendarHrIdKey(exception.employeeHrId) === employeeKey).length,
      itemCount: employeeItems.length,
      sourceCounts: counts,
      visitCounts: summarizePrivateCalendarVisits(employeeItems).all,
    };
  });
}

function eachDate(start: string, end: string) {
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function createException(input: Omit<PrivateCalendarException, "id">) {
  return {
    ...input,
    id: [
      "private-calendar-exception",
      input.code,
      privateCalendarHrIdKey(input.employeeHrId) || "company",
      input.date,
      input.relatedItemIds.join("-"),
    ].join("-"),
  };
}

/**
 * Whether a date falls inside an employee's employment: on or after the hire date and on or
 * before the last working date. A day outside that window is never an expected workday — before
 * this gate an employee hired on the 12th read "No Activity Recorded" on every workday from the
 * 1st, days the company did not employ them. Either bound may be missing, and then it does not
 * limit anything.
 */
export function isWithinEmploymentWindow(
  date: string,
  window: { hireDate?: string | null; lastWorkingDate?: string | null },
) {
  const hireDate = cleanText(window.hireDate).slice(0, 10);
  const lastWorkingDate = cleanText(window.lastWorkingDate).slice(0, 10);
  if (hireDate && date < hireDate) return false;
  if (lastWorkingDate && date > lastWorkingDate) return false;
  return true;
}

function todayInCairo() {
  // Africa/Cairo local calendar date (the app's operating timezone). Using UTC
  // here would slip the "up to today" cutoff a day for a few hours after local
  // midnight and mis-flag the current day near month boundaries.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function derivePrivateCalendarExceptions(input: {
  employees: PrivateCalendarEmployeeOption[];
  end: string;
  isExpectedWorkday?: (employee: PrivateCalendarEmployeeOption, date: string) => boolean;
  items: PrivateCalendarItem[];
  start: string;
  today?: string;
}) {
  const today = input.today ?? todayInCairo();
  const isExpectedWorkday = input.isExpectedWorkday ?? ((employee, date) => isAttendanceScheduledWorkingDay({
    dateIso: date,
    jobTitle: employee.jobTitle,
  }));
  // Only days that have ENDED are judged. Today is still in progress: a rep's visits sync from
  // the CRM through the day, and an office worker's second punch arrives at the end of it, so
  // judging today flagged every employee "No Activity Recorded" (and every morning punch a
  // "Single punch") on the day they were in the middle of working.
  const dates = eachDate(input.start, input.end).filter((date) => date < today);
  const exceptions: PrivateCalendarException[] = [];
  const itemsByEmployeeDate = new Map<string, PrivateCalendarItem[]>();
  const companyItemsByDate = new Map<string, PrivateCalendarItem[]>();

  for (const item of input.items) {
    for (const date of dates) {
      if (!privateCalendarItemOccursOn(item, date)) continue;
      if (!item.employeeHrId) {
        companyItemsByDate.set(date, [...(companyItemsByDate.get(date) ?? []), item]);
        continue;
      }
      const key = `${privateCalendarHrIdKey(item.employeeHrId)}|${date}`;
      itemsByEmployeeDate.set(key, [...(itemsByEmployeeDate.get(key) ?? []), item]);
    }
  }

  for (const employee of input.employees) {
    const employeeKey = privateCalendarHrIdKey(employee.hrId);
    for (const date of dates) {
      const dayItems = itemsByEmployeeDate.get(`${employeeKey}|${date}`) ?? [];
      const companyItems = companyItemsByDate.get(date) ?? [];
      const attendance = dayItems.filter((item) => item.source === "attendance");
      const vacations = dayItems.filter((item) => item.source === "vacation");
      const excuses = dayItems.filter((item) => item.source === "excuse");
      const doubleVisits = dayItems.filter((item) => item.source === "double_visit");
      const fieldVisits = dayItems.filter((item) => item.source === "field_visit");
      const holidays = companyItems.filter((item) => item.source === "holiday");
      // 🔴 AN APPROVED WEEKLY PLAN COVERS NOTHING — ANY ACTIVITY TITLE. Owner, 2026-10-12: *"NEVER
      // COUNT WEEKLY PLAN AS COVERAGE WHAT IF HE PLANNED BUT DIDNT GO WORK?"* and *"Do not ever touch
      // a weekly plan. All what you do that you see the weekly plan and the daily reports and compare
      // the plan versus the actual, any title."* The plan proves the day was EXPECTED, which is the
      // opposite of proving it happened — the reasoning this file already applied to a planned Field,
      // Double Visit, Office or Vacation day, now applied to every title. Between 2026-10-07 and his
      // ruling, Travel, Admin, Meeting, Meeting with Team, Training, Event and Other did excuse a
      // day here; `docs/private-calendar-plan-is-never-coverage.md` carries that window and what it
      // suppressed. The plan is still READ and still shown, beside the day's real records, because
      // comparing it against the actual is the whole use he has for it.
      const plansOnTheDay = dayItems.filter((item) => item.source === "plan" && item.plannedActivityIsRecordedNowhereElse === true);
      // A CRM visit self-proves attendance for the day — no fingerprint needed.
      // That is true of a rep's OWN solo visits (field_visit) exactly as it is of
      // a manager-accompanied one (double_visit); only the double-visit feed was
      // ever wired in. Field reps are not enrolled on fingerprint devices at all
      // (see attendance-cross-check.ts), so for them CRM is the only possible
      // proof of work — and measured on July 2026 production data, 86% of field
      // work is solo: 1,700 rep-days carrying 15,429 real logged visits had no
      // punch, no leave and no double visit, and so read as "No Activity
      // Recorded" despite the employee demonstrably working.
      //
      // 🔴 THE APPROVED WEEKLY PLAN IS NOT IN THIS LIST, and must never be put back (owner,
      // 2026-10-12 — see plansOnTheDay above). It joined it on 2026-10-07 and was removed five days
      // later: every entry here is a CAPTURED record of something that happened, and a plan is an
      // intention. A planned Training the rep never attended is exactly the day he asked about.
      const isCovered =
        attendance.length > 0 ||
        vacations.length > 0 ||
        excuses.length > 0 ||
        holidays.length > 0 ||
        doubleVisits.length > 0 ||
        fieldVisits.length > 0;

      for (const item of attendance) {
        for (const flag of item.exceptionFlags) {
          if (flag === "Approved attendance exception") continue;
          exceptions.push(createException({
            code: flag.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
            date,
            description: `${item.employeeName ?? employee.fullName}: ${flag} detected from fingerprint attendance.`,
            employeeHrId: employee.hrId,
            employeeName: employee.fullName,
            relatedItemIds: [item.id],
            severity: flag === "Absence risk" ? "danger" : "warning",
            title: flag,
          }));
        }
      }

      // A half-day (Am/Pm Only) vacation is expected to carry attendance for the
      // other half — that is normal, not a conflict. Only flag when every vacation
      // covering the day is a full day, yet a punch still exists.
      const allVacationsAreFullDay = vacations.length > 0 && vacations.every((item) => item.time === "Full day");
      if (attendance.length > 0 && vacations.length > 0 && allVacationsAreFullDay) {
        exceptions.push(createException({
          code: "attendance_during_vacation",
          date,
          description: `${employee.fullName} has fingerprint attendance while a full-day vacation covers the same date.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: [...attendance, ...vacations].map((item) => item.id),
          severity: "warning",
          title: "Attendance during vacation",
        }));
      }

      // Uncovered expected workday only. isExpectedWorkday already encodes the
      // full weekly-off policy correctly per role: Friday is off for everyone
      // (isFieldWorkforceFriday — unconditional, no job-title carve-out), and
      // Saturday is off for everyone except Medical Rep / District (Sales)
      // Manager, whose weekend is Friday-only (isFieldWorkforceFridayOnlyTitle).
      // A day that isn't expected to have activity for this employee (their
      // weekly off, whichever day that is) stays blank when uncovered — no
      // label, no noise — while a real captured record on any day, off or not,
      // still shows normally (items are never exception-gated). Only actually
      // recorded/verified sources count as covered — an uncovered expected
      // workday reads the same way regardless: no activity was recognized
      // anywhere, full stop.
      if (isExpectedWorkday(employee, date) && !isCovered) {
        exceptions.push(createException({
          code: "no_activity_recorded",
          date,
          description: `${employee.fullName}: no CRM field or double visit, no fingerprint attendance, no approved vacation and no approved excuse recorded for this workday. An approved weekly plan is not a record of work and never clears this day.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: [],
          severity: "danger",
          title: "No Activity Recorded",
        }));
      }

      // THE PLAN-VERSUS-ACTUAL NOTE, which is what the plan is for (owner, 2026-10-12: *"all what you
      // do that you see the weekly plan and the daily reports and compare the plan versus the
      // actual"*). On a day the plan is the only thing on file, say what was planned NEXT TO the fact
      // that nothing was recorded — so the reader of the red block above sees the comparison without
      // the plan softening the finding. Until 2026-10-12 this same block read "Covered by the approved
      // plan" and the day carried no finding at all.
      //
      // `info`, deliberately: it is news, never a finding. Every counter on the screen and in the team
      // snapshot excludes info (reviewExceptions, daysWithIssues, dayNeedsReview, exceptionCount), and
      // getCompanyNoActivityDays filters on the No Activity title — so this note cannot inflate a
      // review queue, and it cannot reach a deduction candidate list either way.
      //
      // Only when the plan is ALONE. A day that also carries a punch, a visit, leave, an excuse or a
      // holiday has its real record, and the comparison is not the thing to read on it.
      const planIsTheOnlyThingOnFile =
        plansOnTheDay.length > 0 &&
        attendance.length === 0 &&
        vacations.length === 0 &&
        excuses.length === 0 &&
        holidays.length === 0 &&
        doubleVisits.length === 0 &&
        fieldVisits.length === 0;
      if (isExpectedWorkday(employee, date) && planIsTheOnlyThingOnFile) {
        const planned = plansOnTheDay.map((item) => item.title).join(" + ");
        exceptions.push(createException({
          code: "planned_but_nothing_recorded",
          date,
          description: `${employee.fullName}: the approved weekly plan says ${planned} for this day, and nothing at all was recorded against it — no punch, no visit, no leave. The plan is what was intended, not what happened, so it does not clear the day.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: plansOnTheDay.map((item) => item.id),
          severity: "info",
          title: "Planned, but nothing recorded",
        }));
      }
    }
  }

  return exceptions.sort((left, right) => `${left.date}-${left.employeeName}-${left.title}`.localeCompare(`${right.date}-${right.employeeName}-${right.title}`));
}
