import type { OfferRecord, OfferStatus } from "@/lib/offers/types";

/**
 * Finding one offer in the Offers list (owner, 2026-11-10: "premium polish the page … ease and
 * perfection"). With 86 offers the list was one unbroken column of cards about 21,000px tall and no way
 * to find a name but scrolling. Now: a search, a status filter with its counts, and the list in pages.
 *
 * Pure, so the screen and the test share it. It only narrows what is shown — every offer is still
 * loaded, and nothing is decided from it.
 */

/** How many offers the list shows at first, and how many each "Show more" adds. */
export const OFFER_LIST_PAGE = 20;

/** The filter's order: what needs somebody first, then the answers, then the drafts. */
export const OFFER_LIST_STATUSES: readonly OfferStatus[] = [
  "pending_approval",
  "sent",
  "accepted",
  "declined",
  "withdrawn",
  "draft",
];

export type OfferListFilter = { query: string; status: OfferStatus | "all" };

type Searchable = Pick<OfferRecord, "candidateEmail" | "candidateName" | "reference" | "status" | "title">;

/** Lower case, accents and extra spaces folded, so "SAMAA  shalaby" finds "Samaa Shalaby". */
function fold(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The offers that match, in the order given (the list is newest first). Every word typed must appear
 * somewhere in the candidate's name, email, job title or reference.
 */
export function filterOffers<T extends Searchable>(offers: readonly T[], filter: OfferListFilter): T[] {
  const words = fold(filter.query).split(" ").filter(Boolean);
  return offers.filter((offer) => {
    if (filter.status !== "all" && offer.status !== filter.status) return false;
    if (words.length === 0) return true;
    const haystack = fold([offer.candidateName, offer.candidateEmail, offer.title, offer.reference].join(" "));
    return words.every((word) => haystack.includes(word));
  });
}

/** How many offers each status holds, for the filter's counts. Every status is present, zero included. */
export function offerStatusCounts(offers: readonly Pick<OfferRecord, "status">[]): Record<OfferStatus | "all", number> {
  const counts = { all: offers.length } as Record<OfferStatus | "all", number>;
  for (const status of OFFER_LIST_STATUSES) counts[status] = 0;
  for (const offer of offers) counts[offer.status] = (counts[offer.status] ?? 0) + 1;
  return counts;
}
