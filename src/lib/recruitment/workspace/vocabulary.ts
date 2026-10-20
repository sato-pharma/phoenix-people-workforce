// Recruitment workspace — the closed lists the owner ticked on 20 Oct 2026: why a CV was rejected
// (#24 "a rejection reason from a fixed list … it makes rejections countable") and what a call came
// to (#23 "one-tap call results"). The database CHECKs in
// 20261020010000_ats_recruitment_workspace_foundation.sql hold the same keys; this file holds the
// words. Pure.

export const rejectionReasons = [
  "wrong_degree",
  "outside_area",
  "salary_too_high",
  "not_enough_experience",
  "no_answer_to_calls",
  "no_longer_interested",
  "failed_interview",
  "duplicate_cv",
  "other",
] as const;

export type RejectionReason = (typeof rejectionReasons)[number];

export const rejectionReasonLabels: Record<RejectionReason, string> = {
  wrong_degree: "Wrong degree",
  outside_area: "Outside the area",
  salary_too_high: "Salary too high",
  not_enough_experience: "Not enough experience",
  no_answer_to_calls: "No answer to calls",
  no_longer_interested: "No longer interested",
  failed_interview: "Failed the interview",
  duplicate_cv: "Duplicate CV",
  other: "Other",
};

export function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && (rejectionReasons as readonly string[]).includes(value);
}

/** "Other" must say what — a reason nobody can read back is not countable. */
export function rejectionRefusal(reason: unknown, note: string | null | undefined): string | null {
  if (!isRejectionReason(reason)) return "Choose why this CV is rejected.";
  if (reason === "other" && !String(note ?? "").trim()) return "Write a short note for “Other”.";
  if (String(note ?? "").length > 300) return "Keep the note to 300 characters.";
  return null;
}

export const callResults = ["called", "no_answer", "interested", "not_interested", "call_back"] as const;

export type CallResult = (typeof callResults)[number];

export const callResultLabels: Record<CallResult, string> = {
  called: "Called",
  no_answer: "No answer",
  interested: "Interested",
  not_interested: "Not interested",
  call_back: "Call back",
};

export function isCallResult(value: unknown): value is CallResult {
  return typeof value === "string" && (callResults as readonly string[]).includes(value);
}

/** The four sources the owner named, the fourth worded by him on 20 Oct ("Interview Calendar"). */
export const candidateSources = ["whatsapp", "email", "website", "interview_calendar", "other"] as const;

export type CandidateSourceKey = (typeof candidateSources)[number];

export const candidateSourceLabels: Record<CandidateSourceKey, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  website: "Website",
  interview_calendar: "Interview Calendar",
  other: "Added by hand",
};

export function candidateSourceKey(raw: string | null | undefined): CandidateSourceKey {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "whatsapp" || value === "email" || value === "website" || value === "interview_calendar" ? value : "other";
}

/** How a manager handed a CV back — the three sources `ats_v_candidate_returns` unions. */
export const returnSourceLabels: Record<string, string> = {
  district_folder: "Returned from a manager's folder",
  manager_skip: "Skipped by the manager",
  taken_back: "Taken back from the manager",
};

/** District-folder return reasons (ats_candidate_district_returns.reason_code). */
export const districtReturnReasonLabels: Record<string, string> = {
  area_not_match: "Area does not match",
  other: "Other",
};

/** Overdue thresholds the owner ticked (#11): shortlisted 14 days with no action, sent 7 days with no reply. */
export const OVERDUE_SHORTLIST_DAYS = 14;
export { STALE_SEND_ESCALATE_AFTER_DAYS as OVERDUE_SENT_DAYS } from "@/lib/recruitment/stale-send-thresholds";

/** Rejections leave the tabs for the archive after this many days (owner, 2026-10-20: "30 days"). */
export const ARCHIVE_REJECTED_AFTER_DAYS = 30;

/** The undo window (owner, 2026-10-20: "a 10-second Undo", changed from 5). */
export const UNDO_WINDOW_MS = 10_000;
