// Recruitment / ATS — how strictly one inbox is allowed to turn an attachment into a candidate.
//
// The two live mailboxes do NOT receive the same mail, and treating them the same is what put
// insurance circulars and our own job offers in the candidate pool. Measured in production on
// 2026-08-15, over every candidate either inbox has ever produced:
//
//   inbox      candidates   AI never ran   read thin   read clean
//   careers          131              3           6          122
//   hr                91             48          20           23
//
// Then read what those thin reads ACTUALLY were, one by one:
//
//   • careers — all 6 are real applicants ("APPLICATION FOR EMPLOYMENT AS NATIONAL SALES MANAGER",
//     "Sales cv") whose CV simply failed to read. Holding those back would lose the applicant.
//   • hr — all 20 are not CVs at all: "Medical Insurane & Life Protection Benefits 2025/2026" (an
//     insurance circular), "Certificate of Attendance - Pharmacy Promotion & OTC Campaign" (the
//     same internal certificate SEVEN times, which made one colleague a candidate seven times),
//     "طلب إجازة وضع" (a maternity-leave request), "Re: Interview Confirmation – Sato Pharma" and
//     "Job Offer from Sato Pharma – Regional Sales Manager" (our own mail coming back), and a
//     training vendor's pitch deck under four different subjects.
//
// So the same signal means opposite things in the two inboxes: on the address printed on our job
// ads, a thin read means WE failed to read a CV; on the general HR address, it means the file was
// never a CV. That is the whole reason the gate is per-inbox and not global.
//
// Pure and side-effect free (no I/O, no env read) so the policy can be unit-tested directly; the
// env-backed lookup lives in email-mailboxes-config.ts.

import { CORE_CV_SIGNAL_KEYS, isThinCvRead, type CvExtractionScore } from "@/lib/recruitment/cv-extraction-quality";

/**
 * "permissive" — today's behaviour everywhere: only a confident "this is not a CV" from the model
 * suppresses a candidate, and anything else becomes one. Correct for an address whose entire
 * purpose is receiving applications.
 *
 * "strict" — additionally holds back a file the model DID read and which does not read like a CV.
 * Correct for a general mailbox that receives everything the company receives.
 */
export type InboxCvGate = "permissive" | "strict";

/**
 * The inboxes published as application addresses. Everything sent here is meant to be an
 * application, so the benefit of the doubt goes to the applicant.
 *
 * Only "careers" today — matching the live RECRUITMENT_EMAIL_INBOXES_JSON, whose two labels are
 * "careers" and "hr". A mailbox added later defaults to strict, which is the safe direction: a
 * general company address is where non-CV mail lives. Override per mailbox with `"cvGate"` in that
 * same config entry when the default is wrong.
 */
export const PERMISSIVE_INBOX_LABELS: readonly string[] = ["careers"];

/** Narrows an arbitrary config value to a gate, or null when it says nothing usable. */
export function parseInboxCvGate(raw: unknown): InboxCvGate | null {
  if (raw === "strict" || raw === "permissive") return raw;
  return null;
}

/**
 * Which gate an inbox runs under. An explicit per-mailbox setting always wins; otherwise the
 * published application inboxes are permissive and everything else is strict.
 *
 * A null/absent label is WhatsApp, which has no mailbox — and a person who sends a document to a
 * recruitment WhatsApp number is applying, so it is permissive like careers.
 */
export function resolveInboxCvGate(
  mailboxLabel: string | null | undefined,
  configured?: InboxCvGate | null,
): InboxCvGate {
  if (configured) return configured;
  const label = (mailboxLabel ?? "").trim().toLowerCase();
  if (!label) return "permissive";
  return PERMISSIVE_INBOX_LABELS.includes(label) ? "permissive" : "strict";
}

/**
 * Does this inbox hold the file back?
 *
 * Only ever consulted for a read that ACTUALLY RAN — see the call site in cv-intake-service.ts. An
 * extraction that failed (an AI timeout, a rate limit) must always fail open, in every inbox: 48 of
 * the 91 candidates hr@ has produced are in exactly that state, and every one of them is a real
 * applicant whose CV the reader never got to. "The AI did not answer" is an outage, not evidence.
 */
export function strictGateHoldsBack(gate: InboxCvGate, score: CvExtractionScore): boolean {
  return gate === "strict" && isThinCvRead(score);
}

/**
 * Why it was held back, in the words Talent Acquisition reads on Inbound Intake Health — this is
 * written to the intake event's error_message, so nothing is ever silently dropped.
 *
 * Field names come from the extraction schema through `labelFor` rather than from a second list
 * here: a label that lived in two places would drift, and the owner's rule is that a screen shows
 * human-readable names, never raw keys.
 */
export function heldBackReason(
  mailboxLabel: string | null | undefined,
  score: CvExtractionScore,
  labelFor: (fieldKey: string) => string,
): string {
  const inbox = (mailboxLabel ?? "").trim() || "this";
  const missing = score.missingCore.map((key) => labelFor(key).toLowerCase());
  const missingText = missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
  return (
    `Held back by the stricter check on the ${inbox} inbox — the file was read but does not look ` +
    `like a CV (${score.coreFilled} of ${CORE_CV_SIGNAL_KEYS.length} core details found).${missingText}`
  );
}
