/**
 * A number a distributor sheet wrote in a form with exactly ONE meaning, rewritten into the plain form
 * the engine's reader understands. Returns the trimmed text unchanged when nothing applies.
 *
 *   • Arabic-Indic and Persian digits: "١٢٠" and "۱۲۰" are 120
 *   • the Arabic decimal and thousands separators: "١٫٥" is 1.5, "١٬٢٠٠" is 1200
 *   • the Arabic percent sign "٪", for discounts
 *   • the Unicode minus sign (U+2212)
 *   • thousands grouped with spaces, ordinary, no-break or thin: "1 200" is 1200 — only whole groups
 *     of three, so "12 5" stays unreadable rather than becoming 125
 *   • dots for thousands and a comma for decimals: "1.234,56" is 1234.56 — the dot comes BEFORE the
 *     comma, so no other reading exists (owner, 2026-09-18: read it and list it). Whole groups of three
 *     only, and only with the Latin "." and ",": the Arabic signs already say which one is the decimal.
 *
 * Nothing here guesses. A letter O where a zero belongs, a bracketed negative, or a number with a word
 * beside it stays unreadable: reading one of those wrongly would put a wrong sale on the books, so the
 * row is refused and shown instead. Before this, every form above but the last was refused too, and one
 * such cell stopped the whole file from importing; the last was worse, read silently as 1.23456.
 *
 * Written by character code, not as regex escapes, so no invisible character sits in this source.
 */
const SIGNS: Readonly<Record<number, string>> = {
  0x066a: "%", // Arabic percent sign
  0x066b: ".", // Arabic decimal separator
  0x066c: ",", // Arabic thousands separator
  0x2212: "-", // minus sign
  0x00a0: " ", // no-break space
  0x2009: " ", // thin space
  0x202f: " ", // narrow no-break space
};

function foldChar(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return SIGNS[code] ?? char;
}

function hasArabicSeparator(raw: string): boolean {
  return Array.from(raw).some((c) => c.charCodeAt(0) === 0x066b || c.charCodeAt(0) === 0x066c);
}

const SPACE_GROUPED = /^([-+]?\d{1,3})((?: \d{3})+)(\.\d+)?(%?)$/;
const DOT_GROUPED = /^([-+]?\d{1,3})((?:\.\d{3})+),(\d+)(%?)$/;

export function normalizeNumberText(raw: string): string {
  const text = Array.from(raw.trim(), foldChar).join("");
  const grouped = SPACE_GROUPED.exec(text);
  if (grouped) return `${grouped[1]}${grouped[2].replace(/ /g, "")}${grouped[3] ?? ""}${grouped[4]}`;
  const dotted = hasArabicSeparator(raw) ? null : DOT_GROUPED.exec(text);
  if (dotted) return `${dotted[1]}${dotted[2].replace(/\./g, "")}.${dotted[3]}${dotted[4]}`;
  return text;
}

// ── Text that would have to be guessed at ─────────────────────────────────────────────────────────
//
// A quantity or value cell held as TEXT whose separators, after normalizeNumberText, leave it two
// readings. The engine used to strip every comma and hand the rest to Number(), so "12,5" was read as
// 125 and "1.234" as 1.234, with nothing said. Owner, 2026-09-18: refuse them and name the cell. Never
// asked of a cell Excel stores as a number, which has one value however it prints, and never of a
// discount, which since 2026-09-07 changes no number.

// One to three digits, a dot, exactly three: "1.234" is 1.234, or 1234 with a dot for thousands. A
// leading zero ("0.500") is never a thousands group, so that stays 0.5.
const DOT_THREE = /^[-+]?[1-9]\d{0,2}\.\d{3}$/;
// A comma is a thousands separator only between whole groups of three: "1,200", "12,345.5".
const COMMA_GROUPED = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
// One comma between digits that is not a thousands group: "12,5" is 12.5 with a comma for decimals,
// or 125 with the comma dropped.
const COMMA_DECIMAL = /^[-+]?\d+,\d+$/;

/** A comma anywhere but between whole groups of three digits. */
export function misplacedComma(text: string): boolean {
  return text.includes(",") && !COMMA_GROUPED.test(text);
}

/** The two numbers a text cell could mean ("1.234": 1.234 or 1234), or null when it has at most one. */
export function twoReadings(text: string): [string, string] | null {
  if (DOT_THREE.test(text)) return [text, text.replace(".", "")];
  if (COMMA_DECIMAL.test(text) && misplacedComma(text)) return [text.replace(",", "."), text.replace(",", "")];
  return null;
}

/** True when a text quantity or value could only be read by guessing, so its row is refused. */
export function needsAGuess(text: string): boolean {
  return DOT_THREE.test(text) || misplacedComma(text);
}
