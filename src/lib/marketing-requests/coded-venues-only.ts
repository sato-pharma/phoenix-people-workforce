/**
 * MARKETING REQUESTS HOLD ONLY VENUES THAT CARRY A DISTRIBUTOR CODE (owner, 2026-10-21).
 *
 * His words: "in direct orders we can validate a nursery without a distributor code — any thing with
 * no distributor code never reach the marketing requests".
 *
 * So a nursery, and every other venue without a distributor code — a pharmacy saved on its licence
 * alone included — is validated in Direct Orders only. Marketing refuses it at every door: the
 * customer-validation capture (new venue and "My Pharmacies" reuse), the desk entry, the Customer
 * Pharmacy Mapping approve, the manual Transfer, the automatic carry-over and the request target
 * picker and its server-side draft guard. Each door refuses in THESE words, with THIS code, so a rep
 * meets one sentence wherever they hit it.
 *
 * This REPLACES three older rules: a nursery validated in marketing on location and photo alone;
 * a licence-only pharmacy saved held and released by a Super Admin or the CEO as a request target;
 * and a codeless (`no_distributor_account`) request target, "spend allowed, sales never matched".
 *
 * Direct Orders is untouched: its own forms still validate a nursery with no code.
 *
 * Pure on purpose — the capture form imports it too, so the server and the screen cannot drift.
 */

/** The stable error code every marketing door refuses a codeless venue with. */
export const VENUE_WITHOUT_DISTRIBUTOR_CODE = "venue_without_distributor_code" as const;

/** Where a codeless venue goes instead — said after every refusal, so the rep knows what to do. */
export const CODELESS_VENUES_GO_TO_DIRECT_ORDERS =
  "Venues without a distributor code (nurseries included) are validated in Direct Orders.";

/** The one refusal sentence, naming the venue when its name is known. */
export function venueWithoutDistributorCodeMessage(venueName?: string | null): string {
  const name = String(venueName ?? "").trim();
  const label = name ? `"${name}"` : "This venue";
  return `${label} has no distributor code, so it cannot be in a marketing request. ${CODELESS_VENUES_GO_TO_DIRECT_ORDERS}`;
}

/**
 * Whether a venue may be in Marketing at all: only a pharmacy, and only with a distributor code.
 *
 * `requiresDistributorCode` is `venueRequiresDistributorCode(venueType)` — passed in rather than
 * recomputed, so the venue-type module stays the one place that knows which types have an account.
 */
export function marketingAcceptsVenue(input: { distributorCodeCount: number; requiresDistributorCode: boolean }): boolean {
  return input.requiresDistributorCode && input.distributorCodeCount > 0;
}
