import type { OfferVacancyOption } from "@/lib/offers/types";

/**
 * WHERE THE SEAT ON AN OFFER STANDS — open, closed, or not known (enterprise audit REC-034, 14 Nov 2026).
 *
 * The joining form, the hire draft and the Offers screen each ask "is the seat this offer names still
 * open?". They used to answer it by looking the seat up in a list that a failed read had emptied, so
 * "we could not read the seats" and "somebody filled the seat" came back as the same `null`:
 *  - the candidate was refused ("Your position is being confirmed") on a database hiccup;
 *  - HR was sent a high-priority "the seat is no longer open in the organogram", which was false;
 *  - a non-sales offer went through WITHOUT its seat, so the vacancy stayed open and the hire unseated.
 * The third answer, `unread`, keeps those apart. Pure, so the test reads it without a database.
 *
 * Measured on production 14 Nov 2026 before this change: the joining form reads only
 * `position_vacancies`, never the seat model (`au.occupancy_history`), and no open vacancy had its
 * predecessor's seat already taken — so the "two vacancy models disagree" case could not block an
 * acceptance. The failed read could.
 */
export type OfferVacancyCheck =
  | { status: "none" } // the offer names no seat
  | { status: "open"; vacancy: OfferVacancyOption }
  | { status: "closed" } // the seat was filled or closed since the letter was written
  | { status: "unread" }; // the open seats could not be read — NOT the same as closed

export type OpenVacancyRead = { ok: true; options: OfferVacancyOption[] } | { ok: false };

export function classifyOfferVacancy(vacancyId: number | null | undefined, read: OpenVacancyRead): OfferVacancyCheck {
  if (!vacancyId) return { status: "none" };
  if (!read.ok) return { status: "unread" };
  const vacancy = read.options.find((option) => option.vacancyId === vacancyId);
  return vacancy ? { status: "open", vacancy } : { status: "closed" };
}
