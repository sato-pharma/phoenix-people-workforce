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
 * `rsm` is "if applicable" (the Pedia line). Phoenix cannot tell the line from the candidate — every
 * area exists on all three lines (measured 7 Nov 2026) — so HR SAYS it: the 1st-interview result
 * confirms the area and the line, and the RSM step appears only when that line is Pedia (owner,
 * 7 Nov 2026: "by default, it is not appearing. It only choose if the talent acquisition or the HR
 * doing the first interview choose that this is PD-align"). Otherwise it is not shown at all.
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

/**
 * The three lines a Medical Rep works on — the `confirmed_line` column's own values. HR confirms one
 * at the 1st-interview result; Pedia adds the RSM interview after the DSM's.
 */
export const MR_LINES = ["pedia", "anti_infective", "cns"] as const;
export type MrLine = (typeof MR_LINES)[number];

export const MR_LINE_LABELS: Record<MrLine, string> = {
  anti_infective: "Anti Infective",
  cns: "CNS",
  pedia: "Pedia",
};

export function isMrLine(value: unknown): value is MrLine {
  return typeof value === "string" && (MR_LINES as readonly string[]).includes(value);
}

/** The areas HR may confirm, grouped by region in the WhatsApp bot's own order (areas.ts). */
export type MrAreaChoice = { region: string; areas: string[] };

/** How an interview is held. A phone call is the HR 1st interview's third way (owner, 7 Nov 2026). */
export type MrPlatform = "zoom" | "in_office" | "phone";

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

/**
 * The first CV the Medical Rep Hiring page lists: Saturday 7 November 2026, 00:00 in Cairo (22:00 UTC
 * on the 6th) — owner, 7 Nov 2026: "all the cvs recieved starting from 7 nov". A day before the
 * workflow starts, so the CVs of the 7th are worked in it too; the one-channel hold still starts with
 * the workflow (MR_WORKFLOW_START), so a CV that came by email on the 7th is listed, never held.
 */
export const MR_LIST_FROM = "2026-11-06T22:00:00.000Z";

/** Whether an instant is on or after another. An unreadable date is never on or after anything. */
export function receivedOnOrAfter(receivedAt: string | null | undefined, instant: string): boolean {
  const received = new Date(String(receivedAt ?? "")).getTime();
  return Number.isFinite(received) && received >= new Date(instant).getTime();
}

/**
 * Whether a CV belongs to the workflow at all: received on or after MR_LIST_FROM. Only those are on
 * the Medical Rep Hiring page; a candidate received before it finishes in the workspace as before
 * (owner, 7 Nov 2026). An unreadable date is left out rather than guessed in.
 */
export function isInMrWorkflow(receivedAt: string | null | undefined): boolean {
  return receivedOnOrAfter(receivedAt, MR_LIST_FROM);
}

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

/** The longest area name HR may confirm — the `confirmed_area_name` column's own check. */
export const MR_AREA_LIMIT = 120;
