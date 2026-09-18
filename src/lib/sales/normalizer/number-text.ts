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
 *
 * Nothing here guesses. A letter O where a zero belongs, a bracketed negative, or a number with a word
 * beside it stays unreadable: reading one of those wrongly would put a wrong sale on the books, so the
 * row is refused and shown instead. Before this, every form above was refused too, and one such cell
 * stopped the whole file from importing.
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

const SPACE_GROUPED = /^([-+]?\d{1,3})((?: \d{3})+)(\.\d+)?(%?)$/;

export function normalizeNumberText(raw: string): string {
  const text = Array.from(raw.trim(), foldChar).join("");
  const grouped = SPACE_GROUPED.exec(text);
  return grouped ? `${grouped[1]}${grouped[2].replace(/ /g, "")}${grouped[3] ?? ""}${grouped[4]}` : text;
}
