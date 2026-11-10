/**
 * The two string converters that sit between a typed field and a stored quantity.
 *
 * Every quantity in this module is stored in its material's BASE unit — grams for a mass material,
 * pieces for a count one — while the owner's own source data is in the DISPLAY unit his supplier
 * tables use. DBK's packaging sheet is headed "Quantity Aluminum / box" and reads `0.018`; the row
 * for that material holds `18`. The two differ by a thousand, and a thousandfold slip in either
 * direction is an ordinary-looking number on an ordinary-looking row:
 *
 *   • a field seeded with the stored figure under a kilogram label, saved back, stores 18,000 g and
 *     the buy list asks DBK for eighteen tonnes of film;
 *   • converted the wrong way on save, it stores 0.018 g and six runs of film cost nothing at all.
 *
 * So both directions exist, and they are exact inverses. `tests/production-planning-composition-editor.test.ts`
 * round trips them against the figures this module really holds.
 *
 * 🔴 STRING arithmetic, never floating point, and both directions are affected. Measured in node:
 * `Number("1.001") * 1000` is 1000.9999999999999, and `Number("2.1") / 1000` is
 * 0.0021000000000000003 — 1.001 kg and 2.1 g are both perfectly ordinary figures for this module.
 * It exists so that the screen, the stored row and the Excel formula all carry the same digits.
 *
 * Anything that is not a plain decimal, and any factor that is not a power of ten, is handed back
 * untouched — the field then shows exactly what is stored, which is wrong-LOOKING rather than wrong.
 */

/** Only the one field either converter reads, so a plain object is enough to test them with. */
export type DisplayScaledMaterial = { basePerDisplay: string };

/** The factor, when it is a usable power of ten; `null` when the figure must be left alone. */
function decimalShift(text: string, material: DisplayScaledMaterial | undefined): number | null {
  if (!material || text === "" || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const factor = material.basePerDisplay;
  if (!/^\d+$/.test(factor) || factor === "1") return null;
  const zeros = factor.length - 1;
  if (factor !== `1${"0".repeat(zeros)}`) return null;
  return zeros;
}

/** A figure typed in the display unit, into the base unit the service stores. */
export function toBaseUnits(typed: string, material: DisplayScaledMaterial | undefined): string {
  const text = typed.trim();
  const zeros = decimalShift(text, material);
  if (zeros === null) return text;
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  const fraction = dot < 0 ? "" : text.slice(dot + 1);
  if (fraction.length <= zeros) {
    return `${whole}${fraction.padEnd(zeros, "0")}`.replace(/^0+(?=\d)/, "");
  }
  const shifted = `${whole}${fraction.slice(0, zeros)}.${fraction.slice(zeros)}`;
  return shifted.replace(/^0+(?=\d)/, "");
}

/** The exact inverse: a STORED base figure back into the display unit, for seeding an editor field. */
export function fromBaseUnits(stored: string, material: DisplayScaledMaterial | undefined): string {
  const text = stored.trim();
  const zeros = decimalShift(text, material);
  if (zeros === null) return text;
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  const fraction = dot < 0 ? "" : text.slice(dot + 1);
  // Pad so there is always a digit to carry the decimal point past, then shift it left by `zeros`.
  const padded = whole.padStart(zeros + 1, "0");
  const head = padded.slice(0, padded.length - zeros).replace(/^0+(?=\d)/, "");
  const tail = `${padded.slice(padded.length - zeros)}${fraction}`.replace(/0+$/, "");
  return tail === "" ? head : `${head}.${tail}`;
}

/**
 * The bases a "per 1,000 boxes" figure can be turned into — the ones counted off the box itself.
 *
 * The owner gives packaging the way the factory measures it, per thousand boxes ("2.2 كيلو للألف
 * علبة … الألف علبة اللي هي 3 شرايط", 2026-11-11), and twice that night the per-strip figure had to
 * be worked out by hand. A per-dose or per-sample line is not a fraction of a box, so it is not offered.
 */
export const PER_THOUSAND_BOX_BASES = ["per_box", "per_strip", "per_packaging_set"] as const;

export type PerThousandBoxBasis = (typeof PER_THOUSAND_BOX_BASES)[number];

export function isPerThousandBoxBasis(basis: string): basis is PerThousandBoxBasis {
  return (PER_THOUSAND_BOX_BASES as readonly string[]).includes(basis);
}

const MICRO_DIGITS = 6;
const WORK_DIGITS = 12;

/** A plain decimal string as an integer scaled by 10^digits, or null if it has more places than that. */
function scaled(text: string, digits: number): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > digits) return null;
  return BigInt(`${whole}${fraction.padEnd(digits, "0")}`);
}

/**
 * A figure typed per 1,000 boxes, in the material's DISPLAY unit, as the amount per ONE basis unit in
 * the material's BASE unit — the string the composition row stores.
 *
 * Rounded UP to the six decimals the column holds, because a formula never under-orders (the rule the
 * Saginkgo foil migration followed by hand: 2.285 kg ÷ 3,000 strips = 0.761667 g a strip). Integer
 * arithmetic throughout, never floating point — the same reason the converters above shift digits.
 * `null` for an empty or malformed figure, a basis that is not a share of a box, or a product that
 * does not say how many strips or units its box holds.
 */
export function perThousandBoxesToBase(args: {
  readonly typed: string;
  readonly material: DisplayScaledMaterial;
  readonly basis: string;
  readonly unitsPerBox: string | null | undefined;
  readonly stripsPerBox: string | null | undefined;
}): string | null {
  if (!isPerThousandBoxBasis(args.basis)) return null;
  const divisorText =
    args.basis === "per_box" ? "1" : args.basis === "per_strip" ? args.stripsPerBox : args.unitsPerBox;
  if (!divisorText || !/^[1-9]\d*$/.test(divisorText)) return null;
  const base = toBaseUnits(args.typed, args.material);
  const perThousand = scaled(base, WORK_DIGITS);
  if (perThousand === null || perThousand <= BigInt(0)) return null;
  // per basis (micro) = perThousand / 10^12 × 10^6 / (1000 × divisor), rounded up.
  const denominator = BigInt(10) ** BigInt(WORK_DIGITS - MICRO_DIGITS) * BigInt(1000) * BigInt(divisorText);
  const micro = (perThousand + denominator - BigInt(1)) / denominator;
  const digits = micro.toString().padStart(MICRO_DIGITS + 1, "0");
  const whole = digits.slice(0, digits.length - MICRO_DIGITS);
  const fraction = digits.slice(digits.length - MICRO_DIGITS).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
