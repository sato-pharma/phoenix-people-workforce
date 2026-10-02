/**
 * What a vacant seat says when a letter is already out against it — the type and the wording,
 * with no database anywhere near them.
 *
 * ── Why its own file ──
 * The organogram chart is a client component, and `src/lib/offers/seat-offers.ts` — where these
 * are READ — reaches the service-role Supabase client. Importing the label from there would drag
 * that into the browser bundle. Same split, same reason, as `vacancy-label.ts` next door.
 */

export type SeatOfferOut = {
  candidateName: string;
  /**
   * The offer row's own id. Carried so the chart's one-press hire can hand an ACCEPTED offer
   * straight to the Add Employee form's offer prefill (`?fromOffer=<id>`), which fills the
   * candidate's name, the agreed net salary and generates the Employee ID. Without it the hire
   * link falls back to the seat-only prefill, which leaves name and id blank — and the form then
   * refuses to save with "Employee ID / Full Name is required", before anything is ever sent.
   */
  offerId: string;
  reference: string | null;
  /** "sent" — awaiting an answer. "accepted" — agreed, not yet hired. */
  status: "accepted" | "sent";
  /** As the letter prints it ("01 October 2026"), because that is what the offer row stores. */
  startDate: string | null;
};

/**
 * `Offer out — Norhan Gamal, starts 01 October 2026`, or `Offer accepted — …` once the candidate
 * has said yes.
 *
 * The two headings are not decoration: "out" is a chair that may yet come back, "accepted" is one
 * that is spoken for and only waiting on HR. Planning a line off the chart, those are different
 * facts.
 *
 * No ellipsis anywhere — the owner's standing rule is that text is never cut off, so a long name
 * wraps inside the node instead.
 */
export function formatSeatOfferOut(offer: SeatOfferOut): string {
  const head = offer.status === "accepted" ? "Offer accepted" : "Offer out";
  const tail = offer.startDate ? `, starts ${offer.startDate}` : "";
  return `${head} — ${offer.candidateName}${tail}`;
}

/**
 * The map key for a Head Office vacancy, which is drawn straight from `position_vacancies` and has
 * no AU seat id of its own. Pure, and here rather than beside the reader, because
 * `organogram-head-office.ts` is deliberately database-free so its placement rules stay
 * unit-testable — importing this from the reader would have pulled the service-role client into it.
 */
export function offerSeatKeyForVacancy(vacancyId: number): string {
  return `vacancy:${vacancyId}`;
}
