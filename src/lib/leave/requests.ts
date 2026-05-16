export type VacationRequestStatus = "Pending" | "Approved" | "Rejected";
export type LeaveRequestDbStatus =
  | "draft"
  | "approved"
  | "needs_routing"
  | "pending_manager"
  | "manager_approved"
  | "manager_rejected"
  | "pending_hr"
  | "hr_approved"
  | "hr_rejected"
  | "cancelled";
export type LeaveWorkflowStatus =
  | LeaveRequestDbStatus
  | "awaiting_manager"
  | "awaiting_hr"
  | "awaiting_payout";
export type LeaveWorkflowActor = "employee" | "manager" | "hr" | "admin" | "system";
export type LeaveWorkflowAction = "submit" | "approve" | "reject" | "override" | "route";
export type VacationRequestType =
  | "Annual Leave"
  | "Sick Leave"
  | "Unpaid Leave"
  | "Compensatory Leave"
  | "Other";
export type VacationDayType = "Full Day" | "AM Only" | "PM Only";
export type VacationPaymentStatus = "Paid" | "Unpaid";

export type VacationRequestRecord = {
  availableBalanceAtSubmission: number;
  approvalStatusDate: string;
  approvedOrRejectedBy: string;
  currentAnnualEntitlementAtSubmission: number;
  createdAt: string;
  dayType: VacationDayType;
  durationDays: number;
  employeeEmail: string;
  employeeArea: string;
  firstYearEntitlementAtSubmission: number;
  employeeHireDate: string;
  employeeLine: string;
  employeeId: string;
  employeeKey: string;
  employeeName: string;
  endDate: string;
  employeeTeam: string;
  directManager: string;
  directManagerEmail: string;
  directManagerHrId: string;
  halfDayImpact: number;
  id: string;
  paymentStatus: VacationPaymentStatus;
  pendingLeaveImpactAtSubmission: number;
  rejectionReason: string;
  reason: string;
  requestType: VacationRequestType;
  startDate: string;
  team: string;
  status: VacationRequestStatus;
  workflowStatus: LeaveWorkflowStatus;
  allowedActions: LeaveWorkflowAction[];
  allowedActors: LeaveWorkflowActor[];
  workflowSnapshot: {
    managerStatus: string;
    hrStatus: string;
    payrollStatus: string;
    managerDecisionAt?: string;
    hrDecisionAt?: string;
    requestedAt?: string;
    requestedAtIso?: string;
  };
  totalDays: number;
  totalEntitledBalanceAtSubmission: number;
  unpaidLeaveDaysAtSubmission: number;
  usedPaidLeaveAtSubmission: number;
  remainingPaidBalanceAtSubmission: number;
};

export const vacationRequestTypeOptions: VacationRequestType[] = [
  "Annual Leave",
  "Sick Leave",
  "Unpaid Leave",
  "Compensatory Leave",
  "Other",
];

export const vacationRequestTypeForSubmission: VacationRequestType[] = [
  "Annual Leave",
  "Sick Leave",
  "Compensatory Leave",
  "Other",
];

export const vacationRequestStatusOptions: VacationRequestStatus[] = [
  "Pending",
  "Approved",
  "Rejected",
];

export const vacationDayTypeOptions: VacationDayType[] = [
  "Full Day",
  "AM Only",
  "PM Only",
];

const PROBATION_MONTHS = 6;
const FIRST_YEAR_ENTITLEMENT = 15;
const STANDARD_ENTITLEMENT = 21;

type EmployeeIdentifiers = {
  employeeEmail: string;
  employeeId: string;
  employeeName: string;
  employeeHireDate?: string;
};

export type VacationBalanceSummary = {
  availableBalance: number;
  currentAnnualEntitlement: number;
  isInProbation: boolean;
  firstYearEntitlement: number;
  pendingLeaveImpact: number;
  remainingBalance: number;
  usedPaidLeave: number;
  unpaidLeaveDays: number;
};

