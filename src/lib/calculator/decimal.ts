/**
 * Exact decimal arithmetic for the desk calculator.
 *
 * WHY NOT `number`. Phoenix runs payroll, incentives and sales value. A calculator that answers
 * `0.1 + 0.2` with `0.30000000000000004`, or `4.35 * 100` with `434.99999999999994`, is not a
 * rounding nuisance here — it is a number somebody copies into a salary sheet. IEEE-754 binary
 * floats cannot represent most decimal fractions, so every one of those answers is what a
 * `number`-based calculator genuinely computes.
 *
 * A value is held as an integer of `units` scaled by `10 ** scale`, in `bigint`, so addition,
 * subtraction and multiplication are exact at any magnitude — no significand limit, no drift.
 * Division is the one operation that cannot always terminate (1/3), so it alone rounds, once,
 * half-up, at a declared scale.
 */

/** A real number held exactly as `units / 10 ** scale`. */
export type Decimal = {
  readonly scale: number;
  readonly units: bigint;
};

/**
 * Decimal places kept by division. 18 is chosen so that a divided result re-multiplied by its
 * divisor still reads correctly at any money scale a human will look at, while staying far below
 * the point where the digits become noise on a 288px panel.
 */
export const DIVISION_SCALE = 18;

/** Most significant digits a value may carry before the display is meaningless. */
export const MAX_SIGNIFICANT_DIGITS = 18;

/**
 * `bigint` values are built with `BigInt(...)` and NEVER with the `10n` literal syntax. This
 * project's tsconfig targets ES2017, which rejects the literal form outright (TS2737) even though
 * `lib: esnext` makes the type and the global perfectly available. Raising `target` for a topbar
 * calculator would be a repo-wide change with no other beneficiary — so the calls stay.
 */
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

export const DECIMAL_ZERO: Decimal = { scale: 0, units: ZERO };

function pow10(exponent: number): bigint {
  return TEN ** BigInt(exponent);
}

/** Drops trailing fractional zeros so `2.50` and `2.5` are the same value and print the same. */
export function normalizeDecimal(value: Decimal): Decimal {
  let units = value.units;
  let scale = value.scale;
  if (units === ZERO) return DECIMAL_ZERO;
  while (scale > 0 && units % TEN === ZERO) {
    units /= TEN;
    scale -= 1;
  }
  return { scale, units };
}

/**
 * Reads a plain decimal string. Deliberately strict: it accepts only an optional sign, digits, and
 * at most one point. Anything looser belongs in `sanitizePastedNumber`, which is where the guessing
 * about pasted text is allowed to happen and where it can refuse.
 */
export function parseDecimal(input: string): Decimal | null {
  const text = String(input ?? "").trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === "-" ? -ONE : ONE;
  const integerDigits = match[2] ?? "";
  const fractionDigits = match[3] ?? "";
  if (!integerDigits && !fractionDigits) return null;
  const digits = `${integerDigits}${fractionDigits}`;
  return normalizeDecimal({ scale: fractionDigits.length, units: BigInt(digits) * sign });
}

/** Renders a value as a plain, ungrouped, machine-readable string — what gets copied out. */
export function formatDecimal(value: Decimal): string {
  const { scale, units } = normalizeDecimal(value);
  const negative = units < ZERO;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const cut = digits.length - scale;
  const body = scale > 0 ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  return negative ? `-${body}` : body;
}

function alignedUnits(left: Decimal, right: Decimal): { left: bigint; right: bigint; scale: number } {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.units * pow10(scale - left.scale),
    right: right.units * pow10(scale - right.scale),
    scale,
  };
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const aligned = alignedUnits(left, right);
  return normalizeDecimal({ scale: aligned.scale, units: aligned.left + aligned.right });
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  const aligned = alignedUnits(left, right);
  return normalizeDecimal({ scale: aligned.scale, units: aligned.left - aligned.right });
}

export function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
  return normalizeDecimal({ scale: left.scale + right.scale, units: left.units * right.units });
}

export function negateDecimal(value: Decimal): Decimal {
  return normalizeDecimal({ scale: value.scale, units: -value.units });
}

/** Integer division rounded half-up on MAGNITUDE, so -0.5 rounds to -1 exactly as 0.5 rounds to 1. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < ZERO !== denominator < ZERO;
  const top = numerator < ZERO ? -numerator : numerator;
  const bottom = denominator < ZERO ? -denominator : denominator;
  const quotient = top / bottom;
  const remainder = top % bottom;
  const rounded = remainder * TWO >= bottom ? quotient + ONE : quotient;
  return negative ? -rounded : rounded;
}

/**
 * `left / right`, rounded half-up at `scale` decimal places. Returns null on a zero divisor — the
 * caller turns that into the visible error rather than an Infinity that would then contaminate
 * every later key press.
 */
export function divideDecimal(left: Decimal, right: Decimal, scale: number = DIVISION_SCALE): Decimal | null {
  if (right.units === ZERO) return null;
  const numerator = left.units * pow10(right.scale) * pow10(scale);
  const denominator = right.units * pow10(left.scale);
  return normalizeDecimal({ scale, units: divideRoundHalfUp(numerator, denominator) });
}

/** Groups the integer part in threes for the display. Never applied to what is copied out. */
export function groupDigits(plain: string): string {
  const [integerPart = "", fractionPart] = plain.split(".");
  const negative = integerPart.startsWith("-");
  const digits = negative ? integerPart.slice(1) : integerPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fractionPart === undefined ? "" : `.${fractionPart}`}`;
}

const ARABIC_INDIC_OFFSET = 0x0660;
const EXTENDED_ARABIC_INDIC_OFFSET = 0x06f0;

/**
 * Turns pasted text into a plain decimal string, or refuses.
 *
 * Handles what actually lands on the clipboard in this company: `EGP 1,234.56` from a Phoenix
 * screen, `(1,234.56)` from an accounting export, `١٢٣٤٫٥٦` from an Arabic sheet, and a stray
 * trailing `%`. It REFUSES anything still ambiguous after cleaning — `1.234.567` could be one and
 * a bit or one-point-two-million depending on the locale that wrote it, and a calculator that
 * guesses which is worse than one that says it cannot read it.
 */
export function sanitizePastedNumber(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const westernDigits = raw
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - ARABIC_INDIC_OFFSET))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - EXTENDED_ARABIC_INDIC_OFFSET))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");

  // An accounting export writes a negative as (1,234.56); a minus anywhere else means the same.
  const parenthesised = /^\(.*\)$/.test(westernDigits.trim());
  const negative = parenthesised || westernDigits.includes("-") || westernDigits.includes("−");

  const digitsOnly = westernDigits.replace(/[^\d.]/g, "");
  if (!digitsOnly || !/\d/.test(digitsOnly)) return null;
  if (digitsOnly.split(".").length > 2) return null;

  const [integerPart = "", fractionPart = ""] = digitsOnly.split(".");
  const trimmedInteger = integerPart.replace(/^0+(?=\d)/, "");
  const body = fractionPart ? `${trimmedInteger || "0"}.${fractionPart}` : trimmedInteger || "0";
  const signed = negative && /[1-9]/.test(digitsOnly) ? `-${body}` : body;
  return parseDecimal(signed) ? signed : null;
}
