// Recruitment / Medical Rep hiring — the one vocabulary of the 8 November 2026 workflow.
//
// WHY THIS EXISTS. From Sunday 8 November 2026 every Medical Representative hire follows the owner's
// email to the managers, step for step (docs/recruitment-mr-hiring-workflow.md): one WhatsApp channel,
// HR screening and a first interview, a DSM second interview with mandatory feedback, an RSM
// interview where it applies (the Pedia line — the owner's added section, 7 Nov 2026), an HR Manager
// third interview and an NSM final (or one joint final), the NSM's recommendation, the HR Manager's
// final decision, and the offer. Every screen that shows a Medical Rep candidate's place in that
// process reads its words from HERE, so the page, the drawer, the manager portal, the opened CV and
// the timeline can never call the same step two different things.
//
// PURE. No database, no clock (the start instant is a constant), safe to import from a client
// component.

/**
 * The steps in the email's order. `final` is the NSM final OR the joint HR Manager + NSM final.
 * `rsm` is "if applicable" (the Pedia line): HR books it after the DSM passes, and a candidate with no
 * RSM interview shows the step as not needed. Phoenix cannot tell the line from the candidate — every
 * area exists on all three lines (measured 7 Nov 2026) — so the booking IS the "applicable".
 */
export const MR_STEPS = ["screening", "hr_first", "dsm", "rsm", "hr_manager", "final", "recommendation", "decision", "offer"] as const;
export type MrStep = (typeof MR_STEPS)[number];

/** A candidate who is out of the process, for one of four reasons. */
export const MR_CLOSED = ["hired", "backup", "rejected", "held"] as const;
export type MrClosed = (typeof MR_CLOSED)[number];

/** The six interview rounds a booking can be — the `interview_round` column's own values. */
export const MR_INTERVIEW_ROUNDS = ["hr_first", "dsm", "rsm", "hr_manager", "nsm_final", "joint_final"] as const;
export type MrInterviewRound = (typeof MR_INTERVIEW_ROUNDS)[number];

/** Where a result can be recorded — the `step` column of `ats_mr_hiring_step_results`. */
export const MR_RESULT_STEPS = ["hr_screening", "hr_first", "dsm", "rsm", "hr_manager", "nsm_final", "joint_final", "final_decision"] as const;
export type MrResultStep = (typeof MR_RESULT_STEPS)[number];

/** The three answers, everywhere. */
export const MR_RESULTS = ["pass", "backup", "not_pass"] as const;
export type MrResult = (typeof MR_RESULTS)[number];

/** The NSM's two recommendations (§8). */
export const MR_RECOMMENDATIONS = ["make_offer", "keep_backup"] as const;
export type MrRecommendation = (typeof MR_RECOMMENDATIONS)[number];

/**
 * The instant the workflow starts: Sunday 8 November 2026, 00:00 in Cairo. Egypt is on UTC+2 in
 * November (summer time ends on the last Thursday of October), so this is 22:00 UTC the day before.
 * A CV received before it is never held for arriving outside WhatsApp — the rule did not exist yet.
 */
export const MR_WORKFLOW_START = "2026-11-07T22:00:00.000Z";

/** The job title every Medical Rep booking and offer carries. */
export const MR_JOB_TITLE = "Medical Representative";

export const MR_STEP_LABELS: Record<MrStep, string> = {
  decision: "Final decision",
  dsm: "2nd interview · DSM",
  final: "Final interview · NSM",
  hr_first: "1st interview · HR",
  hr_manager: "3rd interview · HR Manager",
  offer: "Offer",
  rsm: "RSM interview · Pedia line",
  recommendation: "NSM recommendation",
  screening: "New CV · HR screening",
};

/** The step's number on screen, 1 to 8. */
export function mrStepNumber(step: MrStep): number {
  return MR_STEPS.indexOf(step) + 1;
}

export const MR_CLOSED_LABELS: Record<MrClosed, string> = {
  backup: "Kept as backup",
  held: "Held · not on a company WhatsApp",
  hired: "Hired",
  rejected: "Rejected",
};

export const MR_ROUND_LABELS: Record<MrInterviewRound, string> = {
  dsm: "2nd interview · DSM",
  hr_first: "1st interview · HR",
  hr_manager: "3rd interview · HR Manager",
  joint_final: "Joint final · HR Manager + NSM",
  nsm_final: "Final interview · NSM",
  rsm: "RSM interview · Pedia line",
};

/** Which result step an interview round's result is recorded under — the same key, by design. */
export function resultStepForRound(round: MrInterviewRound): MrResultStep {
  return round;
}

export const MR_RESULT_STEP_LABELS: Record<MrResultStep, string> = {
  dsm: "2nd interview · DSM",
  final_decision: "Final decision",
  hr_first: "1st interview · HR",
  hr_manager: "3rd interview · HR Manager",
  hr_screening: "HR screening",
  joint_final: "Joint final · HR Manager + NSM",
  nsm_final: "Final interview · NSM",
  rsm: "RSM interview · Pedia line",
};

/**
 * The words for a result. Three words everywhere (Pass · Keep as backup · Do not pass), except where
 * the email's own words differ: screening "passes" or "rejects", and the final decision "makes an
 * offer" or "rejects".
 */
export function mrResultLabel(step: MrResultStep, result: MrResult): string {
  if (result === "backup") return "Keep as backup";
  if (step === "final_decision") return result === "pass" ? "Make an offer" : "Reject";
  if (step === "hr_screening") return result === "pass" ? "Pass screening" : "Reject";
  return result === "pass" ? "Pass" : "Do not pass";
}

export const MR_RECOMMENDATION_LABELS: Record<MrRecommendation, string> = {
  keep_backup: "Keep as backup",
  make_offer: "Make an offer",
};

/**
 * What a recorded interview result writes onto the booking's own `outcome`, so the calendar's
 * "Outcome?" flag, its daily nag and `settleFinishedInterviewOutcomes` agree with the workflow and
 * never ask the interviewer a second time for an answer already given here.
 */
export function bookingOutcomeForResult(result: MrResult): "shortlisted" | "backup" | "rejected" {
  if (result === "pass") return "shortlisted";
  if (result === "backup") return "backup";
  return "rejected";
}

export function isMrInterviewRound(value: unknown): value is MrInterviewRound {
  return typeof value === "string" && (MR_INTERVIEW_ROUNDS as readonly string[]).includes(value);
}

export function isMrResultStep(value: unknown): value is MrResultStep {
  return typeof value === "string" && (MR_RESULT_STEPS as readonly string[]).includes(value);
}

export function isMrResult(value: unknown): value is MrResult {
  return typeof value === "string" && (MR_RESULTS as readonly string[]).includes(value);
}

export function isMrRecommendation(value: unknown): value is MrRecommendation {
  return typeof value === "string" && (MR_RECOMMENDATIONS as readonly string[]).includes(value);
}

/** The longest comment a result may carry — the column's own check. */
export const MR_COMMENT_LIMIT = 2000;

/** The longest place an in-person interview may name — the column's own check. */
export const MR_LOCATION_LIMIT = 300;
