// Weekly Planning module — planning and governance only. No payroll or leave mutation.

export type WeeklyPlanStatus =
  | "draft"
  | "submitted"
  | "manager_approved"
  | "manager_returned"
  | "ceo_approved"
  | "ceo_returned"
  | "final_approved"
  | "cancelled";

export const weeklyPlanStatuses = [
  "draft",
  "submitted",
  "manager_approved",
  "manager_returned",
  "ceo_approved",
  "ceo_returned",
  "final_approved",
  "cancelled",
] as const satisfies readonly WeeklyPlanStatus[];

export type WeeklyPlanActivityType =
  | "Office"
  | "Field"
  | "Double Visit"
  | "Training"
  | "Meeting"
  | "Event"
  | "Travel"
  | "Admin"
  | "Remote"
  | "Vacation"
  | "Other";

export const weeklyPlanActivityTypes = [
  "Office",
  "Field",
  "Double Visit",
  "Training",
  "Meeting",
  "Event",
  "Travel",
  "Admin",
  "Remote",
  "Vacation",
  "Other",
] as const satisfies readonly WeeklyPlanActivityType[];

export type WeeklyPlanActivityCode =
  | "OF"
  | "FD"
  | "DV"
  | "TR"
  | "MT"
  | "EV"
  | "TV"
  | "AD"
  | "RW"
  | "AV"
  | "OT";

export const weeklyPlanActivityCodes = [
  "OF",
  "FD",
  "DV",
  "TR",
  "MT",
  "EV",
  "TV",
  "AD",
  "RW",
  "AV",
  "OT",
] as const satisfies readonly WeeklyPlanActivityCode[];

export const ACTIVITY_TYPE_TO_CODE: Record<WeeklyPlanActivityType, WeeklyPlanActivityCode> = {
  Office: "OF",
  Field: "FD",
  "Double Visit": "DV",
  Training: "TR",
  Meeting: "MT",
  Event: "EV",
  Travel: "TV",
  Admin: "AD",
  Remote: "RW",
  Vacation: "AV",
  Other: "OT",
};

export const ACTIVITY_CODE_TO_TYPE: Record<WeeklyPlanActivityCode, WeeklyPlanActivityType> = {
  OF: "Office",
  FD: "Field",
  DV: "Double Visit",
  TR: "Training",
  MT: "Meeting",
  EV: "Event",
  TV: "Travel",
  AD: "Admin",
  RW: "Remote",
  AV: "Vacation",
  OT: "Other",
};

export type WeeklyPlanApprovalRole = "manager" | "ceo";

export type WeeklyPlanDecision = "approved" | "returned";

/**
 * v1 eligible job titles for weekly planning.
 * Medical Reps are NOT eligible.
 */
export const WEEKLY_PLAN_ELIGIBLE_JOB_TITLES: readonly string[] = [
  "National Sales Manager",
  "Group Product Manager",
  "Product Manager",
  "Marketing Manager",
  "Training Manager",
  "SFE Manager",
  "Regional Manager",
  "Sales Director",
  "Sales Manager",
];

export type WeeklyPlan = {
  id: string;
  employeeHrId: string;
  employeeName: string;
  weekKey: string;
  weekStartDate: string;
  weekEndDate: string;
  monthKey: string;
  month: number;
  year: number;
  status: WeeklyPlanStatus;
  managerHrId: string | null;
  managerName: string | null;
  managerDecision: WeeklyPlanDecision | null;
  managerDecisionAt: string | null;
  managerDecisionByHrId: string | null;
  managerDecisionComment: string | null;
  ceoDecision: WeeklyPlanDecision | null;
  ceoDecisionAt: string | null;
  ceoDecisionByHrId: string | null;
  ceoDecisionComment: string | null;
  finalizedAt: string | null;
  submittedAt: string | null;
  submittedByLoginId: string | null;
  workflowNotes: string;
  hierarchySnapshot: Record<string, unknown>;
  jobTitleAtSubmission: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WeeklyPlanDay = {
  id: string;
  planId: string;
  dayDate: string;
  dayNumber: number;
  activityType: WeeklyPlanActivityType;
  activityCode: WeeklyPlanActivityCode;
  location: string | null;
  area: string | null;
  accompaniedByHrId: string | null;
  accompaniedByName: string | null;
  objective: string | null;
  expectedOutput: string | null;
  notes: string;
  isPublicHoliday: boolean;
  publicHolidayName: string | null;
  isWeekend: boolean;
  needsLeaveReconciliation: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WeeklyPlanApprovalToken = {
  id: string;
  planId: string;
  recipientHrId: string;
  role: WeeklyPlanApprovalRole;
  tokenHash: string;
  decision: WeeklyPlanDecision | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
};

/** Input when creating a new plan (connector or form submission). */
export type WeeklyPlanDraftInput = {
  employeeHrId: string;
  employeeName: string;
  weekKey: string;
  weekStartDate: string;
  weekEndDate: string;
  monthKey: string;
  month: number;
  year: number;
  managerHrId?: string | null;
  managerName?: string | null;
  workflowNotes?: string;
  hierarchySnapshot?: Record<string, unknown>;
  jobTitleAtSubmission?: string | null;
  createdBy?: string;
};

/** Input for a single day entry. activityCode is derived from activityType. */
export type WeeklyPlanDayInput = {
  dayDate: string;
  dayNumber: number;
  activityType: WeeklyPlanActivityType;
  location?: string | null;
  area?: string | null;
  accompaniedByHrId?: string | null;
  accompaniedByName?: string | null;
  objective?: string | null;
  expectedOutput?: string | null;
  notes?: string;
  isPublicHoliday?: boolean;
  publicHolidayName?: string | null;
  isWeekend?: boolean;
  needsLeaveReconciliation?: boolean;
};
