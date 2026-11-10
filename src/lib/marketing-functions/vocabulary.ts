// Marketing Functions & Field Visit Feedback — every word and colour the two sheets carry.
//
// 🔒 HER WORDING AND HER COLOURS ARE FINAL (owner, 2026-11-10: "use her exact wording", "same colors
// same wording"). Dr. Rasha Sabry, Group Product Manager, sent Dr. Ahmed Sharaf two sheets: the
// "Monthly Maketing Functions Sheet.xlsx" and the "Marketing Feedback.doc" form. Every label below is
// copied from those files and from her covering email, and every fill is the cell fill of her
// workbook (theme tints resolved against its own theme). The only change is the typo
// "Promotianal" → "Promotional". Never restyle a category to the house palette or reword a label;
// fix only a real defect, the way a design he hands over is treated.
//
// Pure: no IO, no clock. The screens, the Excel export and the tests all read this one file, so the
// three can never disagree about a word.

export type MarketingFunctionCategoryKey =
  | "planning"
  | "promotional"
  | "trainings"
  | "events"
  | "field"
  | "clinical"
  | "digital"
  | "admin";

export type MarketingFunctionCategory = {
  key: MarketingFunctionCategoryKey;
  /** The bold head of her column M cell. */
  title: string;
  /** Her parenthesis, verbatim. `emphasis` is the word she set in red inside it. */
  detail: string;
  emphasis?: string;
  /** Her cell fill, as a hex colour. */
  fill: string;
  /** The Due Date cells of the band when she gave them their own fill (Field Activity only). */
  dueDateFill?: string;
};

export const MARKETING_FUNCTION_CATEGORIES: readonly MarketingFunctionCategory[] = [
  { key: "planning", title: "Planning", detail: "(IMS analysis, Activities sheets, Plan review, TOP)", fill: "#D8EACC" },
  {
    key: "promotional",
    title: "Promotional materials",
    detail: "(creation of new materials; printings/ giveaways/ booth… etc.)",
    emphasis: "creation",
    fill: "#FFF2CC",
  },
  { key: "trainings", title: "Trainings", detail: "(new comers training, refreshments, quiz… etc.)", fill: "#E2EFDA" },
  {
    key: "events",
    title: "Event Preparation",
    detail: "(events lists revision, reservations, conferences arrangements)",
    fill: "#DEEBF7",
  },
  {
    key: "field",
    title: "Field Activity",
    detail: "(double visits/conference attendance/ company meetings… etc.)",
    fill: "#BDD7EE",
    dueDateFill: "#B4C7E7",
  },
  { key: "clinical", title: "Clinical Trials", detail: "(if any)", fill: "#FFE699" },
  { key: "digital", title: "Digital activity", detail: "(if any)", fill: "#EDEDED" },
  { key: "admin", title: "Admin. Work", detail: "(release of materials/ requests approvals… etc.)", fill: "#F4B084" },
] as const;

/** The red she used for "creation" inside the Promotional materials cell. */
export const MARKETING_FUNCTION_EMPHASIS_COLOR = "#FF0000";

export const MARKETING_FUNCTION_CATEGORY_KEYS: readonly MarketingFunctionCategoryKey[] =
  MARKETING_FUNCTION_CATEGORIES.map((category) => category.key);

export function isMarketingFunctionCategoryKey(value: unknown): value is MarketingFunctionCategoryKey {
  return typeof value === "string" && (MARKETING_FUNCTION_CATEGORY_KEYS as readonly string[]).includes(value);
}

export function marketingFunctionCategory(key: MarketingFunctionCategoryKey): MarketingFunctionCategory {
  return MARKETING_FUNCTION_CATEGORIES.find((category) => category.key === key) ?? MARKETING_FUNCTION_CATEGORIES[0];
}

/** Her header row, verbatim. The parenthesis of the second head is the smaller type in her sheet. */
export const MARKETING_FUNCTION_COLUMNS = {
  category: "M",
  description: "Item Description",
  descriptionDetail: "(please specify the product)",
  dueDate: "Due Date",
  statusMid: "Status/ mid month",
  statusEnd: "Status/ end of month",
} as const;

