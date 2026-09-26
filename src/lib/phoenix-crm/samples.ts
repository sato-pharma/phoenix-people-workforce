/**
 * Phoenix CRM — what the rep LEFT at the visit: free samples and promotional material.
 *
 * Owner, 2026-09-26, asked in his own words for "free medical samples, pens, block notes,
 * giveaways" — and that list is the whole of it.
 *
 * ## 🔴 A RECORD OF WHAT HE LEFT, NEVER A STOCK MOVEMENT
 *
 * There is no balance, no allocation, no "you have 12 left", and nothing anywhere subtracts. The
 * moment a number here is treated as inventory, two things follow that the owner did not ask for and
 * that Golden Rule #1 forbids: the rep has to be issued a quantity before he can work, and a mismatch
 * between what he was issued and what he reports becomes an accusation. This is a note of what he
 * handed over, in the same spirit as the products he discussed.
 *
 * ## Why junk is DROPPED and never refused
 *
 * The same rule as `visit-outcome.ts`, for the same reason: the rep is at a door holding a photo he
 * cannot retake. A quantity of "many", an item his line dropped last week, a key from a build one
 * release behind — each is left out and the visit saves. Only `products`, the pharmacy name and the
 * photo can refuse a visit, because those are the visit.
 *
 * ## The key space
 *
 * One object, `{ item: quantity }`, with two kinds of key:
 *
 *   - `material:pen`, `material:block_note`, `material:giveaway` — the fixed three.
 *   - a bare product name from the rep's own line — a free medical sample of that product.
 *
 * The `material:` prefix is RESERVED, and a "product" whose name begins with it is dropped. Without
 * that, a product one day called "Pen" would silently become the pen count on every manager's board,
 * and nothing would ever say so. `product_availability` keys products bare in the same table, so a
 * sample reads the same way there as it does here.
 */

export const SAMPLE_MATERIALS = [
  { key: "material:pen", label: "Pen" },
  { key: "material:block_note", label: "Block note" },
  { key: "material:giveaway", label: "Giveaway" },
] as const;

export type SampleMaterial = (typeof SAMPLE_MATERIALS)[number]["key"];

export const MATERIAL_PREFIX = "material:";

/** A line could not hand over more kinds than this in one visit; it only stops a bag of junk keys. */
export const SAMPLE_ITEMS_MAX = 20;
/** Quantities are whole and small. 99 is a cap, not a stock level — nothing checks it against one. */
export const SAMPLE_QUANTITY_MAX = 99;

const MATERIAL_KEYS = new Set<string>(SAMPLE_MATERIALS.map((entry) => entry.key));

export function isSampleMaterial(value: unknown): value is SampleMaterial {
  return typeof value === "string" && MATERIAL_KEYS.has(value);
}

export function sampleMaterialLabel(key: string): string | null {
  return SAMPLE_MATERIALS.find((entry) => entry.key === key)?.label ?? null;
}

/** What a key reads as on a screen: a material's own name, or the product it samples. */
export function sampleItemLabel(key: string): string {
  return sampleMaterialLabel(key) ?? key;
}

export type SamplesGiven = Record<string, number>;

function quantity(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return null;
  const whole = Math.round(parsed);
  if (whole < 1) return null;
  return Math.min(whole, SAMPLE_QUANTITY_MAX);
}

/**
 * The samples the phone sent, cleaned.
 *
 * Never fails. A key that is neither one of the three materials nor a plausible product name is
 * dropped; a quantity that is not a whole number of at least one is dropped WITH its key, because
 * "he left some" is not a record and a zero is the same as not saying it. Whether a bare key really
 * is one of the rep's line products is settled on the SERVER (`saveVisit`), exactly as the discussed
 * products are — this module has no idea what the line sells.
 */
export function parseSamplesGiven(raw: unknown): SamplesGiven {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SamplesGiven = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= SAMPLE_ITEMS_MAX) break;
    const key = String(rawKey).replace(/\s+/g, " ").trim();
    if (!key || key.length > 80) continue;
    // A product may not wear the reserved prefix, and an unknown material key is not a product.
    if (key.startsWith(MATERIAL_PREFIX) && !isSampleMaterial(key)) continue;
    const count = quantity(rawValue);
    if (count === null) continue;
    out[key] = count;
  }
  return out;
}

/**
 * The same object with every bare key that is not one of the line's products removed.
 *
 * The twin of what `saveVisit` already does to `product_availability`: a product dropped from the
 * line since the form loaded is quietly left out rather than blocking the save.
 */
export function narrowSamplesToLine(samples: SamplesGiven, lineProducts: Iterable<string>): SamplesGiven {
  const live = new Set(lineProducts);
  const out: SamplesGiven = {};
  for (const [key, count] of Object.entries(samples)) {
    if (isSampleMaterial(key) || live.has(key)) out[key] = count;
  }
  return out;
}

/** What the card prints: the materials in their fixed order first, then the sampled products. */
export function describeSamples(samples: SamplesGiven): Array<{ key: string; label: string; quantity: number }> {
  const entries = Object.entries(samples);
  const materials = SAMPLE_MATERIALS.flatMap((material) => {
    const found = entries.find(([key]) => key === material.key);
    return found ? [{ key: material.key, label: material.label, quantity: found[1] }] : [];
  });
  const products = entries
    .filter(([key]) => !isSampleMaterial(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, label: key, quantity: count }));
  return [...products, ...materials];
}
