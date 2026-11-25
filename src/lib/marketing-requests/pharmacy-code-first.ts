/**
 * The code-first pharmacy card on Customer Validation (owner, 26 Nov 2026: "It must be easier").
 *
 * The rep starts a new pharmacy with its distributor and code. Two answers come back from that code
 * alone, before he types anything else:
 *  - a venue ALREADY ON FILE that holds the code, offered as "Use this pharmacy", which attaches it
 *    instead of capturing the shop a second time (the copy behind Dr Othman El Shewehy's four
 *    duplicated Damietta pharmacies, 25 Nov 2026);
 *  - the distributor's own record of the code (the reference suggestions), whose shop name fills
 *    the name box when he has not typed one.
 *
 * Pure and client-safe: the page and Save Validation's find-before-create share one match key, so
 * the card never offers a venue the save would not have attached, and the reverse.
 */

/**
 * The key two distributor codes are the SAME pharmacy under: the distributor, and the code with
 * spacing, case and leading zeros dropped — Overseas prints "0001513103" where a rep types
 * "1513103". A lone "0" stays "0".
 */
export function distributorCodeMatchKey(distributorId: unknown, code: unknown): string {
  const cleaned = String(code ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return `${Number(distributorId)}::${cleaned.replace(/^0+(?=.)/, "")}`;
}

type VenueWithCodes = {
  id: string;
  vendorCodes: Array<{ distributorId: number | string; distributorPharmacyCode: string }>;
};

/**
 * The one venue on file that holds this distributor code, or null. Null as well when the code is
 * blank, when no distributor is chosen, or when two venues on file hold it — two copies of a shop
 * are for the Super Admin to merge, never for the card to choose between.
 */
export function findVenueOnFileByCode<T extends VenueWithCodes>(
  venues: readonly T[],
  distributorId: unknown,
  code: unknown,
): T | null {
  if (!String(code ?? "").trim() || !Number(distributorId)) return null;
  const key = distributorCodeMatchKey(distributorId, code);
  const holders = venues.filter((venue) =>
    venue.vendorCodes.some((line) => distributorCodeMatchKey(line.distributorId, line.distributorPharmacyCode) === key));
  return holders.length === 1 ? holders[0] : null;
}

/**
 * The name box after the rep taps a distributor suggestion: the distributor's shop name when the box
 * is empty, and whatever he typed otherwise — a tap fills, it never overwrites.
 */
export function pharmacyNameAfterSuggestion(currentName: string, suggestionName: string | null | undefined): string {
  if (currentName.trim()) return currentName;
  return String(suggestionName ?? "").replace(/\s+/g, " ").trim();
}
