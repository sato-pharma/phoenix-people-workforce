// Recruitment / ATS — who is actually owed a rejection notice, and on which channel.
//
// ── THE MISTAKE THIS EXISTS TO PREVENT ──────────────────────────────────────────────────────────
//
// "97 candidates are rejected and have never been told" is true and is the wrong recipient list.
// Measured on production 2026-09-05:
//
//   * 65 of them were rejected by a BATCH — the actor on their status event is
//     `ops:non-egyptian-reject-20260828`, they carry no decision timestamp, and their phone numbers
//     are overwhelmingly non-Egyptian. Nobody read their CV. They are scattergun international
//     applications to a company that hires Egyptians.
//   * 1 carries a decision date with NO actor recorded at all — dated by nobody.
//   * 31 were read and decided by a person: 18 who applied by email, 13 on WhatsApp.
//
// The recipient list for this phase was very nearly 97, then very nearly 77. It is 31, and it is
// split across two channels.
//
// Emailing the first group would tell 59 mass-mailers that their message reached a real recruiter,
// invite replies, and read worse than silence. A rejection notice is a courtesy owed to somebody who
// was CONSIDERED. It is not owed to a filter's output, and sending one where no human ever looked
// makes a claim about our process that is not true.
//
// ── SO THE TEST IS "DID A PERSON DECIDE", NOT "IS THE STATUS REJECTED" ──────────────────────────
//
// Two signals together, because either alone is wrong. A decision timestamp with a batch actor is
// still a batch. A human actor with no timestamp is a row we cannot date, and a notice that says
// "following your recent application" about an unknown date is worse than none.
//
// ── AND THE CHANNEL FOLLOWS THE SOURCE ──────────────────────────────────────────────────────────
//
// A WhatsApp applicant who was personally turned down is owed the same courtesy — on WhatsApp,
// where the rest of their conversation happened. Emailing them opens a second thread for a
// conversation that is already running somewhere else. Excluding them entirely would be the easy
// mistake in the other direction: silence for the people we spoke to most.

/** How a candidate reached us, which is also how we should answer them. */
export type RejectionChannel = "email" | "whatsapp";

export type RejectionCandidate = {
  id: string;
  status: string | null;
  /** The source they arrived through. */
  source: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** When the status last moved. Null means nothing dated the decision. */
  statusChangedAt: string | null;
  /**
   * WHO MOVED IT TO `rejected`, taken from the STATUS EVENT — never from the candidate row.
   *
   * This distinction is the whole rule, and getting it from the wrong place silently disarms it.
   * Measured on production 2026-09-05: 65 candidates were rejected by the batch
   * `ops:non-egyptian-reject-20260828`, and every one of them has a NULL
   * `ats_candidates.status_changed_by_hr_id`. The batch marker exists ONLY on
   * `ats_candidate_status_events.actor_hr_id`.
   *
   * So a rule reading the candidate row sees null, falls through to the date check, and excludes
   * them only because that column is also null — by accident. The day a batch stamps a date, all 65
   * would be posted letters, and nothing in the rule would have changed to explain it.
   *
   * Read it as: the actor on the newest event whose `to_status` is `rejected`.
   */
  decidedByActor: string | null;
};

export type RejectionNoticePlan =
  | { owed: true; candidateId: string; channel: RejectionChannel; to: string }
  | { owed: false; candidateId: string; reason: RejectionSkipReason };

export type RejectionSkipReason =
  | "not_rejected"
  | "decided_by_a_batch"
  | "no_decision_date"
  | "no_named_decider"
  | "no_way_to_reach_them";

/**
 * The marker that says a status was moved by an operation rather than by a person.
 *
 * Production carries `ops:non-egyptian-reject-20260828` on 65 status events. The prefix is the
 * contract: anything before the colon names the operation, and nothing that looks like this is an
 * HR id. Matching the whole string instead would go stale the next time a batch runs under a new
 * name — and that batch's candidates would silently start receiving letters.
 */
export const BATCH_ACTOR_PREFIX = "ops:";

export function isBatchActor(actor: string | null | undefined): boolean {
  return String(actor ?? "").trim().toLowerCase().startsWith(BATCH_ACTOR_PREFIX);
}

/** Digits only, so a display format never decides whether somebody is reachable. */
function reachableNumber(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const digits = String(value ?? "").replace(/[^0-9]/g, "");
    if (digits.length >= 9) return String(value).trim();
  }
  return null;
}

function reachableEmail(value: string | null | undefined): string | null {
  const cleaned = String(value ?? "").trim();
  // Deliberately shallow. This decides whether to ATTEMPT a send, and the provider is the authority
  // on deliverability — production has 17 bounces across 23,139 events, which is what that job looks
  // like when it is working. A stricter pattern here would silently drop real addresses instead.
  return cleaned.includes("@") && !cleaned.includes(" ") ? cleaned : null;
}

/**
 * Is this candidate owed a rejection notice, and where would it go?
 *
 * Pure, so the rule can be tested without a database and without the risk of a test that sends.
 */
export function planRejectionNotice(candidate: RejectionCandidate): RejectionNoticePlan {
  const { id } = candidate;

  if (String(candidate.status ?? "").trim().toLowerCase() !== "rejected") {
    return { candidateId: id, owed: false, reason: "not_rejected" };
  }

  // A BATCH IS NOT A DECISION. Checked before the date, because a batch that happens to be dated is
  // still a batch — and that is the shape production actually holds.
  if (isBatchActor(candidate.decidedByActor)) {
    return { candidateId: id, owed: false, reason: "decided_by_a_batch" };
  }

  if (!candidate.statusChangedAt) {
    return { candidateId: id, owed: false, reason: "no_decision_date" };
  }

  // A DATE WITH NOBODY BEHIND IT IS NOT A DECISION EITHER. Production holds one such row. Writing to
  // somebody because a timestamp exists, when no actor was recorded, asserts that a person reviewed
  // them — and nothing in the record says who.
  if (!String(candidate.decidedByActor ?? "").trim()) {
    return { candidateId: id, owed: false, reason: "no_named_decider" };
  }

  // THE CHANNEL FOLLOWS THE SOURCE. Answering on the channel they used keeps one conversation in one
  // place; emailing a WhatsApp applicant opens a second thread for a conversation already running.
  const source = String(candidate.source ?? "").trim().toLowerCase();
  if (source === "whatsapp") {
    const number = reachableNumber(candidate.whatsapp, candidate.phone);
    return number
      ? { candidateId: id, channel: "whatsapp", owed: true, to: number }
      : { candidateId: id, owed: false, reason: "no_way_to_reach_them" };
  }

  const address = reachableEmail(candidate.email);
  return address
    ? { candidateId: id, channel: "email", owed: true, to: address }
    : { candidateId: id, owed: false, reason: "no_way_to_reach_them" };
}

/** The plan for a whole pool, so a caller cannot accidentally send to the ones it skipped. */
export function planRejectionNotices(
  candidates: readonly RejectionCandidate[],
): { owed: Extract<RejectionNoticePlan, { owed: true }>[]; skipped: Extract<RejectionNoticePlan, { owed: false }>[] } {
  const owed: Extract<RejectionNoticePlan, { owed: true }>[] = [];
  const skipped: Extract<RejectionNoticePlan, { owed: false }>[] = [];
  for (const candidate of candidates) {
    const plan = planRejectionNotice(candidate);
    if (plan.owed) owed.push(plan);
    else skipped.push(plan);
  }
  return { owed, skipped };
}
