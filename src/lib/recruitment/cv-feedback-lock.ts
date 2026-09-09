// Recruitment / ATS — a manager who opens a CV owes his feedback on it before he opens another.
//
// ── THE PROBLEM THIS EXISTS FOR, IN THE OWNER'S OWN WORDS ───────────────────────────────────────
//
// 2026-09-09: *"CVs are forwarded automatically to maybe more than one district manager. So what is
// happening now is a clash. We call some candidates, they tell us someone other from Sato Pharma
// also called us — because there is no any note that this candidate has anyone from the company
// called him. To be honest, it will be hard to convince the managers to only work the recruitment
// through the system, but they may view the recruitment through the system. So I want anything that
// tells, for this CV, if did anyone call him and did anyone not. And if you make it optional,
// normally no one will put his feedback, and it will keep clashing. So I'm trying to make them put
// their feedback by force. This is why I make the phone number not appear, and I want to make the
// comment to be able to proceed with more CVs."*
//
// So the target is NOT tidiness. It is a candidate being telephoned twice by the same company, which
// the candidate then says out loud to the second caller. Three things work together on that:
//
//   1. the phone number is hidden until a manager takes the CV, so a call cannot start by accident;
//   2. "I will call" reserves the candidate and shows his name to every other manager;
//   3. THIS — after he has opened a CV he must write what he found, before he may open another.
//
// The third is what turns the first two into a record. A reservation says somebody INTENDS to call;
// only the feedback says whether the call happened and what came of it, and that is the sentence the
// next manager needs before he picks up the phone.
//
// ── WHY IT HAS TO BE A LOCK AND NOT A PROMPT ────────────────────────────────────────────────────
//
// The owner's own reasoning, and the measurement agrees with him. On 2026-09-09 production held 331
// recorded CV opens by 13 people, and 325 of them carried no comment from the person who opened it.
// An optional box is a box nobody fills in. The lock is the whole feature; softening it to a nudge
// returns the system to exactly the state that produced the clash.
//
// ── AND WHY IT LOOKS ONLY FORWARD ───────────────────────────────────────────────────────────────
//
// Those same 325 opens are the reason `FEEDBACK_REQUIRED_FROM` exists. Counting history would have
// locked all 13 managers out on the first page load, each owing feedback on dozens of CVs he read
// weeks ago, and the feature would have been switched off within the hour. An obligation is created
// only by an open that happens after this ships.
//
// PURE. No database, no React. The server refuses the file and the card explains the refusal, and
// both ask this module, so the rule and the wording cannot drift apart.

import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * Opens before this instant never create an obligation.
 *
 * READ OFF THE DATA, not guessed. Measured on production 2026-09-09: `ats_candidate_views` held 331
 * opens, the most recent at 15:04:54 UTC, and none after 15:50. So this sits after the entire
 * historical backlog and before the deploy — which excludes all 331 while leaving the lock live from
 * the moment it ships.
 *
 * A ROUND FUTURE HOUR WOULD HAVE BEEN WORSE THAN ARBITRARY. The first version of this was set to a
 * time that had not happened yet, which left the feature dormant until that hour and untestable
 * before it — a lock nobody could exercise reads exactly like a lock that does not work.
 *
 * A constant rather than a lookup, because "was this open made under the rule" has one answer for
 * the whole company forever. A per-manager start date would let a manager reset his own obligation
 * by arriving late.
 */
export const FEEDBACK_REQUIRED_FROM = "2026-09-09T15:50:00.000Z";

/** True when an open made at this time falls under the rule. */
export function openIsUnderTheRule(openedAt: string | null | undefined): boolean {
  const at = String(openedAt ?? "").trim();
  if (!at) return false;
  const when = Date.parse(at);
  if (Number.isNaN(when)) return false;
  return when >= Date.parse(FEEDBACK_REQUIRED_FROM);
}

/** The CV a manager has opened and not yet written about. */
export type OutstandingFeedback = {
  candidateId: string;
  /** For the message, so it names a person rather than an id. */
  candidateName: string | null;
  openedAt: string;
};

/**
 * WHAT COUNTS AS THE FEEDBACK HE OWES.
 *
 * A comment on the CV, or the reason he types when he skips it. Both are him writing what he thinks,
 * which is the whole object of the exercise, and the skip reason is already required today — so a
 * manager who skips a CV clears his obligation in the one action he was going to take anyway.
 *
 * Pressing "I will call" deliberately does NOT clear it. That records an intention, and the sentence
 * the next manager needs is what happened when the call was made. Letting the reservation satisfy
 * the rule would leave exactly the empty record the owner is trying to end.
 */
export type FeedbackSatisfaction = {
  /** He has written a comment on this candidate. */
  commented: boolean;
  /** He answered with a note — the reason Skip requires. */
  answeredWithNote: boolean;
};

export function feedbackIsGiven(satisfaction: FeedbackSatisfaction): boolean {
  return satisfaction.commented || satisfaction.answeredWithNote;
}

/**
 * Why this manager may not open THIS CV yet, or null when he may.
 *
 * Returns null when the CV he owes feedback on IS the one he is asking for — reopening the CV he is
 * being asked to write about must always work, or the lock would trap him behind a document he
 * cannot re-read. That single line is what makes the block escapable, and it is easy to leave out.
 */
export function cvOpenRefusal(
  outstanding: OutstandingFeedback | null,
  candidateId: string,
): string | null {
  if (!outstanding) return null;
  if (String(outstanding.candidateId) === String(candidateId ?? "")) return null;
  return feedbackBlockMessage(outstanding);
}

/**
 * The sentence the manager reads, in the owner's own words.
 *
 * He dictated it on 2026-09-09: *"show them message to be able to open this CV or any other you must
 * put your feedback to the ones you opened before."* Kept as given rather than improved on — it
 * states the condition and the remedy in one line, which is everything a blocked manager needs.
 *
 * The candidate is NAMED after it. Only one CV can be outstanding at a time, so "the ones you opened
 * before" resolves to exactly one person, and saying which turns a rule into an errand he can
 * finish. Without the name he has to go and work out which CV the system means.
 */
export function feedbackBlockMessage(outstanding: OutstandingFeedback): string {
  const who = String(outstanding.candidateName ?? "").trim();
  const opener = "To open this CV or any other, you must put your feedback on the ones you opened before.";
  return who ? `${opener} Start with ${who}.` : opener;
}

/** Whether this viewer is the one who owes the feedback. Used only to keep the message honest. */
export function ownsOutstanding(
  outstanding: OutstandingFeedback | null,
  viewerHrId: string | null | undefined,
  ownerHrId: string | null | undefined,
): boolean {
  if (!outstanding) return false;
  const viewer = canonicalHrIdKey(viewerHrId);
  return Boolean(viewer) && viewer === canonicalHrIdKey(ownerHrId);
}
