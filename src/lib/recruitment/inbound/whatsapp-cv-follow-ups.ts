// Recruitment / ATS — what the intake worker does AFTER a WhatsApp CV has been read.
//
// Four follow-ups run once ingestInboundCv has answered: clearing the sender's buffered texts,
// applying classification answers they finished before the worker ran, mirroring the new applicant to
// the owner's Telegram, and acknowledging the CV on WhatsApp. Each was gated inline in the worker on
// the sender's phone number, which was always present until a username sender's CV became
// processable (owner decision, 15 Sep 2026).
//
// A sender with no phone number gets the CV processed and the owner's mirror, and nothing else:
//
//   * no acknowledgement. Sending to a BSUID needs Meta's `recipient` field rather than `to`, and the
//     owner decided the same day that a username sender keeps receiving nothing.
//   * no answers and no buffer. Both are keyed on the phone number, and a sender with none was never
//     asked a question in the first place.
//
// Pure, so every gate is assertable with no database and no Meta.

import type { InboundCvIntakeOutcome } from "@/lib/recruitment/inbound/cv-intake-service";

export type WhatsAppCvFollowUps = {
  /** Send the CV acknowledgement (still behind its own kill switch in the worker). */
  acknowledge: boolean;
  /** Write classification and extra-question answers onto the candidate. */
  applyAnswers: boolean;
  /** Drop the sender's buffered texts so a later CV does not inherit them. */
  clearBuffer: boolean;
  /** Show the owner the new applicant on Telegram. */
  mirrorToOwner: boolean;
};

export function decideWhatsAppCvFollowUps(input: {
  /** False for a WhatsApp username sender who shared no phone number. */
  hasPhone: boolean;
  /** A configured bulk-import handset: a forwarder, never the applicant. */
  isImport: boolean;
  /** A coexistence history replay. */
  historical: boolean;
  outcome: InboundCvIntakeOutcome;
}): WhatsAppCvFollowUps {
  const direct = !input.isImport;
  const onCandidate = input.outcome === "candidate_created" || input.outcome === "candidate_matched";
  // A genuinely new, live applicant. A match already applied, and a replay would reach months of past
  // senders at once the moment the handset is linked.
  const newLiveApplicant = direct && !input.historical && input.outcome === "candidate_created";

  return {
    acknowledge: newLiveApplicant && input.hasPhone,
    applyAnswers: direct && onCandidate && input.hasPhone,
    clearBuffer: direct && onCandidate && input.hasPhone,
    mirrorToOwner: newLiveApplicant,
  };
}