export const MARKETING_FUNCTIONS_TITLE = "Monthly Marketing Functions";

/** Her email, word for word — the sheet's own explanation, shown on the page. */
export const MARKETING_FUNCTIONS_PURPOSE =
  "The purpose of this sheet is to document your marketing activities and plans on a monthly basis, according to the categories and structure provided in the attached sheet.";
export const MARKETING_FUNCTIONS_PLANNED = "Planned: What you are planning to do during the month.";
export const MARKETING_FUNCTIONS_ACTUAL = "Actual: What you actually accomplished during the month.";
export const MARKETING_FUNCTIONS_MONTH_END =
  "At the end of each month, please complete the sheet with all the activities you have actually conducted. This will serve as a documented history of your marketing activities and achievements, allowing us to track your work and review the progress over time.";

export type MarketingFunctionOrigin = "planned" | "actual";
export const MARKETING_FUNCTION_ORIGIN_LABELS: Record<MarketingFunctionOrigin, string> = {
  planned: "Planned",
  actual: "Actual",
};

/** The one-tap status for "Status/ mid month" and "Status/ end of month". */
export type MarketingFunctionStatus = "not_started" | "in_progress" | "done" | "postponed" | "cancelled";
export const MARKETING_FUNCTION_STATUSES: readonly MarketingFunctionStatus[] = [
  "not_started",
  "in_progress",
  "done",
  "postponed",
  "cancelled",
] as const;
export const MARKETING_FUNCTION_STATUS_LABELS: Record<MarketingFunctionStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
  postponed: "Postponed",
  cancelled: "Cancelled",
};
export function isMarketingFunctionStatus(value: unknown): value is MarketingFunctionStatus {
  return typeof value === "string" && (MARKETING_FUNCTION_STATUSES as readonly string[]).includes(value);
}

export type MarketingMonthStatus = "draft" | "submitted" | "reviewed";
export const MARKETING_MONTH_STATUS_LABELS: Record<MarketingMonthStatus, string> = {
  draft: "Draft",
  submitted: "Submitted for review",
  reviewed: "Reviewed",
};

// ─── Marketing Field Visit Feedback ────────────────────────────────────────────

export const FIELD_FEEDBACK_TITLE = "Marketing Field Visit Feedback";

export type FieldVisitType = "single" | "double";
export const FIELD_VISIT_TYPE_LABEL = "Type of field visit";
export const FIELD_VISIT_TYPE_LABELS: Record<FieldVisitType, string> = { single: "Single", double: "Double" };

/** Her form's header boxes, verbatim. */
export const FIELD_FEEDBACK_LABELS = {
  accompaniedPerson: "Accompanied person",
  jobTitle: "Job title",
  area: "Area",
  date: "Date",
  visitedClinics: "No. of visited clinics",
  visitedPharmacies: "No. of visited Pharmacies",
  objectives: "Objectives of field visit",
  callRemarks: "Call Remarks",
  comments: "Comments/ explanation of the call remarks",
  doctorsComments: "Doctors' comments (if Any)",
  recommendations: "Recommendations",
  signature: "Signature",
} as const;

export type CallRemarkKey =
  | "conveying_message"
  | "selling_points"
  | "medical_knowledge"
  | "product_knowledge"
  | "competitors_knowledge"
  | "product_strategy"
  | "detail_aid"
  | "samples"
  | "giveaways"
  | "pharmacies_visits"
  | "feedback_collection";

/**
 * Her eleven call remarks, in her order and her words. `owner` is who acts on a gap in it, read from
 * her email's own list: selling skills are worked on "together with Dr. Salma", the pharmacy and
 * feedback habits are the Sales Manager's, and the product and medical message is Marketing's (the
 * owner's 2026-11-04 rule: product and medical knowledge belong to the Product Manager).
 */
