/**
 * What kind of venue a marketing record describes, and the one rule that follows from it.
 *
 * Phoenix registered every venue as a pharmacy until 2026-08-23. That was fine for hospitals — all
 * 11 active hospital venues carry real, resolving distributor codes, because hospitals buy
 * medicines — but wrong for nurseries, which have no distributor account at all. Since both link
 * tables demanded a `distributor_code_id`, the only way to register a nursery was to invent a code.
 * Three reached production (`0000`, `0001000000`, `0001511111`), and two of those were later
 * written into `source_of_sales_customer_map`, where a fabricated code resolves `exact` forever and
 * looks trustworthy to every later reader.
 *
 * So the venue type exists to answer exactly one question — does this venue have a distributor
 * account? — and everything else follows from `venueRequiresDistributorCode`. Keep that predicate
 * the single source of truth: re-deriving it inline (`type === "nursery"`) is what lets the next
 * venue type get added in one place and missed in five.
 */

export const VENUE_TYPES = ["pharmacy", "nursery"] as const;

export type VenueType = (typeof VENUE_TYPES)[number];

export const DEFAULT_VENUE_TYPE: VenueType = "pharmacy";

const VENUE_TYPE_LABELS: Record<VenueType, string> = {
  nursery: "Nursery",
  pharmacy: "Pharmacy",
};

/** Human-readable name. Never show the raw token in UI — the owner's standing rule. */
export function venueTypeLabel(venueType: VenueType): string {
  return VENUE_TYPE_LABELS[venueType];
}

/**
 * Narrow unknown input to a venue type, falling back to `pharmacy`.
 *
 * Deliberately forgiving rather than throwing: every row written before this column existed reads
 * back as NULL, and an offline client replaying an old draft sends nothing at all. Both mean
 * "pharmacy", which is what they were.
 */
export function normalizeVenueType(value: unknown): VenueType {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (VENUE_TYPES as readonly string[]).includes(text)
    ? (text as VenueType)
    : DEFAULT_VENUE_TYPE;
}

/**
 * A venue type nobody has answered yet.
 *
 * `DEFAULT_VENUE_TYPE` is the right reading for a row written BEFORE this column existed — it says
 * "that was a pharmacy, because everything was". It is the wrong reading for a venue being
 * registered NOW, and the difference is not academic. The picker shipped on 2026-08-23 at 10:09
 * Cairo already pre-selected `Pharmacy`; `حضانه النيل` was registered as a pharmacy at 15:31 the
 * same day, five hours later, and sat mistyped until the owner spotted it three days on. The
 * question was on screen and answered in advance, which is the same as not asking.
 *
 * So capture uses `VenueTypeChoice` and starts at `null`, reads keep `normalizeVenueType`.
 */
export type VenueTypeChoice = VenueType | null;

/** One sentence, so all three capture points refuse in the same words. */
export const VENUE_TYPE_UNANSWERED_MESSAGE = "Say what this venue is — pharmacy or nursery — before saving it.";

export function venueTypeIsAnswered(choice: VenueTypeChoice): choice is VenueType {
  return choice !== null;
}

/**
 * Read a venue type that the capturer was supposed to answer.
 *
 * Unlike `normalizeVenueType`, absent is NOT "pharmacy" here — it is unanswered, and every caller
 * refuses. Registration is the one moment the answer is cheap, and the only moment it is asked.
 */
export function parseVenueTypeChoice(value: unknown): VenueTypeChoice {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (VENUE_TYPES as readonly string[]).includes(text) ? (text as VenueType) : null;
}

/** Label for a choice that may be unanswered. Never renders a blank or a raw token. */
export function venueTypeChoiceLabel(choice: VenueTypeChoice): string {
  return venueTypeIsAnswered(choice) ? venueTypeLabel(choice) : "Venue";
}

/**
 * Whether this venue must carry at least one distributor code.
 *
 * The whole point of the feature. A pharmacy without a code cannot attribute a sale and has always
 * been refused at capture; a nursery without one is simply correct.
 */
export function venueRequiresDistributorCode(venueType: VenueType): boolean {
  return venueType === "pharmacy";
}

/**
 * `venueRequiresDistributorCode` over a choice that may be unanswered.
 *
 * Unknown is not "yes". Demanding a distributor code before the capturer has said what the venue is
 * asks a nursery for a code it can never have — which is precisely how the invented codes got made.
 * Every capture-side call goes through this rather than re-deriving the null check inline.
 */
export function choiceRequiresDistributorCode(choice: VenueTypeChoice): boolean {
  return venueTypeIsAnswered(choice) && venueRequiresDistributorCode(choice);
}

/**
 * Whether sales can ever attribute to this venue.
 *
 * A nursery has no distributor account, so no invoice line can ever carry its code. ROI must say
 * "no sales channel" rather than report a zero return — a zero reads as "we spent and got nothing",
 * which is a different and much more damning claim than "this venue cannot be measured this way".
 */
export function venueCanAttributeSales(venueType: VenueType): boolean {
  return venueType === "pharmacy";
}

/** Why a venue's ROI is unmeasurable, or null when it is measurable. */
export function venueNonAttributableReason(venueType: VenueType): string | null {
  if (venueCanAttributeSales(venueType)) return null;
  return `${venueTypeLabel(venueType)} — no distributor account, so sales cannot be attributed.`;
}

