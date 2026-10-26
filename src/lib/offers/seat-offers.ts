import { offerLetterLapsed, todayInCairo } from "@/lib/offers/dates";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { offerSeatKeyForVacancy, type SeatOfferOut } from "@/lib/offers/seat-offer-label";

// Re-exported so a server caller needs one import; the pure half lives apart because the chart is
// a client component. See seat-offer-label.ts.
export { formatSeatOfferOut, offerSeatKeyForVacancy, type SeatOfferOut } from "@/lib/offers/seat-offer-label";

/**
 * Which empty chairs already have a letter out against them.
 *
 * ── Why the organogram needs this ──
 * A vacant seat on the chart reads the same whether HR has never looked at it or a signed offer is
 * sitting in somebody's inbox with a start date next Thursday. Measured on production 2026-09-29:
 * 4 of the 43 open seats were already spoken for and looked identical to the other 39. Planning a
 * line off that chart means re-hiring a chair that is taken, or chasing one that is handled.
 *
 * ── Only SENT and ACCEPTED ──
 * Those are the two states where a letter is in play. A draft has not been asked; a declined or
 * withdrawn one is over, and showing either on a seat would say the chair is spoken for when it is
 * free — the worse of the two mistakes, because it stops somebody hiring.
 *
 * ── A SENT letter past its "valid until" day is over too ──
 * Nobody answered it in time, so the chair is free again — but the row still says "sent", because
 * nothing moves a letter on when its deadline passes. Measured on production 2026-10-26: two
 * duplicate letters to Bassant Samir Mousa, valid until 21 October, kept the Giza chair under
 * Dr. Ali Mohamed reading "Offer out … starts 25 October 2026" after her candidate record had been
 * rejected. So a sent letter is drawn only through its valid-until day (Cairo). An ACCEPTED letter
 * is always drawn — the candidate said yes, and only the hire closes it. The accept link opens for
 * OFFER_ACCEPT_GRACE_DAYS after that day; a late acceptance turns the letter accepted and it comes
 * back on the seat by itself.
 *
 * ── The seat is read through the vacancy, never matched by name ──
 * `offers.vacancy_id` points at `position_vacancies`, whose `seat_id` is the organogram's own seat
 * key (41 of the 43 open rows carry one). So the chain is exact: offer → vacancy → seat. No
 * territory text is compared to an area name anywhere in it, which is the guess the whole feature
 * refuses to make.
 *
 * ── It never claims the seat is filled ──
 * This is a LABEL on a vacancy, not a change of state. The seat stays vacant and open, the hire is
 * still what closes it, and the organogram skeleton is untouched.
 */

type OfferRow = {
  id: string | null;
  candidate_name: string | null;
  reference: string | null;
  start_date: string | null;
  status: string | null;
  valid_until: string | null;
  vacancy_id: number | string | null;
};

/**
 * Seat id → the offer out against it.
 *
 * Keyed by BOTH the organogram's `seat_id` and the vacancy's own numeric id, because the chart
 * draws its two kinds of vacancy from two different places: a sales seat comes from the AU seat
 * model and is found by `seat_id`, while a Head Office vacancy is drawn straight from
 * `position_vacancies` and only has its row id. One map, two keys, so neither caller has to know
 * about the other's shape.
 *
 * Returns an EMPTY map on any failure rather than throwing. This decorates a chart; an offers read
 * that fails must never be the reason the organogram will not draw.
 */
export async function loadOfferOutBySeat(): Promise<Map<string, SeatOfferOut>> {
  const out = new Map<string, SeatOfferOut>();

  try {
    const db = getSupabaseAdmin();

    const { data: offerRows, error: offerError } = await db
      .from("offers")
      .select("id, candidate_name, reference, start_date, status, valid_until, vacancy_id")
      .in("status", ["sent", "accepted"])
      .not("vacancy_id", "is", null);

    // A database without 20260929161030 applied has no `vacancy_id` at all, and that reads as
    // "nothing is spoken for" rather than as an error.
    if (offerError) return out;

    const today = todayInCairo();
    const offers = ((offerRows ?? []) as OfferRow[]).filter(
      (row) => row.status === "accepted" || !offerLetterLapsed(row.valid_until, today),
    );
    if (offers.length === 0) return out;

    const vacancyIds = Array.from(
      new Set(
        offers
          .map((row) => Number(row.vacancy_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    if (vacancyIds.length === 0) return out;

    const { data: vacancyRows, error: vacancyError } = await db
      .from("position_vacancies")
      .select("id, seat_id, status")
      .in("id", vacancyIds);
    if (vacancyError) return out;

    const seatByVacancy = new Map<number, string | null>();
    for (const row of (vacancyRows ?? []) as { id: number; seat_id: string | null; status: string | null }[]) {
      // A vacancy that is no longer open has been filled, and a filled chair is not drawn as a
      // vacancy at all — so an offer still pointing at it has nothing to label.
      if (row.status !== "open") continue;
      seatByVacancy.set(Number(row.id), row.seat_id);
    }

    for (const row of offers) {
      const vacancyId = Number(row.vacancy_id);
      if (!seatByVacancy.has(vacancyId)) continue;

      const summary: SeatOfferOut = {
        candidateName: String(row.candidate_name ?? "").trim(),
        // The id is what lets the chart's one-press hire open the offer prefill. It is always
        // present (a primary key), but kept defensive: an empty one simply means the hire link
        // falls back to the seat-only prefill rather than breaking the label.
        offerId: String(row.id ?? "").trim(),
        reference: row.reference?.trim() || null,
        startDate: row.start_date?.trim() || null,
        status: row.status === "accepted" ? "accepted" : "sent",
      };
      if (!summary.candidateName) continue;

      const seatId = seatByVacancy.get(vacancyId) ?? null;
      // ACCEPTED WINS over sent when two letters name one chair. That happens on purpose — a second
      // offer goes out while the first is still unanswered — and the agreed one is the fact worth
      // putting on the chart.
      const existing = seatId ? out.get(seatId) : undefined;
      const better = !existing || (existing.status === "sent" && summary.status === "accepted");

      if (seatId && better) out.set(seatId, summary);
      const vacancyKey = offerSeatKeyForVacancy(vacancyId);
      const existingByVacancy = out.get(vacancyKey);
      if (!existingByVacancy || (existingByVacancy.status === "sent" && summary.status === "accepted")) {
        out.set(vacancyKey, summary);
      }
    }
  } catch {
    return out;
  }

  return out;
}
