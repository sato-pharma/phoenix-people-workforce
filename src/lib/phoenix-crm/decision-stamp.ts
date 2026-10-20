/**
 * Phoenix CRM — the one line that says who approved or refused a place check, and when.
 *
 * Owner, 2026-10-20: *"in check places I want every approval or refusal by Khaled Bedair to appear to
 * me — by Khaled Bedair and timestamp."* The SFE Manager decides on the company Place checks board
 * (2026-10-19), and the database has always recorded who and when (`decided_by_hr_id`, `decided_at`),
 * but only the Decided list drew it: a place that stays in use after an approval, and a customer sent
 * back by a refusal, showed the outcome and nobody's name.
 *
 * Pure, so the three lists that draw it (places in use, customers waiting to be captured again, the
 * customers seated in a building) say it in the same words. It is drawn on the COMPANY board only — a
 * district manager's board names nobody above him (owner, 2026-10-13), and the rep's own screens never
 * reach it (golden rule #1).
 */

export type DecisionVerb = "Approved" | "Refused";

/**
 * "Approved by Khaled Bedair · 19 Oct 2026, 14:43". The system's own approvals arrive as the name
 * "The system" and read "Approved by the system". Null when the row records neither a person nor a
 * time, so a decision predating the record draws nothing rather than an invented line.
 */
export function decisionStamp(verb: DecisionVerb, byName: string | null | undefined, atText: string | null | undefined): string | null {
  const who = typeof byName === "string" ? byName.trim() : "";
  const when = typeof atText === "string" ? atText.trim() : "";
  if (!who && !when) return null;
  const person = who === "The system" ? "the system" : who;
  const head = person ? `${verb} by ${person}` : verb;
  return when ? `${head} · ${when}` : head;
}
