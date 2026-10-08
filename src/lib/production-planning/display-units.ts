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
