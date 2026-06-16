export type ActionHubModule =
  | "leave"
  | "resignation"
  | "excuse"
  | "outstation"
  | "marketing"
  | "contract_renewal";

export type ActionHubUrgency = "high" | "normal" | "low";

// ── Per-module detail payloads ────────────────────────────────────────────────

export type LeaveDetail = {
  module: "leave";
  vacationType: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  paymentStatus: string;
  balanceBeforeDays: number;
  hrDecisionComment: string | null;
  actionAvailability: Record<string, boolean>;
  approvalSteps: Array<{
    order: number;
    status: string;
    stepKey: string;
    genericStep: string;
    approverName: string | null;
    decidedAt: string | null;
    decisionComment: string | null;
  }>;
  slaAgeDays: number;
};

export type ResignationDetail = {
  module: "resignation";
  effectiveDate: string;
  submittedDate: string;
  reason: string | null;
  workflowNotes: string | null;
  rejectedReason: string | null;
  jobTitle: string | null;
  lineName: string | null;
};

export type ExcuseDetail = {
  module: "excuse";
  excuseType: "morning" | "afternoon";
  excuseDate: string;
  durationHours: number;
  managerName: string | null;
  departmentName: string | null;
  lineName: string | null;
};

export type OutstationDetail = {
  module: "outstation";
  expenseType: string;
  tripStartDate: string;
  tripEndDate: string;
  toLabel: string | null;
  allowanceAmount: number;
  claimedTotalAmount: number;
  approvalRecommendation: string;
  approvalReason: string;
  fraudFlags: string[];
  notes: string | null;
  requestId: number;
};

export type MarketingDetail = {
  module: "marketing";
  requestCode: string;
  customerName: string;
  requestType: string;
  estimatedCost: number | null;
  payDate: string | null;
  currentStepName: string;
  decisionLabels: { approve: string; reject: string; return?: string } | null;
};

export type ContractRenewalDetail = {
  module: "contract_renewal";
  requestedRenewalDate: string;
  proposedStartDate: string | null;
  proposedEndDate: string | null;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  workflowNotes: string | null;
  decisionReason: string | null;
  currentStatus: string;
};

export type ActionHubDetail =
  | LeaveDetail
  | ResignationDetail
  | ExcuseDetail
  | OutstationDetail
  | MarketingDetail
  | ContractRenewalDetail;

// ── Unified item ──────────────────────────────────────────────────────────────

export type ActionHubItem = {
  id: string;
  module: ActionHubModule;
  employeeName: string;
  employeeHrId: string;
  title: string;
  statusLabel: string;
  submittedAt: string;
  urgency: ActionHubUrgency;
  detail: ActionHubDetail;
  slaAgeDays?: number | null;
  slaIsOverdue?: boolean;
};

export type ActionHubData = {
  generatedAt: string;
  items: ActionHubItem[];
};

export const ACTION_HUB_MODULE_LABELS: Record<ActionHubModule, string> = {
  leave: "Leave",
  resignation: "Resignation",
  excuse: "Excuse",
  outstation: "Outstation",
  marketing: "Marketing",
  contract_renewal: "Contract Renewal",
};

export const REJECTION_TEMPLATES: Record<ActionHubModule, Array<{ label: string; text: string }>> = {
  leave: [
    { label: "Insufficient balance", text: "Rejected due to insufficient leave balance for the requested period." },
    { label: "Overlap with team leave", text: "Rejected due to overlap with already approved leave for another team member." },
    { label: "Peak business period", text: "Rejected due to critical business requirements during the requested dates." },
  ],
  resignation: [
    { label: "Notice period not met", text: "The notice period specified does not meet the contractual requirement." },
    { label: "Pending handover", text: "Rejection pending completion of knowledge transfer and handover documentation." },
  ],
  excuse: [
    { label: "Attendance threshold", text: "Excuse rejected: monthly excuse quota has been exceeded per policy." },
    { label: "No prior notice", text: "Excuse rejected: no prior notice was provided as required by policy." },
  ],
  outstation: [
    { label: "Claim discrepancy", text: "Rejected due to detected discrepancies in trip claim documentation." },
    { label: "Over allowance", text: "Claimed amount exceeds the approved outstation allowance without justification." },
  ],
  marketing: [
    { label: "Budget not approved", text: "This marketing request exceeds the approved budget allocation." },
    { label: "Customer not validated", text: "The customer has not completed the required validation process." },
  ],
  contract_renewal: [
    { label: "Pending salary review", text: "Contract renewal deferred pending completion of the annual salary review process." },
    { label: "Documentation incomplete", text: "Required contract documentation has not been received or is incomplete." },
    { label: "Position under review", text: "The position itself is under organizational review; renewal will follow that outcome." },
  ],
};
