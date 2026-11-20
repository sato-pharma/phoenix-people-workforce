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

