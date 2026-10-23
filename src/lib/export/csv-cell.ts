/**
 * ONE CSV CELL FOR EVERY LIVE-SHEET FEED — RFC 4180 quoting, and formula cells neutralised.
 *
 * 🔴 A CELL THAT STARTS WITH `=`, `+`, `-` OR `@` IS A FORMULA TO A SPREADSHEET. The share feeds
 * (CV lifecycle, Direct Orders, Marketing Requests) carry text that arrives from outside — candidate
 * names from the public application form, pharmacy and customer names typed into requests — and a
 * spreadsheet that opens the file runs whatever formula such a cell spells (technical audit
 * 23 Oct 2026, S-APP-08). The cure is the standard one: a leading apostrophe, which every
 * spreadsheet reads as "this is text" and does not display.
 *
 * Two things are deliberately NOT touched, because a feed full of apostrophes would be its own bug:
 *  - a NUMBER — a negative amount stays a number the sheet can add up;
 *  - a string that is only a number or a phone number (`-500`, `+20 100 123 4567`), which no
 *    spreadsheet can execute. `-2+3+cmd|' /C calc'!A0` is not one of those: it has a `+` after the
 *    first character and letters, so it is neutralised.
 * A one-character cell (`-` as an empty marker) is left alone too; it cannot hold a formula.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER_OR_PHONE = /^[+-]?[\d\s().-]*\d[\d\s().-]*$/;

/** The text, made safe to open in a spreadsheet; unchanged unless it would run as a formula. */
export function neutralizeCsvFormula(text: string): string {
  if (text.length < 2 || !FORMULA_LEAD.test(text)) return text;
  if (PLAIN_NUMBER_OR_PHONE.test(text)) return text;
  return `'${text}`;
}

/** RFC 4180 quoting — a name containing a comma must survive the round trip — after neutralising. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" || typeof value === "bigint" ? String(value) : neutralizeCsvFormula(String(value));
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
