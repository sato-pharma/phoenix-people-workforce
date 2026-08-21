// Recruitment / ATS — the contact details an AI read off a CV that the candidate record still lacks.
//
// Why this exists: cv-auto-apply.ts deliberately refuses to write `email` unattended, because
// email is one of the two DEDUPE-DECIDING keys — rewriting it can silently repoint one person's
// record at another. `phone` it writes only when the intake CREATED the candidate, never on a
// match. Both rules are correct and this module does not relax them.
//
// What they leave behind is a gap nothing was closing. Measured on production 2026-08-21: 250 of
// 549 candidates had NEITHER an email nor a phone, and 219 of those had one or both sitting in
// ats_candidate_cv_extractions, already read and already paid for. 248 of the 250 arrived in a
// single bulk WhatsApp forward from one staff mailbox, so intake took its identity from the
// FORWARDER — whose own number must never be written onto 248 different applicants — while the
// applicant's real details were inside the attachment all along.
//
// So the unattended path stays shut and this opens the ATTENDED one: propose, let a human accept.
// The proposal is derived here as a pure function; the write is plain updateCandidate, which
// already recomputes email_norm/phone_norm and already turns a 23505 collision into a readable
// error.
//
// Deliberately pure (no DB, no AI imports) so the rules are unit testable — same reason
// cv-auto-apply.ts is. The DB half lives in contact-review-service.ts.

import { isEmptyExtractedField, type ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction-fields";
import { isBlankCandidateValue, isSingleDiallablePhone } from "@/lib/recruitment/cv-auto-apply";

/** One proposed value, carrying the AI's own hedge so a reviewer sees what it was unsure about. */
export type ContactProposalField = {
  value: string;
  confidence: "high" | "low";
};

export type ContactProposal = {
  email: ContactProposalField | null;
  phone: ContactProposalField | null;
};

/** True when a proposal has nothing in it — the caller can skip the candidate entirely. */
export function isEmptyContactProposal(proposal: ContactProposal): boolean {
  return proposal.email === null && proposal.phone === null;
}

/**
 * Whether a proposed value is ONE email address rather than several run together.
 *
 * The exact hazard isSingleDiallablePhone guards against, on the other unique index. `email_norm`
 * carries a partial UNIQUE index that only the app writer maintains, so a value like
 * "ahmed@gmail.com / ahmed.work@yahoo.com" — which a CV's contact line really does produce, and
 * which the AI transcribes faithfully and at HIGH confidence — goes straight into the dedupe index
 * as one junk key. A later genuine application from either real address then fails to match.
 *
 * A blank column costs nothing permanent: the value stays in extracted_fields. So this declines
 * anything it cannot vouch for rather than writing it.
 */
export function isSingleEmailAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  // Any separator at all means the CV listed more than one address, or glued a label to it.
  if (/[\s,;/|<>()\\]/.test(trimmed)) return false;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0 || domain.length === 0) return false;
  // A real domain has a dot and a TLD of at least two letters.
  return /^[^.@]+(\.[^.@]+)*\.[A-Za-z]{2,}$/.test(domain);
}

function readStringField(
  fields: ExtractedCandidateFields,
  key: string,
): ContactProposalField | null {
  const field = fields[key];
  if (!field || isEmptyExtractedField(field)) return null;
  if (typeof field.value !== "string") return null;
  const value = field.value.trim();
  if (value.length === 0) return null;
  return { value, confidence: field.confidence === "high" ? "high" : "low" };
}

/**
 * The contact details this candidate is missing that their CV extraction can supply.
 *
 * Three gates, each mirroring one that cv-auto-apply already applies for the unattended path:
 *
 *   1. `isCv === false` — the read judged this document not to be a CV, so its "contact details"
 *      are a vendor's, a clinic's letterhead, or a training certificate's. Gate on the EXPLICIT
 *      false and never on `!isCv`: NULL means nobody judged it (every row written before
 *      2026-08-21, plus every ongoing rules-only or OCR read), and treating unknown as a no would
 *      discard real applicants.
 *   2. the column is currently BLANK — this only ever fills gaps. A value a human typed, or one an
 *      earlier extraction already applied, always wins. That is what makes the proposal safe to
 *      recompute on every read without ever threatening existing data.
 *   3. the value is ONE address / ONE diallable number — the only gate that judges the value
 *      rather than its provenance, because a two-address contact line is transcribed correctly, at
 *      high confidence, into a column that is legitimately blank.
 *
 * Confidence is carried, not gated on, because a human is the gate here: a "low" proposal is worth
 * showing to someone who can open the CV and check it. Bulk acceptance is what restricts itself to
 * high — see bulkAcceptableProposal.
 */
export function proposeContactDetails(input: {
  candidate: { email?: string | null; phone?: string | null };
  fields: ExtractedCandidateFields | null | undefined;
  isCv: boolean | null | undefined;
}): ContactProposal {
  const empty: ContactProposal = { email: null, phone: null };
  if (input.isCv === false) return empty;
  if (!input.fields) return empty;

  const email = isBlankCandidateValue(input.candidate.email)
    ? readStringField(input.fields, "email")
    : null;
  const phone = isBlankCandidateValue(input.candidate.phone)
    ? readStringField(input.fields, "phone")
    : null;

  return {
    email: email && isSingleEmailAddress(email.value) ? email : null,
    phone: phone && isSingleDiallablePhone(phone.value) ? phone : null,
  };
}

/**
 * The subset of a proposal that "accept all" may take without anyone opening the CV.
 *
 * High confidence only. A low-confidence read is still shown on the row for a reviewer to accept
 * one at a time, which is the whole point of an attended path — it is not silently dropped.
 */
export function bulkAcceptableProposal(proposal: ContactProposal): ContactProposal {
  return {
    email: proposal.email?.confidence === "high" ? proposal.email : null,
    phone: proposal.phone?.confidence === "high" ? proposal.phone : null,
  };
}
