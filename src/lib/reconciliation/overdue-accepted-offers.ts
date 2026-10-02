import { daysBetween } from "@/lib/offers/dates";
import { offerHireDate } from "@/lib/offers/hire-draft";

/**
 * The accepted offers whose start date has already passed and whose seat is still empty.
 *
 * ── Why this check exists ──
 * Marking an offer "accepted" is a pure status write. Turning an accepted offer into a seated
 * employee is a MANUAL HR action (the Add Employee form, reached from the offer), and NOTHING in
 * the system does it on a schedule — there is no job that watches `offers.start_date` and onboards
 * anyone when it arrives. So an accepted offer dated "01 October" that produced no hire by the 2nd
 * is invisible: the offer reads "accepted, starts 1 October", the seat sits empty on the
 * organogram, and no screen puts the two together. This is the detector that does.
 *
 * ── Why the signal is the VACANCY, not a name match ──
 * An offer links to its seat through `offers.vacancy_id → position_vacancies`. When the person is
 * hired, the employee insert flips that vacancy to `filled` (and seats them in `au.occupancy_history`).
 * So "the vacancy is still open" is an exact, machine-checkable statement that the hire has not
 * happened — with no name or email matching, which is the part that cannot be trusted here: people
 * are entered under fuller legal names than the offer carries ("Taha Sheeba" → "Taha Sheeba
 * Alhammed"), so a name match reports real hires as missing. An offer written without a vacancy
 * pointer (the pre-2026-09-29 letter era) carries no seat to check and is deliberately skipped
 * rather than guessed at.
 *
 * ── The one-day grace ──
 * An offer is flagged only once its start date is STRICTLY BEFORE today (Cairo). A person whose
 * first day is today is not yet overdue — HR may still add them during the day — and flagging them
 * would page on every fresh hire. "Starts yesterday or earlier and still has no seat" cannot be
 * explained by a same-day lag, which is the owner's own bar: 1 October means in by 1 October.
 */

/** One accepted offer, as read from the `offers` table (its own fields, no candidate/ATS join). */
export type AcceptedOfferForHireCheck = {
  id: string;
  candidateName: string;
  territory: string | null;
  title: string | null;
  /** As the letter prints it ("01 October 2026"), or ISO on a few legacy rows. */
  startDate: string | null;
  /** The seat the offer points at; null for the pre-vacancy-pointer letter era. */
  vacancyId: number | null;
};

export type OverdueAcceptedOffer = {
  id: string;
  candidateName: string;
  territory: string | null;
  title: string | null;
  /** The parsed start date, ISO `yyyy-mm-dd`. */
  startDateIso: string;
  daysOverdue: number;
  vacancyId: number;
};

export function findOverdueAcceptedOffers(input: {
  offers: readonly AcceptedOfferForHireCheck[];
  /** The ids of vacancies that are still OPEN (seat empty). A filled seat is simply absent here. */
  openVacancyIds: ReadonlySet<number>;
  /** Today in Cairo, ISO `yyyy-mm-dd` — the zone every offer date is written in. */
  today: string;
}): OverdueAcceptedOffer[] {
  const { offers, openVacancyIds, today } = input;
  const overdue: OverdueAcceptedOffer[] = [];

  for (const offer of offers) {
    // No seat pointer → nothing to check against. Never fall back to a name match (see header).
    if (offer.vacancyId == null) continue;
    // The seat has been filled (it is not in the open set) → the hire happened. Done.
    if (!openVacancyIds.has(offer.vacancyId)) continue;

    // Read the date the same way the hire form does; an unreadable date is skipped, never guessed.
    const startDateIso = offerHireDate(offer.startDate);
    if (!startDateIso) continue;

    // today − start. Positive means the start date is in the past; >= 1 means it was yesterday or
    // earlier, which is the one-day grace (see header). daysBetween answers null on a bad date.
    const daysOverdue = daysBetween(startDateIso, today);
    if (daysOverdue == null || daysOverdue < 1) continue;

    overdue.push({
      id: offer.id,
      candidateName: offer.candidateName,
      territory: offer.territory,
      title: offer.title,
      startDateIso,
      daysOverdue,
      vacancyId: offer.vacancyId,
    });
  }

  // Most overdue first — the one that has waited longest is the one to act on first.
  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || a.candidateName.localeCompare(b.candidateName));
}
