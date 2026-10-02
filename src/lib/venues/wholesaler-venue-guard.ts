/**
 * A wholesaler / makhzan is NEVER shown as a candidate and NEVER validated as a venue.
 *
 * OWNER RULE, 2026-09-22 (emphatic — "never never never"): in BOTH the direct-order and the
 * marketing-request validation flows, a wholesaler / makhzan (a distributor's own warehouse) must
 * never be offered as a matchable candidate and never accepted or validated as a venue. A warehouse
 * is not an end customer; validating one mis-credits its sales to a warehouse instead of the shop
 * that sold the medicine.
 *
 * HOW A WHOLESALER IS IDENTIFIED. There is no wholesaler flag anywhere in the data — venue types are
 * only `pharmacy` / `nursery` (venue-type.ts) and no reference table carries a customer-type column.
 * The monthly closing already answers "is this customer a wholesaler" by NAME, in
 * `src/lib/sales/customer-channel.ts` (`isStoreCustomer`), and this guard reuses that module's
 * primitives so the two can never disagree and so every owner pharmacy-override (مخزن الطرشوبى is a
 * real pharmacy, عابدين فارما is a chain…) applies here automatically.
 *
 * TWO TIERS, owner decision 2026-09-22 (asked in chat, "block certain, flag فارما"):
 *
 *   · HARD-BLOCK — the unmistakable warehouses: مخزن (makhzan), جملة (wholesale), the EPDA «م - »
 *     warehouse prefix, the medicines trade phrase (لتجارة وتوزيع الأدوية…), El Qema's whole book
 *     (a wholesale-only distributor), the owner's named-wholesaler roster, and a code-keyed store
 *     ruling. These are removed from every picker AND refused at every write path.
 *
 *   · FLAG — the ambiguous store words on their own (فارم / تريد / الشركة / الجمعيه / للتجارة). A
 *     field venue branded "X فارما / Pharma" is often a real retail pharmacy, and the owner's
 *     standing rule is that a false positive must never SILENTLY refuse one. So these are NOT
 *     hard-blocked: `suspectedWholesalerFlag` surfaces a visible warning to the validator, who
 *     decides. The system flags, it never auto-rejects — the same rule the AI evidence check follows.
 *
 * WHY مخزن AND جملة LIVE HERE AND NOT IN customer-channel.ts. The closing's rule is calibrated on
 * distributor customer files and is deliberately conservative: it excludes bare جملة because
 * «ايه ام جروب الجمله» was ruled a pharmacy there, and it treats the plural مخازن as a GOVERNMENT
 * DEPOT (a "never a store" word), not a warehouse. This guard is about field-visited VENUES — a
 * different population — where a venue literally named «مخزن X» or «X جملة» is a warehouse. Adding
 * these here, above the shared primitives but never inside them, keeps the closing's numbers exactly
 * as they are while giving the venue desks the stronger rule the owner asked for. The government
 * plural مخازن stays a protector (via `matchedNeverStoreKeywords`), matched separately from the
 * singular مخزن.
 */

import {
  PHARMACY_OVERRIDE_CHAINS,
  PHARMACY_OVERRIDE_NAMES,
  STORE_OVERRIDE_NAMES,
  isPharmacyOverride,
  isStoreOverride,
  isWholesaleOnlyDistributor,
  matchedNeverStoreKeywords,
  matchedStoreKeywords,
  matchedStorePrefixes,
  matchesTradePhrase,
  nameMatchesAnyKeyword,
  normalizeCustomerName,
} from "@/lib/sales/customer-channel";

/** The singular warehouse word. The plural مخازن is a government depot and stays a protector. */
const MAKHZAN_STEM = normalizeCustomerName("مخزن");
/** Wholesale. Venue-only — deliberately NOT a keyword in the closing rule (see the header). */
const WHOLESALE_STEM = normalizeCustomerName("جملة");

/**
 * موزع — "distributor". FLAG tier only, and venue-only.
 *
 * Found 2026-10-02, when each rep's iReports360 pharmacies were imported into Phoenix CRM: of the
 * 1,930 pharmacies in those lists, NINE carry this word and every one is a distributor branch —
 * five Pharma Overseas and four Ibn Sina (Ashmoun, Berket El Sabaa, Shebin, Tanta). Five were
 * already flagged, but only because they happen to say فارما as well; the four Ibn Sina ones said
 * nothing the guard knew and reached the reps' pharmacy lists unmarked.
 *
 * FLAG, never block, for the reason the second tier exists at all: a shop could legitimately carry
 * the word, and the owner's standing rule is that a false positive must never silently refuse a
 * real pharmacy. Measured over all 1,930 before and after: the flagged set goes from 6 to 10 and
 * nothing else moves — 0 blocked either way, 1,924 clean becoming 1,920 — and every one of the ten
 * is a distributor branch.
 *
 * 🔴 VENUE-ONLY, like {@link WHOLESALE_STEM} above, and this one matters more: the closing's own
 * keyword list lives in `customer-channel.ts` and PRICES THE MONTHLY CLOSING. Adding a word there
 * would re-classify customers in months that are already published. It must never be moved.
 */
