import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

export type LeaveStatus =
  | "draft"
  | "pending_manager"
  | "manager_approved"
  | "manager_rejected"
  | "pending_hr"
  | "hr_approved"
  | "hr_rejected"
  | "cancelled";

export type LeaveApprovalStatus = "pending" | "approved" | "rejected" | "not_required";
export type LeavePayrollStatus = "not_required" | "pending" | "processed" | "blocked";
export type LeaveTransactionType =
  | "opening_balance"
  | "accrual"
  | "carry_forward"
  | "adjustment"
  | "pending"
  | "pending_reversal"
  | "consumed"
  | "consumed_reversal";

export type LeaveType = {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  affectsPayroll: boolean;
  requiresAttachment: boolean;
  requiresManagerApproval: boolean;
  requiresHrApproval: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LeavePolicy = {
  id: string;
  name: string;
  country: string;
  annualDaysFirstYear: number;
  annualDaysAfterFirstYear: number;
  annualDaysSenior: number;
  annualDaysDisability: number;
  seniorAfterYears: number;
  seniorAfterAge: number;
  accrualMethod: "manual" | "monthly" | "prorated";
  accrualFrequency: "annual" | "manual" | "monthly";
  allowNegativeBalance: boolean;
  carryForwardEnabled: boolean;
  carryForwardLimit: number;
  carryForwardExpiryMonths: number;
  weekendDays: number[];
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EmployeeLeaveBalance = {
  id: string;
  employeeHrId: string;
  leaveTypeId: string;
  policyId: string;
  year: number;
  openingBalance: number;
  accrued: number;
  consumed: number;
  pending: number;
  adjusted: number;
  carryForward: number;
  availableBalance: number;
  lastAccrualDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LeaveRequest = {
  id: string;
  employeeHrId: string;
  leaveTypeId: string;
  policyId: string;
  startDate: string;
  endDate: string;
  totalCalendarDays: number;
  totalWorkingDays: number;
  reason: string | null;
  attachmentUrl: string | null;
  status: LeaveStatus;
  managerStatus: LeaveApprovalStatus;
  hrStatus: LeaveApprovalStatus;
  payrollStatus: LeavePayrollStatus;
  managerComment: string | null;
  hrComment: string | null;
  requestedAt: string;
  managerDecisionAt: string | null;
  hrDecisionAt: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: Pick<EmployeeDirectoryRow, "areaName" | "fullName" | "hrId" | "jobTitle" | "lineName" | "managerHrId" | "managerName"> | null;
  leaveType?: Pick<LeaveType, "code" | "name" | "isPaid" | "affectsPayroll"> | null;
  approvalHistory?: LeaveApproval[];
};

export type LeaveTransaction = {
  id: string;
  employeeHrId: string;
  leaveTypeId: string;
  policyId: string;
  requestId: string | null;
  transactionType: LeaveTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type LeaveApproval = {
  id: string;
  requestId: string;
  approverHrId: string;
  approverRole: string;
  approvalStep: "hr" | "manager" | "system";
  status: "adjusted" | "approved" | "cancelled" | "rejected";
  comment: string | null;
  actionDate: string;
  createdAt: string;
};

export type PublicHoliday = {
  id: string;
  name: string;
  date: string;
  year: number;
  country: string;
  isActive: boolean;
  createdAt: string;
};

export type LeaveWallet = {
  annualEntitlement: number;
  accrued: number;
  used: number;
  pending: number;
  available: number;
  openingBalance: number;
  carryForward: number;
  adjusted: number;
  balance?: EmployeeLeaveBalance | null;
};

export type LeaveRequestFilters = {
  employee?: string;
  employeeHrId?: string;
  line?: string;
  area?: string;
  managerHrId?: string;
  status?: string;
  leaveTypeId?: string;
  month?: number;
  year?: number;
  startDate?: string;
  endDate?: string;
};

export type SubmitLeaveRequestInput = {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason?: string | null;
  attachmentUrl?: string | null;
};

export type LeaveDecisionInput = {
  decision: "approved" | "rejected";
  comment?: string | null;
};

export type LeaveAdjustmentInput = {
  employeeHrId: string;
  leaveTypeId: string;
  amount: number;
  reason: string;
  year?: number;
};