export const CALL_REMARKS: readonly { key: CallRemarkKey; label: string; owner: FieldActionOwner }[] = [
  { key: "conveying_message", label: "Conveying message", owner: "training" },
  { key: "selling_points", label: "Grasping of selling points", owner: "training" },
  { key: "medical_knowledge", label: "Medical knowledge", owner: "marketing" },
  { key: "product_knowledge", label: "Product knowledge", owner: "marketing" },
  { key: "competitors_knowledge", label: "Competitors knowledge", owner: "marketing" },
  { key: "product_strategy", label: "Sticking to product strategy", owner: "marketing" },
  { key: "detail_aid", label: "Usage/handling of Detail Aid", owner: "marketing" },
  { key: "samples", label: "Usage of samples", owner: "marketing" },
  { key: "giveaways", label: "Usage of giveaways", owner: "marketing" },
  { key: "pharmacies_visits", label: "Pharmacies visits", owner: "sales_manager" },
  { key: "feedback_collection", label: "Feed back collection", owner: "sales_manager" },
] as const;

export const CALL_REMARK_KEYS: readonly CallRemarkKey[] = CALL_REMARKS.map((remark) => remark.key);
export function isCallRemarkKey(value: unknown): value is CallRemarkKey {
  return typeof value === "string" && (CALL_REMARK_KEYS as readonly string[]).includes(value);
}

/** Her four columns, best first. */
export type CallRating = "excellent" | "good" | "average" | "poor";
export const CALL_RATINGS: readonly CallRating[] = ["excellent", "good", "average", "poor"] as const;
export const CALL_RATING_LABELS: Record<CallRating, string> = {
  excellent: "Excellent",
  good: "Good",
  average: "Average",
  poor: "Poor",
};
export function isCallRating(value: unknown): value is CallRating {
  return typeof value === "string" && (CALL_RATINGS as readonly string[]).includes(value);
}
/** A strength is Excellent or Good; a gap is Average or Poor. */
export function isStrengthRating(rating: CallRating | null | undefined): boolean {
  return rating === "excellent" || rating === "good";
}
export function isGapRating(rating: CallRating | null | undefined): boolean {
  return rating === "average" || rating === "poor";
}
/** 4 for Excellent down to 1 for Poor — only to say better or worse than last time. */
export function callRatingRank(rating: CallRating): number {
  return 4 - CALL_RATINGS.indexOf(rating);
}

export type FieldActionOwner = "marketing" | "sales_manager" | "training";
export const FIELD_ACTION_OWNERS: readonly FieldActionOwner[] = ["marketing", "sales_manager", "training"] as const;
/** Her email's three addressees of a finding, in her words. */
export const FIELD_ACTION_OWNER_LABELS: Record<FieldActionOwner, string> = {
  marketing: "Areas that we need to work on from the Marketing side",
  sales_manager: "Areas that need to be addressed by the Sales Manager",
  training: "Selling skills gaps that we can work on together with Dr. Salma",
};
export const FIELD_ACTION_OWNER_SHORT: Record<FieldActionOwner, string> = {
  marketing: "Marketing",
  sales_manager: "Sales Manager",
  training: "Selling skills (Dr. Salma)",
};
export function isFieldActionOwner(value: unknown): value is FieldActionOwner {
  return typeof value === "string" && (FIELD_ACTION_OWNERS as readonly string[]).includes(value);
}

/** Her email, word for word — the purpose of the feedback, shown on the tracking page. */
export const FIELD_FEEDBACK_PURPOSE =
  "This sheet is designed to help us systematically track the representatives’ performance during the double visits, including their strengths, weaknesses, and development gaps.";
export const FIELD_FEEDBACK_HELPS_INTRO = "The feedback will help us identify:";
export const FIELD_FEEDBACK_HELPS: readonly string[] = [
  "Areas that we need to work on from the Marketing side.",
  "Areas that need to be addressed by the Sales Manager.",
  "Any selling skills gaps that we can work on together with Dr. Salma.",
  "The representative’s key strengths that we can continue to develop and leverage.",
  "Recurring gaps that may require a specific development plan or training intervention.",
] as const;
export const FIELD_FEEDBACK_OVER_TIME =
  "Over time, this will give us a clear picture of each representative’s performance: where they are strong, where they need improvement, and what development opportunities we should focus on.";
export const FIELD_FEEDBACK_OBJECTIVE =
  "The main objective is to make this a continuous tracking and development tool, rather than just a feedback sheet, so that we can monitor progress and measure improvement over time.";
