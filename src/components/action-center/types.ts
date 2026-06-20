export type ActionHubModule =
  | "leave"
  | "resignation"
  | "excuse"
  | "outstation"
  | "marketing"
  | "contract_renewal"
  | "weekly_plan";

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

// One planned activity, rendered read-only in the approver inbox calendar. Kept
// structurally identical to ApproverPlanItem in the weekly-planning service so the
// service result passes straight through without re-shaping.
export type WeeklyPlanCalendarItem = {
  activityDate: string;
  activityLabel: string;
  activityType: string;
  area: string | null;
  isCoaching: boolean;
  notes: string | null;
  objective: string | null;
  region: string | null;
  repName: string | null;
  timeLabel: string | null;
};

export type WeeklyPlanDetail = {
  module: "weekly_plan";
  // Which approval gate the caller is acting on: the direct-manager review of a
  // freshly submitted plan, or the CEO approval of a manager-approved plan.
  stage: "manager" | "ceo";
  planKind: "weekly" | "monthly";
  periodKey: string;
  periodStartDate: string;
  periodEndDate: string;
  employeeJobTitle: string | null;
  managerName: string | null;
  itemCount: number;
  // The full plan, day-by-day, so the approver reviews everything inline without
  // leaving the Action Center.
  items: WeeklyPlanCalendarItem[];
  // Secondary deep-link to the full planner surface (admin or portal shell).
  reviewHref: string;
};

export type ActionHubDetail =
  | LeaveDetail
  | ResignationDetail
  | ExcuseDetail
  | OutstationDetail
  | MarketingDetail
  | ContractRenewalDetail
  | WeeklyPlanDetail;

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
  weekly_plan: "Weekly Plan",
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
  weekly_plan: [
    { label: "Missing field coverage", text: "Returned: the plan does not cover the expected field days for this period." },
    { label: "Wrong region / area", text: "Returned: please correct the region/area selected for one or more activities." },
    { label: "Insufficient detail", text: "Returned: add objectives and customer/brick detail before resubmitting." },
  ],
};

// ── "My requests" tab (submitter-side view) ───────────────────────────────────
// The requests the signed-in employee submitted themselves, across modules, each
// with its live approval status. Read-only — the actual approve/reject happens in
// the "Awaiting my action" inbox or the module's own page.

export type MyRequestModule = "leave" | "excuse" | "outstation" | "weekly_plan" | "resignation";

export type MyRequestStatusTone = "pending" | "approved" | "rejected" | "returned" | "neutral";

export type MyRequestItem = {
  id: string;
  module: MyRequestModule;
  title: string;
  statusLabel: string;
  statusTone: MyRequestStatusTone;
  submittedAt: string;
  href: string | null;
  lines: Array<{ label: string; value: string }>;
  decisionNote: string | null;
};

export type MyRequestsData = {
  generatedAt: string;
  items: MyRequestItem[];
};

export const MY_REQUEST_MODULE_LABELS: Record<MyRequestModule, string> = {
  leave: "Vacation",
  excuse: "Excuse",
  outstation: "Outstation",
  weekly_plan: "Weekly Plan",
  resignation: "Resignation",
};
