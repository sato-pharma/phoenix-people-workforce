// Recruitment / ATS — "Ask again": the template, and who may be asked. Pure — no database, no send,
// so the one-off submit script and the tests can load it (the send lives in
// whatsapp-followup-template.ts, which pulls in the WhatsApp Inbox's sender).

import { candidateGreetingName } from "@/lib/recruitment/candidate-greeting";
import type { TemplateApprovalStatus } from "@/lib/whatsapp-inbox/graph";

export const FOLLOWUP_TEMPLATE_NAME = "phx_application_followup";
export const FOLLOWUP_TEMPLATE_LANGUAGE = "en";
/** The template's body, exactly as submitted to Meta (owner's chosen wording, 2026-10-20). */
export const FOLLOWUP_TEMPLATE_BODY =
  "Hello {{name}}, thank you for applying to Sato Pharma. A few questions about your application are still unanswered. Reply to this message to continue.";

/** One ask per person per day: a second press inside it is refused, never a second message. */
export const FOLLOWUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A bulk press sends to at most this many, one after another. */
export const FOLLOWUP_BULK_MAX = 50;

export const followupStatusLabels: Record<TemplateApprovalStatus, string> = {
  approved: "Ready to send",
  missing: "Waiting for Meta approval (the message has not been submitted yet)",
  pending: "Waiting for Meta approval",
  rejected: "Meta rejected the message; it needs rewording and submitting again",
};

/**
 * The name the template greets: "Dr" and their first name, as every message to a candidate greets
 * them (owner, 2026-10-20 — see candidate-greeting.ts), or "there" with no name, never "Dr there".
 */
export function followupFirstName(fullName: string | null | undefined): string {
  return candidateGreetingName(fullName) || "there";
}

export type FollowupCandidateRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  whatsapp: string | null;
  status: string | null;
  archived_at: string | null;
  followup_sent_at: string | null;
  missing_answer_keys: string[] | null;
};

/**
 * Why this candidate cannot be asked again right now, or null when they can. `waId` is the number
 * it would go to (already normalized), `placed` whether they are filed in any tab.
 */
export function askAgainRefusal(input: {
  candidate: Pick<FollowupCandidateRow, "status" | "archived_at" | "followup_sent_at" | "missing_answer_keys">;
  waId: string | null;
  forwarder: boolean;
  placed: boolean;
  nowMs: number;
}): string | null {
  const { candidate } = input;
  if (candidate.status === "hired" || candidate.status === "rejected" || candidate.archived_at) {
    return "This candidate is closed (hired, rejected or archived), so they are not asked again.";
  }
  if (!input.waId) return "There is no mobile number on this candidate that WhatsApp can reach.";
  if (input.forwarder) {
    return "The only number on file sent CVs for several people, so it is not this applicant's own. Add their own number first.";
  }
  const sentAt = candidate.followup_sent_at ? Date.parse(candidate.followup_sent_at) : Number.NaN;
  if (Number.isFinite(sentAt) && input.nowMs - sentAt < FOLLOWUP_COOLDOWN_MS) {
    return "They were already asked in the last 24 hours.";
  }
  const missing = candidate.missing_answer_keys ?? [];
  if (missing.length === 0 && input.placed) return "Nothing is missing: every question is answered and they are filed.";
  return null;
}