const DISTRIBUTOR_STEM = normalizeCustomerName("موزع");

/**
 * One message, so every capture point and desk refuses a wholesaler in the same words. Points to the
 * override path because the certain tier is intentionally narrow: if a genuine pharmacy is ever named
 * like a warehouse, the way through is an owner pharmacy-override (as مخزن الطرشوبى already has), not
 * a weaker rule.
 */
export const WHOLESALER_VENUE_REFUSED_MESSAGE =
  "This name reads as a wholesaler / makhzan (a distributor's warehouse), which is never validated " +
  "as a venue — a warehouse's sales belong to the distributor, not to a single customer. If this " +
  "genuinely is a pharmacy despite its name, it needs an owner pharmacy-override before it can be " +
  "validated.";

/**
 * Protected first, so a real pharmacy whose name happens to carry a warehouse word is never blocked.
 * These are exactly the owner's own pharmacy rulings from the closing, read through their exported
 * predicates: a code-keyed pharmacy override, a named single-company/chain pharmacy, or a
 * "never a store" word (صيدلية / مستشفى / the government depots مخازن·مستودع·هيئة / the سجل تجارى
 * paperwork note).
 */
function isPharmacyProtectedVenue(
  name: string | null | undefined,
  clientCode?: string | null,
): boolean {
  if (isPharmacyOverride(clientCode)) return true;
  if (nameMatchesAnyKeyword(name, PHARMACY_OVERRIDE_NAMES)) return true;
  if (nameMatchesAnyKeyword(name, PHARMACY_OVERRIDE_CHAINS)) return true;
  if (matchedNeverStoreKeywords(name).length > 0) return true;
  return false;
}

/**
 * TRUE when this venue is an unmistakable wholesaler and must be hard-blocked — dropped from every
 * candidate picker and refused at every validation write path.
 *
 * Precedence mirrors the closing's `isStoreCustomer`: the pharmacy protectors win first, then the
 * certain warehouse signals. Pass `clientCode` and `distributorCode` wherever they are to hand — both
 * are needed to honour a code-keyed owner ruling; omitting them silently falls back to the name-only
 * answer (still correct, just without the account-level overrides).
 */
export function isCertainWholesalerVenue(
  name: string | null | undefined,
  clientCode?: string | null,
  distributorCode?: string | null,
): boolean {
  if (isPharmacyProtectedVenue(name, clientCode)) return false;

  if (isStoreOverride(clientCode, distributorCode)) return true;
  if (nameMatchesAnyKeyword(name, STORE_OVERRIDE_NAMES)) return true;
  if (isWholesaleOnlyDistributor(distributorCode)) return true;
  if (matchesTradePhrase(name)) return true;
  if (matchedStorePrefixes(name).length > 0) return true;

  const normalized = normalizeCustomerName(name);
  if (normalized.includes(MAKHZAN_STEM) || normalized.includes(WHOLESALE_STEM)) return true;

  return false;
}

/**
 * TRUE when this venue carries an ambiguous store word (فارم / تريد / الشركة / الجمعيه / للتجارة) but
 * is NOT a certain wholesaler and NOT a protected pharmacy — i.e. it MIGHT be a warehouse and a human
 * should look. This never refuses anything; a caller renders it as a visible "suspected wholesaler"
 * warning on the validation desk, and the AI evidence check is the second detector for a warehouse a
 * name misses entirely.
 */
export function suspectedWholesalerFlag(
  name: string | null | undefined,
  clientCode?: string | null,
  distributorCode?: string | null,
): boolean {
  if (isCertainWholesalerVenue(name, clientCode, distributorCode)) return false;
  if (isPharmacyProtectedVenue(name, clientCode)) return false;
  // Any of the six store keywords present. مخزن-only names are already certain (blocked above), so
  // what reaches here is one of the ambiguous words on its own.
  if (matchedStoreKeywords(name).length > 0) return true;
  // And the venue-only distributor word, which the closing's list deliberately does not carry.
  return normalizeCustomerName(name).includes(DISTRIBUTOR_STEM);
}

/** One sentence for the desk when a venue is only SUSPECTED, or null when there is nothing to flag. */
export function suspectedWholesalerNote(
  name: string | null | undefined,
  clientCode?: string | null,
  distributorCode?: string | null,
): string | null {
  if (!suspectedWholesalerFlag(name, clientCode, distributorCode)) return null;
  return "This name could be a wholesaler rather than a pharmacy — check the storefront photo and the licence before validating it.";
}
