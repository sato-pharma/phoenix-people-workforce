import { todayInCairo, toLetterDate } from "@/lib/offers/dates";
import { formatCount, formatList } from "@/lib/reconciliation/compare";
import {
  findOverdueAcceptedOffers,
  type AcceptedOfferForHireCheck,
} from "@/lib/reconciliation/overdue-accepted-offers";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type AcceptedOfferRow = {
  id: string;
  candidate_name: string | null;
  territory: string | null;
  title: string | null;
  start_date: string | null;
  vacancy_id: number | string | null;
};

type OpenVacancyRow = { id: number | string };

/**
 * Check — every accepted offer whose start date has passed has been turned into a hire.
 *
 * The two sides:
 *   left  — the offers module: accepted offers whose start date is already in the past. The Offers
 *           screen shows each of these as "Offer accepted — <name>, starts <date>".
 *   right — the organogram's own seats: `position_vacancies` for those offers, still `open`.
 *
 * It breaches when an accepted, overdue offer's seat is still empty — i.e. the person the company
 * agreed to hire, on a day that has passed, is not in. Nothing else in the system compares these:
 * accepting an offer and adding the employee are two separate, manual steps with no automation
 * between them, so a dropped hire stays invisible until someone notices the empty chair by eye.
 *
 * `expectation: "holds"`. This is NOT a documented known-open: an overdue accepted offer is a gap
 * to be CLOSED (add the person, or withdraw the offer), so the check should page until it is, then
 * fall quiet. It is false-positive-proof by construction — it reads the seat's own filled/open
 * state, never a name — so a breach always names a real empty chair with an accepted offer behind
 * it. See overdue-accepted-offers.ts for why the vacancy, not a name match, is the signal, and for
 * the one-day grace that keeps a same-day hire from paging.
 */
const acceptedOfferMustProduceAHire: ReconciliationCheck = {
  id: "accepted-offer-overdue-with-seat-still-open",
  title: "Every accepted offer whose start date has passed has been turned into a hire",
  domain: "recruitment",
  severity: "high",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const supabase = getSupabaseAdmin();

    const [offersRead, openVacanciesRead] = await Promise.all([
      supabase
        .from("offers")
        .select("id,candidate_name,territory,title,start_date,vacancy_id")
        .eq("status", "accepted")
        .not("vacancy_id", "is", null),
      // Read the open seats directly rather than through loadOfferVacancyOptions(), which swallows a
      // failed read and returns [] — here that would make every seat look filled and report green on
      // the one night the vacancy read is broken. A thrown read becomes an "errored" result instead,
      // which the harness treats as an alert, never as a pass.
      supabase.from("position_vacancies").select("id").eq("status", "open"),
    ]);

    if (offersRead.error) throw new Error(`Accepted-offer read failed: ${offersRead.error.message}`);
    if (openVacanciesRead.error) throw new Error(`Open-vacancy read failed: ${openVacanciesRead.error.message}`);

    const offers: AcceptedOfferForHireCheck[] = ((offersRead.data ?? []) as AcceptedOfferRow[]).map((row) => ({
      id: String(row.id),
      candidateName: String(row.candidate_name ?? "").trim() || "(unnamed candidate)",
      territory: row.territory?.trim() || null,
      title: row.title?.trim() || null,
      startDate: row.start_date,
      vacancyId: row.vacancy_id == null ? null : Number(row.vacancy_id),
    }));

    const openVacancyIds = new Set(
      ((openVacanciesRead.data ?? []) as OpenVacancyRow[]).map((row) => Number(row.id)).filter(Number.isFinite),
    );

    const today = todayInCairo();
    const overdue = findOverdueAcceptedOffers({ offers, openVacancyIds, today });
    const pastStart = offers.length;

    return {
      left: {
        source: 'offers where status = accepted with a seat pointer — "Offer accepted, starts <date>" on the Offers screen',
        value: `${formatCount(pastStart, "accepted offer")} linked to a seat`,
      },
      right: {
        source: "position_vacancies.status for those seats — the organogram's own record of which chairs are empty",
        value:
          overdue.length === 0
            ? "every overdue accepted offer's seat is filled"
            : `${formatCount(overdue.length, "seat")} still open past the start date`,
      },
      holds: overdue.length === 0,
      detail:
        overdue.length === 0
          ? "No accepted offer is past its start date with an empty seat — every hire the company agreed to has been added."
          : formatList(
              overdue.map(
                (offer) =>
                  `${offer.candidateName}${offer.title ? ` (${offer.title}${offer.territory ? `, ${offer.territory}` : ""})` : offer.territory ? ` (${offer.territory})` : ""} accepted, started ${toLetterDate(offer.startDateIso)} — ${formatCount(offer.daysOverdue, "day")} ago and still not added (seat empty)`,
              ),
            ),
    };
  },
};

export const recruitmentReconciliationChecks: ReconciliationCheck[] = [acceptedOfferMustProduceAHire];
