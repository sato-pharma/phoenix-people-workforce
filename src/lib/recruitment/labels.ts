// Recruitment / ATS — how a stored code is written when a person reads it.
//
// The module used to humanise every code with one local helper that replaced underscores with
// spaces and upper-cased the first letter of each word. That is enough for `phone_screening`, and
// wrong for everything else in the vocabulary, in two ways that both reached production screens:
//
//   - The `req_` prefix is a namespace, not a word. `req_filled` rendered as "Req Filled" on the
//     requisition badge, where the only sensible reading is "Filled".
//   - An acronym is not a word either. `hr_interview` rendered as "Hr Interview", `cv_screening`
//     as "Cv Screening", and the interview type `cv` as "Cv".
//
// Confirmed live in production on 2026-08-24: the stored values are exactly `req_filled`,
// `req_open`, `hr_interview`, `cv_screening`, `in_candidate_pool` and `cv`, so these are the codes
// the maps below have to cover, not a hypothetical set.
//
// Follows the shape of candidate-status.ts: explicit maps for the fixed vocabularies, so a label
// is a decision someone made rather than whatever a regular expression happened to produce. Pure
// (no database, no React) so a route, a report and the client workspace share one spelling.

import { applicationStages, requisitionStatuses } from "@/lib/recruitment/types";
import type { ApplicationStage, RequisitionStatus } from "@/lib/recruitment/types";

export const requisitionStatusLabels: Record<RequisitionStatus, string> = {
  req_cancelled: "Cancelled",
  req_closed: "Closed",
  req_draft: "Draft",
  req_filled: "Filled",
  req_on_hold: "On hold",
  req_open: "Open",
  req_published: "Published",
};

export const applicationStageLabels: Record<ApplicationStage, string> = {
  application_received: "Application received",
  application_rejected: "Rejected",
  application_withdrawn: "Withdrawn",
  backup_candidate: "Backup candidate",
  call_back: "Call back",
  cv_screening: "CV screening",
  final_selection: "Final selection",
  hired: "Hired",
  hiring_manager_interview: "Hiring manager interview",
  hr_interview: "HR interview",
  in_candidate_pool: "In candidate pool",
  interview_scheduling: "Interview scheduling",
  manager_interview_completed: "Manager interview completed",
  no_response: "No response",
  offer_accepted: "Offer accepted",
  offer_approved: "Offer approved",
  offer_declined: "Offer declined",
  offer_draft: "Offer draft",
  offer_expired: "Offer expired",
  offer_generated: "Offer generated",
  offer_initiated: "Offer initiated",
  offer_negotiation: "Offer negotiation",
  offer_pending_approval: "Offer pending approval",
  offer_sent: "Offer sent",
  on_hold: "On hold",
  phone_screening: "Phone screening",
  pre_boarding: "Pre-boarding",
  shortlisted: "Shortlisted",
};

/**
 * Words that are acronyms rather than words, spelled the way this company spells them.
 *
 * Keyed lowercase. Only terms that actually occur in recruitment values are listed — an acronym
 * table that tries to be exhaustive starts mangling ordinary words instead ("id" is a word in
 * "id card" and an acronym in "national id", and guessing between them is how "Hr" became a rule
 * in the first place).
 */
const acronyms: Record<string, string> = {
  ats: "ATS",
  ceo: "CEO",
  cv: "CV",
  gpm: "GPM",
  hr: "HR",
  nsm: "NSM",
  qppv: "QPPV",
  sfe: "SFE",
};

/**
 * The fallback for codes that have no fixed vocabulary — interview types, audit actions, offer
 * responses, intake sources. Underscores become spaces, the first word is capitalised, and a known
 * acronym keeps its own spelling wherever it appears.
 *
 * Sentence case, not Title Case: "Offer accepted" reads as a phrase, "Offer Accepted" reads as a
 * database value that someone ran a regular expression over. The maps above follow the same rule.
 */
export function humanizeRecruitmentTerm(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const words = raw
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => acronyms[word.toLowerCase()] ?? word.toLowerCase());

  if (words.length === 0) return "";

  const [first, ...rest] = words;
  const lead = acronyms[first.toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [lead, ...rest].join(" ");
}

/** A requisition status as a person reads it. Unknown codes fall back rather than showing raw. */
export function requisitionStatusLabel(status: string | null | undefined): string {
  const raw = String(status ?? "").trim();
  if (!raw) return "";
  if ((requisitionStatuses as readonly string[]).includes(raw)) {
    return requisitionStatusLabels[raw as RequisitionStatus];
  }
  // Strip the namespace even on a code this file has not been taught yet, so a stage added in the
  // database before it is added here degrades to "Something" rather than to "Req Something".
  return humanizeRecruitmentTerm(raw.replace(/^req_/, ""));
}

/** An application stage as a person reads it. */
export function applicationStageLabel(stage: string | null | undefined): string {
  const raw = String(stage ?? "").trim();
  if (!raw) return "";
  if ((applicationStages as readonly string[]).includes(raw)) {
    return applicationStageLabels[raw as ApplicationStage];
  }
  return humanizeRecruitmentTerm(raw);
}
