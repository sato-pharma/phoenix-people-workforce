export const VACATION_TYPES = [
  { label: "Annual Vacation", value: "annual" },
  { label: "Emergency Vacation", value: "emergency" },
  { label: "Sick Vacation", value: "sick" },
  { label: "Other", value: "other" },
  { label: "Compensatory Day", value: "compensatory" },
] as const;

export const VACATION_REQUEST_TYPES = [
  { label: "Annual", value: "annual" },
  { label: "Sick", value: "sick" },
  { label: "Other", value: "other" },
  { label: "Compensatory Day", value: "compensatory" },
] as const satisfies ReadonlyArray<{ label: string; value: VacationType }>;

export const VACATION_DAY_PARTS = [
  { label: "Full day", value: "full_day" },
  { label: "AM only", value: "am_only" },
  { label: "PM only", value: "pm_only" },
] as const;

export const VACATION_STATUSES = [
  { label: "Pending Manager", value: "pending_manager" },
  { label: "Pending HR", value: "pending_hr" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
] as const;

export const VACATION_PAYMENT_STATUSES = [
  { label: "Paid", value: "paid" },
  { label: "Partially Paid", value: "partial" },
  { label: "Unpaid", value: "unpaid" },
] as const;

export const VACATION_WEEKLY_OFF_MODES = [
  { label: "Working", value: "working" },
  { label: "AM off", value: "am_only" },
  { label: "PM off", value: "pm_only" },
  { label: "Full day off", value: "full_day" },
] as const;

export type VacationType = (typeof VACATION_TYPES)[number]["value"];
export type VacationDayPart = (typeof VACATION_DAY_PARTS)[number]["value"];
export type VacationRequestStatus = (typeof VACATION_STATUSES)[number]["value"];
export type VacationPaymentStatus = (typeof VACATION_PAYMENT_STATUSES)[number]["value"];
export type VacationDecision = "approve" | "reject";
export type VacationUnpaidReason = "first_six_months" | "insufficient_balance" | "missing_hire_date";
export type VacationWeeklyOffMode = (typeof VACATION_WEEKLY_OFF_MODES)[number]["value"];

export type VacationRequestInput = {
  dayPart: VacationDayPart;
  endDate: string;
  startDate: string;
  vacationType: VacationType;
};

export type VacationBalanceSnapshot = {
  balanceAfterDays: number;
  balanceBeforeDays: number;
  entitlementDays: number;
  paymentStatus: VacationPaymentStatus;
  paidDurationDays: number;
  periodEnd: string | null;
  periodStart: string | null;
  unpaidReason: VacationUnpaidReason | null;
  unpaidDurationDays: number;
  usedPaidDays: number;
};

export type VacationEmployeeSummary = {
  departmentName: string | null;
  fullName: string;
  hireDate: string | null;
  hrId: string;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  workEmail: string | null;
};

export type VacationWeeklyOffPolicyRecord = {
  friday: VacationWeeklyOffMode;
  id: string | null;
  jobTitle: string;
  saturday: VacationWeeklyOffMode;
  thursday: VacationWeeklyOffMode;
  updatedAt: string | null;
};

export type VacationControlData = {
  policies: VacationWeeklyOffPolicyRecord[];
  titles: string[];
};

export type VacationRequestRecord = VacationBalanceSnapshot & {
  canDecide: boolean;
  createdAt: string;
  dayPart: VacationDayPart;
  departmentName: string | null;
  durationDays: number;
  employeeHireDate: string | null;
  employeeHrId: string;
  employeeName: string;
  employeeWorkEmail: string | null;
  endDate: string;
  id: string;
  compensatoryAttachmentBucket: string | null;
  compensatoryAttachmentContentType: string | null;
  compensatoryAttachmentObjectPath: string | null;
  compensatoryAttachmentOriginalName: string | null;
  compensatoryAttachmentSizeBytes: number;
  compensatoryAttachmentUploadedAt: string | null;
  compensatoryEventDate: string | null;
  compensatoryEventLocation: string | null;
  compensatoryEventName: string | null;
  compensatoryManager1: string | null;
  compensatoryManager2: string | null;
  sickAttachmentBucket: string | null;
  sickAttachmentContentType: string | null;
  sickAttachmentObjectPath: string | null;
  sickAttachmentOriginalName: string | null;
  sickAttachmentSizeBytes: number;
  sickAttachmentUploadedAt: string | null;
  lineName: string | null;
  hrDecision: "approved" | "rejected" | null;
  hrDecisionAt: string | null;
  hrDecisionByHrId: string | null;
  hrDecisionComment: string | null;
  managerDecision: "approved" | "rejected" | null;
  managerDecisionAt: string | null;
  managerDecisionByHrId: string | null;
  managerDecisionComment: string | null;
  managerHrId: string | null;
  managerName: string | null;
  managerOfManagerHrId: string | null;
  managerOfManagerName: string | null;
  notes: string | null;
  startDate: string;
  status: VacationRequestStatus;
  submittedByHrId: string | null;
  vacationType: VacationType;
};

export type VacationReportFilters = {
  dateFrom?: string;
  dateTo?: string;
  department?: string;
  employee?: string;
  line?: string;
  manager?: string;
  paymentStatus?: VacationPaymentStatus | "all";
  requestId?: string;
  search?: string;
  status?: VacationRequestStatus | "all";
  vacationType?: VacationType | "all";
};

export type VacationReportData = {
  canAdminManage: boolean;
  filters: VacationReportFilters;
  options: {
    departments: string[];
    employees: Array<{ label: string; value: string }>;
    lines: string[];
    managers: Array<{ label: string; value: string }>;
  };
  rows: VacationRequestRecord[];
  summary: {
    approved: number;
    managerDecisionActions: number;
    paidDays: number;
    pending: number;
    rejected: number;
    total: number;
    unpaidDays: number;
  };
};