export type VacationRequestPreview = VacationBalanceSummary & {
  durationDays: number;
  hasRange: boolean;
  halfDayImpact: number;
  isHalfDayInvalid: boolean;
  isPreviewInvalid: boolean;
  isValidForBalance: boolean;
  paymentStatus: VacationPaymentStatus;
  remainingAfterSubmit: number;
  totalDays: number;
  validEmployeeIdentity: boolean;
  validHiringDate: boolean;
  willBePaid: boolean;
};

function round2(value: number) {
  return Number(value.toFixed(2));
}

function parseDate(value: string | undefined | null): Date | null {
  if (!value || typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  const parsed = text.includes("T") ? new Date(text) : new Date(`${text}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatNumber(value: number) {
  return `${round2(Math.max(0, value))}`;
}

function sanitizeRequestType(value: unknown): VacationRequestType {
  if (typeof value === "string" && vacationRequestTypeOptions.includes(value as VacationRequestType)) {
    return value as VacationRequestType;
  }
  return "Annual Leave";
}

function sanitizeRequestDayType(value: unknown): VacationDayType {
  if (typeof value === "string" && vacationDayTypeOptions.includes(value as VacationDayType)) {
    return value as VacationDayType;
  }
  return "Full Day";
}

function sanitizeRequestStatus(value: unknown): VacationRequestStatus {
  if (typeof value !== "string") {
    return "Pending";
  }

  return mapDbStatusToAppStatus(value.trim());
}

function toWorkflowStatus(value: unknown): LeaveWorkflowStatus {
  const normalized = `${String(value ?? "").trim()}`.toLowerCase();
  if (normalized === "draft") return "draft";
  if (normalized === "approved") return "approved";
  if (normalized === "needs_routing") return "needs_routing";
  if (normalized === "pending_manager") return "awaiting_manager";
  if (normalized === "manager_approved") return "awaiting_hr";
  if (normalized === "pending_hr") return "awaiting_hr";
  if (normalized === "hr_approved") return "awaiting_payout";
  if (normalized === "manager_rejected") return "manager_rejected";
  if (normalized === "hr_rejected") return "hr_rejected";
  if (normalized === "cancelled") return "cancelled";
  return "pending_manager";
}

export function mapWorkflowStatusToDb(value: LeaveWorkflowStatus): LeaveRequestDbStatus {
  if (value === "awaiting_manager" || value === "awaiting_payout") return "pending_manager";
  if (value === "awaiting_hr") return "pending_hr";
  if (value === "approved" || value === "needs_routing") return value;
  if (
    value === "manager_approved" ||
    value === "manager_rejected" ||
    value === "hr_approved" ||
    value === "hr_rejected" ||
    value === "draft" ||
    value === "cancelled"
  ) {
    return value as LeaveRequestDbStatus;
  }
  return "pending_manager";
}

function mapDbStatusToAppStatus(value: string): VacationRequestStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approved") return "Approved";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "manager_approved" || normalized === "hr_approved") return "Approved";
  if (normalized === "manager_rejected" || normalized === "hr_rejected") return "Rejected";
  if (
    normalized === "pending_manager" ||
    normalized === "pending_hr" ||
    normalized === "draft" ||
    normalized === "cancelled" ||
    normalized === "pending"
  ) {
    return "Pending";
  }

  if (vacationRequestStatusOptions.includes(value as VacationRequestStatus)) {
    return value as VacationRequestStatus;
  }

  return "Pending";
}

export function mapVacationStatusToDb(value: VacationRequestStatus): LeaveRequestDbStatus {
  if (value === "Approved") return "manager_approved";
  if (value === "Rejected") return "manager_rejected";
  return "pending_manager";
}

export function resolveWorkflowActors(status: LeaveRequestDbStatus): LeaveWorkflowActor[] {
  if (status === "pending_manager") return ["manager", "admin"];
  if (status === "pending_hr") return ["hr", "admin"];
  return ["admin"];
}

export function resolveWorkflowActions(input: {
  isManager: boolean;
  isHr: boolean;
  status: LeaveRequestDbStatus;
}) {
  if (input.status === "pending_manager" && input.isManager) return ["approve", "reject"] as LeaveWorkflowAction[];
  if (input.status === "pending_hr" && input.isHr) return ["approve", "reject"] as LeaveWorkflowAction[];
  return [] as LeaveWorkflowAction[];
}

export function deriveWorkflowStatus(input: {
  status: string | undefined | null;
  managerStatus?: string | null;
  hrStatus?: string | null;
  payrollStatus?: string | null;
  directManagerMissing?: boolean;
}) {
  const dbStatus = mapLeaveWorkflowDbStatus(input.status);
  if (input.directManagerMissing && dbStatus === "pending_manager") {
    return "needs_routing" as LeaveWorkflowStatus;
  }
  if (dbStatus === "manager_approved" && (input.payrollStatus ?? "").toLowerCase() === "in_review") {
    return "awaiting_hr" as LeaveWorkflowStatus;
  }
  if (dbStatus === "hr_approved" && (input.payrollStatus ?? "").toLowerCase() === "in_review") {
    return "awaiting_payout" as LeaveWorkflowStatus;
  }
  return toWorkflowStatus(dbStatus);
}

function mapLeaveWorkflowDbStatus(value: unknown): LeaveRequestDbStatus {
  const normalized = `${String(value ?? "").trim()}`.toLowerCase();
  if (
    normalized === "draft" ||
    normalized === "approved" ||
    normalized === "needs_routing" ||
    normalized === "pending_manager" ||
    normalized === "manager_approved" ||
    normalized === "manager_rejected" ||
    normalized === "pending_hr" ||
    normalized === "hr_approved" ||
    normalized === "hr_rejected" ||
    normalized === "cancelled"
  ) return (normalized === "approved" || normalized === "needs_routing" ? "pending_manager" : normalized) as LeaveRequestDbStatus;
  return "pending_manager";
}

export function deriveWorkflowSnapshot(input: {
  managerStatus?: unknown;
  hrStatus?: unknown;
  payrollStatus?: unknown;
  managerDecisionAt?: unknown;
  hrDecisionAt?: unknown;
  requestedAt?: unknown;
}) {
  return {
    managerStatus: sanitizeString(input.managerStatus).toLowerCase() || "pending",
    hrStatus: sanitizeString(input.hrStatus).toLowerCase() || "pending",
    payrollStatus: sanitizeString(input.payrollStatus).toLowerCase() || "in_review",
    managerDecisionAt: sanitizeString(input.managerDecisionAt) || "",
    hrDecisionAt: sanitizeString(input.hrDecisionAt) || "",
    requestedAt: sanitizeString(input.requestedAt) || "",
  };
}

export function mapPaymentStatusToDb(value: VacationPaymentStatus) {
  return value === "Paid" ? "paid" : "unpaid";
}

export function mapDayTypeToDurationUnit(value: VacationDayType) {
  return value === "AM Only" ? "am" : value === "PM Only" ? "pm" : "full_day";
}

function sanitizeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function sanitizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeDate(value: unknown): string {
  const text = sanitizeString(value);
  return parseDate(text) ? text : "";
}

function buildEmployeeKey({
  employeeEmail,
  employeeId,
  employeeName,
}: EmployeeIdentifiers) {
  const email = sanitizeString(employeeEmail).toLowerCase();
  const id = sanitizeString(employeeId).toLowerCase();
  if (email) return `email:${email}`;
  if (id) return `id:${id}`;
  return `name:${sanitizeString(employeeName).toLowerCase()}`;
}

function addMonths(source: Date, months: number) {
  const copy = new Date(source.getTime());
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function addYears(source: Date, years: number) {
  return addMonths(source, years * 12);
}

function getCurrentCycleStart(hireDate: Date, now: Date) {
  if (now < hireDate) {
    return hireDate;
  }

  let cycleStart = new Date(hireDate.getTime());
  while (addYears(cycleStart, 1).getTime() <= now.getTime()) {
    cycleStart = addYears(cycleStart, 1);
  }

  return cycleStart;
}

function getEntitlementForCycle({
  hireDate,
  cycleStart,
  now,
}: {
  hireDate: Date;
  cycleStart: Date;
  now: Date;
}) {
  const isFirstYear = cycleStart.getTime() === hireDate.getTime();
  const probationEnd = addMonths(hireDate, PROBATION_MONTHS);
  const currentAnnualEntitlement = isFirstYear ? FIRST_YEAR_ENTITLEMENT : STANDARD_ENTITLEMENT;

  if (isFirstYear && now < probationEnd) {
    return {
      isInProbation: true,
      isFirstYear: true,
      firstYearEntitlement: FIRST_YEAR_ENTITLEMENT,
      currentAnnualEntitlement,
      totalEntitledBalance: 0,
    };
  }

  if (isFirstYear) {
    return {
      isInProbation: false,
      isFirstYear: true,
      firstYearEntitlement: FIRST_YEAR_ENTITLEMENT,
      currentAnnualEntitlement,
      totalEntitledBalance: FIRST_YEAR_ENTITLEMENT,
    };
  }

  return {
    isInProbation: false,
    isFirstYear: false,
    firstYearEntitlement: 0,
    currentAnnualEntitlement,
    totalEntitledBalance: STANDARD_ENTITLEMENT,
  };
}

function isDateBetween(value: string, start: Date, end: Date) {
  const parsed = parseDate(value);
  if (!parsed) return false;
  return parsed >= start && parsed < end;
}

export function calculateVacationDuration(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);

  if (!start || !end) return 0;

  const durationMs = end.getTime() - start.getTime();
  if (durationMs < 0) return 0;
  return Math.floor(durationMs / (24 * 60 * 60 * 1000)) + 1;
}

export function isHalfDayRangeInvalid({
  dayType,
  endDate,
  startDate,
}: {
  dayType: VacationDayType;
  endDate: string;
  startDate: string;
}) {
  if (!startDate || !endDate) return false;
  if (dayType === "Full Day") return false;
  return startDate !== endDate;
}

export function parseVacationRequest(raw: unknown): VacationRequestRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const createdAt = sanitizeString(record.createdAt);
  const employeeName = sanitizeString(record.employeeName);
  const employeeId = sanitizeString(record.employeeId);
  const employeeEmail = sanitizeString(record.employeeEmail);
  const employeeHireDate = sanitizeDate(
    (record.employeeHireDate as unknown) ?? (record.employeeHiringDate as unknown),
  );
  const requestType = sanitizeRequestType(record.requestType);
  const dayType = sanitizeRequestDayType(record.dayType);
  const status = sanitizeRequestStatus(record.status);
  const paymentStatus = sanitizeString(record.paymentStatus) === "Unpaid" ? "Unpaid" : "Paid";
  const approvalStatusDate = sanitizeString(record.approvalStatusDate);
  const approvedOrRejectedBy = sanitizeString(record.approvedOrRejectedBy);
  const directManager = sanitizeString(record.directManager);
  const directManagerEmail = sanitizeString(record.directManagerEmail);
  const directManagerHrId = sanitizeString(record.directManagerHrId);
  const employeeArea = sanitizeString(record.employeeArea);
  const employeeLine = sanitizeString(record.employeeLine);
  const employeeTeam = sanitizeString(record.employeeTeam);
  const rejectionReason = sanitizeString(record.rejectionReason);
  const team = sanitizeString(record.team);
  const reason = sanitizeString(record.reason);
  const startDate = sanitizeString(record.startDate);
  const endDate = sanitizeString(record.endDate);
  const id = sanitizeString(record.id);
  const totalDays = sanitizeNumber(record.totalDays);
  const durationDays = sanitizeNumber(record.durationDays);
  const halfDayImpact = sanitizeNumber(record.halfDayImpact);
  const availableBalanceAtSubmission = sanitizeNumber(record.availableBalanceAtSubmission);
  const currentAnnualEntitlementAtSubmission = sanitizeNumber(
    (record as Record<string, unknown>).currentAnnualEntitlementAtSubmission ?? record.totalEntitledBalanceAtSubmission,
  );
  const firstYearEntitlementAtSubmission = sanitizeNumber(
    (record as Record<string, unknown>).firstYearEntitlementAtSubmission ?? 0,
  );
  const totalEntitledBalanceAtSubmission = sanitizeNumber(record.totalEntitledBalanceAtSubmission);
  const usedPaidLeaveAtSubmission = sanitizeNumber(record.usedPaidLeaveAtSubmission);
  const remainingPaidBalanceAtSubmission = sanitizeNumber(record.remainingPaidBalanceAtSubmission);
  const unpaidLeaveDaysAtSubmission = sanitizeNumber(record.unpaidLeaveDaysAtSubmission);
  const pendingLeaveImpactAtSubmission = sanitizeNumber(record.pendingLeaveImpactAtSubmission);
  const directManagerMissing = !directManagerHrId;
  const workflowStatus = deriveWorkflowStatus({
    directManagerMissing,
    hrStatus: sanitizeString(record.hr_status),
    managerStatus: sanitizeString(record.manager_status),
    payrollStatus: sanitizeString(record.payment_status),
    status: status,
  });
  const dbStatus = mapLeaveWorkflowDbStatus(sanitizeString(record.status));
  const allowedActors = resolveWorkflowActors(dbStatus);
  const allowedActions = resolveWorkflowActions({
    isManager: true,
    isHr: true,
    status: dbStatus,
  });

  if (!id) {
    return null;
  }

  return {
    approvalStatusDate,
    approvedOrRejectedBy,
    availableBalanceAtSubmission,
    currentAnnualEntitlementAtSubmission,
    createdAt,
    dayType,
    durationDays,
    employeeEmail,
    employeeArea,
    employeeHireDate,
    firstYearEntitlementAtSubmission,
    employeeId,
    employeeLine,
    employeeKey: buildEmployeeKey({ employeeEmail, employeeId, employeeName }),
    employeeName,
    endDate,
    employeeTeam,
    directManager,
    directManagerEmail,
    directManagerHrId,
    halfDayImpact,
    id,
    paymentStatus,
    team,
    pendingLeaveImpactAtSubmission,
    rejectionReason,
    reason,
    requestType,
    startDate,
    status,
    workflowStatus,
    allowedActors,
    allowedActions,
    workflowSnapshot: deriveWorkflowSnapshot({
      hrDecisionAt: (record as Record<string, unknown>).hr_decision_at,
      managerDecisionAt: (record as Record<string, unknown>).manager_decision_at,
      managerStatus: (record as Record<string, unknown>).manager_status,
      payrollStatus: (record as Record<string, unknown>).payment_status,
      requestedAt: (record as Record<string, unknown>).requested_at,
      hrStatus: (record as Record<string, unknown>).hr_status,
    }),
    totalDays,
    totalEntitledBalanceAtSubmission,
    unpaidLeaveDaysAtSubmission,
    usedPaidLeaveAtSubmission,
    remainingPaidBalanceAtSubmission,
  };
}

export function getVacationRequestsForEmployee({
  employee,
  records,
}: {
  employee: EmployeeIdentifiers;
  records: VacationRequestRecord[];
}) {
  const employeeKey = buildEmployeeKey(employee);
  return records.filter((request) => request.employeeKey === employeeKey);
}

export function getEmployeeBalanceSummary({
  currentDate,
  employee,
  records,
}: {
  currentDate: Date;
  employee: EmployeeIdentifiers;
  records: VacationRequestRecord[];
}) {
  const hiringDate = parseDate(employee.employeeHireDate);
  const employeeKey = buildEmployeeKey(employee);

  if (!hiringDate) {
    return {
      availableBalance: 0,
      currentAnnualEntitlement: 0,
      isInProbation: true,
      pendingLeaveImpact: 0,
      remainingBalance: 0,
      firstYearEntitlement: 0,
      usedPaidLeave: 0,
      unpaidLeaveDays: 0,
      validEmployeeIdentity: false,
    };
  }

  const cycleStart = getCurrentCycleStart(hiringDate, currentDate);
  const cycleEnd = addYears(cycleStart, 1);
  const {
    isInProbation,
    totalEntitledBalance,
    currentAnnualEntitlement,
    firstYearEntitlement,
  } = getEntitlementForCycle({
    hireDate: hiringDate,
    cycleStart,
    now: currentDate,
  });

  const relevant = records.filter((request) => {
    if (request.employeeKey !== employeeKey) return false;
    return isDateBetween(request.startDate, cycleStart, cycleEnd);
  });

  const usedPaidLeave = round2(
    relevant.reduce(
      (acc, request) =>
        acc + ((request.workflowStatus === "approved" || request.workflowStatus === "awaiting_payout") && request.paymentStatus === "Paid"
          ? request.totalDays
          : 0),
      0,
    ),
  );

  const unpaidLeaveDays = round2(
    relevant.reduce(
      (acc, request) =>
        acc + ((request.workflowStatus === "approved" || request.workflowStatus === "awaiting_payout") && request.paymentStatus === "Unpaid"
          ? request.totalDays
          : 0),
      0,
    ),
  );

  const pendingLeaveImpact = round2(
    relevant.reduce((acc, request) =>
      acc + (
        request.workflowStatus === "awaiting_manager" ||
        request.workflowStatus === "awaiting_hr" ||
        request.workflowStatus === "needs_routing"
          ? request.totalDays
          : 0
      ), 0),
  );

  const remainingBalance = round2(Math.max(totalEntitledBalance - usedPaidLeave, 0));

  return {
    availableBalance: remainingBalance,
    isInProbation,
    currentAnnualEntitlement,
    firstYearEntitlement,
    pendingLeaveImpact,
    remainingBalance,
    usedPaidLeave,
    unpaidLeaveDays,
    validEmployeeIdentity: Boolean(employee.employeeEmail || employee.employeeId || employee.employeeName),
  };
}

export function calculateVacationRequestPreview({
  currentDateISO,
  dayType,
  endDate,
  existingRecords,
  employeeEmail,
  employeeHireDate,
  employeeId,
  employeeName,
  startDate,
}: {
  currentDateISO?: string;
  dayType: VacationDayType;
  endDate: string;
  existingRecords: VacationRequestRecord[];
  employeeEmail: string;
  employeeHireDate: string;
  employeeId: string;
  employeeName: string;
  startDate: string;
}) {
  const parsedNow = parseDate(currentDateISO ?? new Date().toISOString().slice(0, 10));
  const now = parsedNow ?? new Date();
  const hasRange = Boolean(startDate && endDate);
  const hiringDate = employeeHireDate;
  const employee = { employeeEmail, employeeId, employeeName };
  const validEmployeeIdentity = Boolean(employee.employeeEmail || employee.employeeId || employee.employeeName);
  const durationDays = calculateVacationDuration(startDate, endDate);
  const isHalfDayInvalid = isHalfDayRangeInvalid({ dayType, endDate, startDate });
  const hasRangeInvalid = hasRange && durationDays <= 0;
  const halfDayImpact = isHalfDayInvalid ? 0 : dayType === "Full Day" ? 0 : 0.5;
  const totalDays = hasRange ? Math.max(durationDays - halfDayImpact, 0) : 0;

  const summary = getEmployeeBalanceSummary({
    currentDate: now,
    employee: { ...employee, employeeHireDate: hiringDate },
    records: existingRecords,
  });

  const validHiringDate = parseDate(employeeHireDate) !== null;
  const willBePaid =
    Boolean(totalDays > 0)
    && validHiringDate
    && validEmployeeIdentity
    && hasRange
    && !isHalfDayInvalid
    && !summary.isInProbation
    && totalDays <= summary.availableBalance
    && !hasRangeInvalid;

  const paymentStatus: VacationPaymentStatus = willBePaid ? "Paid" : "Unpaid";
  const remainingAfterSubmit = willBePaid ? round2(summary.availableBalance - totalDays) : summary.availableBalance;

  return {
    ...summary,
    durationDays,
    hasRange,
    halfDayImpact,
    isHalfDayInvalid,
    isPreviewInvalid: !validHiringDate || !validEmployeeIdentity || !hasRange || hasRangeInvalid,
    isValidForBalance: validHiringDate && validEmployeeIdentity && !isHalfDayInvalid,
    paymentStatus,
    remainingAfterSubmit,
    totalDays,
    validEmployeeIdentity,
    validHiringDate,
    willBePaid,
  };
}

function generateRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createVacationRequestRecord({
  employeeEmail,
  employeeId,
  employeeHireDate,
  employeeName,
  reason,
  requestType,
  dayType,
  startDate,
  endDate,
  existingRecords,
}: {
  employeeEmail: string;
  employeeId: string;
  employeeHireDate: string;
  employeeName: string;
  reason: string;
  requestType: VacationRequestType;
  dayType: VacationDayType;
  startDate: string;
  endDate: string;
  existingRecords: VacationRequestRecord[];
}): VacationRequestRecord {
  const preview = calculateVacationRequestPreview({
    currentDateISO: new Date().toISOString().slice(0, 10),
    dayType,
    endDate,
    employeeEmail,
    employeeHireDate,
    employeeId,
    employeeName,
    existingRecords,
    startDate,
  });
  const createdAt = new Date().toISOString();
  const employee = { employeeEmail, employeeId, employeeName };

  const usedPaidLeaveAtSubmission = round2(preview.usedPaidLeave + (preview.willBePaid ? preview.totalDays : 0));
  const remainingPaidBalanceAtSubmission = preview.willBePaid ? preview.remainingAfterSubmit : preview.availableBalance;
  const unpaidLeaveDaysAtSubmission = round2(preview.unpaidLeaveDays + (preview.willBePaid ? 0 : preview.totalDays));
  const pendingLeaveImpactAtSubmission = round2(preview.pendingLeaveImpact + preview.totalDays);

  return {
    availableBalanceAtSubmission: preview.availableBalance,
    currentAnnualEntitlementAtSubmission: preview.currentAnnualEntitlement,
    createdAt,
    dayType,
    durationDays: preview.durationDays,
    employeeEmail: sanitizeString(employeeEmail),
    employeeHireDate: sanitizeDate(employeeHireDate),
    firstYearEntitlementAtSubmission: preview.firstYearEntitlement,
    employeeId: sanitizeString(employeeId),
    employeeKey: buildEmployeeKey(employee),
    employeeName: employeeName.trim(),
    endDate,
    halfDayImpact: preview.halfDayImpact,
    id: generateRequestId(),
    paymentStatus: preview.paymentStatus,
    pendingLeaveImpactAtSubmission,
    reason: reason.trim(),
    requestType,
    startDate,
    approvalStatusDate: "",
    approvedOrRejectedBy: "",
    status: "Pending",
    workflowStatus: "awaiting_manager",
    allowedActions: [],
    allowedActors: ["manager", "admin"],
    workflowSnapshot: {
      managerStatus: "pending",
      hrStatus: "pending",
      payrollStatus: "not_required",
      managerDecisionAt: "",
      hrDecisionAt: "",
      requestedAt: createdAt,
      requestedAtIso: createdAt,
    },
    directManager: "",
    directManagerEmail: "",
    directManagerHrId: "",
    employeeLine: "",
    employeeArea: "",
    employeeTeam: "",
    rejectionReason: "",
    team: "",
    totalDays: preview.totalDays,
    totalEntitledBalanceAtSubmission: preview.currentAnnualEntitlement,
    unpaidLeaveDaysAtSubmission,
    usedPaidLeaveAtSubmission,
    remainingPaidBalanceAtSubmission,
  };
}

type VacationRequestsLoadResponse = {
  error?: string;
  message?: string;
  requests?: unknown[];
  success?: boolean;
};

export type VacationRequestsLoadResult = {
  error: string | null;
  requests: VacationRequestRecord[];
};

export type EmployeePortalVacationEmployee = {
  areaName: string;
  email: string;
  hireDate: string;
  hrId: string;
  lineName: string;
  name: string;
  teamName: string;
};

export type EmployeePortalVacationData = {
  balance: VacationBalanceSummary | null;
  employee: EmployeePortalVacationEmployee | null;
  error: string | null;
  requests: VacationRequestRecord[];
};

export async function loadVacationRequests(): Promise<VacationRequestsLoadResult> {
  if (typeof window === "undefined") {
    return { error: null, requests: [] };
  }

  try {
    const response = await fetch("/api/vacation-requests/workflow", {
      cache: "no-store",
      method: "GET",
    });
    const payload = (await response.json().catch(() => ({}))) as VacationRequestsLoadResponse;

    if (!response.ok) {
      return {
        error: payload?.message ?? payload?.error ?? "Unable to load vacation requests.",
        requests: [],
      };
    }

    const rows = Array.isArray(payload.requests) ? payload.requests : [];
    const requests = rows
      .map((row) => parseVacationRequest(row))
      .filter((request): request is VacationRequestRecord => request !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return { error: null, requests };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to load vacation requests.",
      requests: [],
    };
  }
}

export async function loadEmployeePortalVacationData(): Promise<EmployeePortalVacationData> {
  if (typeof window === "undefined") {
    return { balance: null, employee: null, error: null, requests: [] };
  }

  try {
    const response = await fetch("/api/employee-portals/vacation-requests", {
      cache: "no-store",
      method: "GET",
    });
    const payload = (await response.json().catch(() => ({}))) as {
      balance?: VacationBalanceSummary | null;
      employee?: EmployeePortalVacationEmployee | null;
      error?: string;
      requests?: unknown[];
    };

    if (!response.ok) {
      return {
        balance: null,
        employee: null,
        error: payload?.error ?? "Unable to load vacation requests.",
        requests: [],
      };
    }

    const rows = Array.isArray(payload.requests) ? payload.requests : [];
    const requests = rows
      .map((row) => parseVacationRequest(row))
      .filter((request): request is VacationRequestRecord => request !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return {
      balance: payload.balance ?? null,
      employee: payload.employee ?? null,
      error: null,
      requests,
    };
  } catch (error) {
    return {
      balance: null,
      employee: null,
      error: error instanceof Error ? error.message : "Unable to load vacation requests.",
      requests: [],
    };
  }
}

export function formatVacationDate(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "-";

  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

export function formatVacationTimestamp(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "-";

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

export function getVacationCalculatorsDebugLines() {
  return [
    `First-year entitlement: ${FIRST_YEAR_ENTITLEMENT} day(s) (usable after ${PROBATION_MONTHS} months)`,
    `Post year-1 entitlement: ${STANDARD_ENTITLEMENT} day(s)`,
  ];
}
