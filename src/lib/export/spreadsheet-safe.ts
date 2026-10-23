/**
 * One guard against spreadsheet formula injection, for every CSV and XLSX this app writes from
 * text a person or a browser supplied.
 *
 * Excel, LibreOffice and Google Sheets run a cell as a formula when its first meaningful
 * character is `=`, `+`, `-` or `@` — and they skip leading whitespace, a tab and a carriage
 * return before deciding, and treat the full-width `＝`/`＋`/`－`/`＠` the same way. A cell holding
 * `=HYPERLINK("http://evil","click")` or `\t=cmd|' /C calc'!A0` is therefore live in the file a
 * Super Admin opens. The older per-file copies (e.g. probation/export.ts) strip control
 * characters but test only the first character, so a leading tab or space let a formula through.
 *
 * The fix is the standard one: a leading apostrophe, which every spreadsheet reads as "this is
 * text" and does not display.
 */

const FORMULA_LEAD = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** True when a spreadsheet would treat this text as a formula. */
export function looksLikeSpreadsheetFormula(text: string): boolean {
  return FORMULA_LEAD.test(text);
}

/**
 * Text that is safe to put in a spreadsheet cell. Numbers and booleans pass through untouched so
 * a real negative number stays a number; everything else becomes a string with control
 * characters removed and a formula lead neutralised.
 */
export function spreadsheetSafe(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  const text = (typeof value === "string" ? value : value instanceof Date ? value.toISOString() : JSON.stringify(value)).replace(
    CONTROL_CHARS,
    "",
  );
  return looksLikeSpreadsheetFormula(text) ? `'${text}` : text;
}

/** Always a string — for XLSX cells that must never be typed as numbers or formulas. */
export function spreadsheetSafeText(value: unknown): string {
  const safe = spreadsheetSafe(value);
  return safe === null ? "" : String(safe);
}

/** One CSV field: neutralised, then quoted when it holds a comma, quote or line break. */
export function csvField(value: unknown): string {
  const safe = spreadsheetSafe(value);
  if (safe === null) return "";
  const text = String(safe);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CSV line from a list of fields. */
export function csvLine(fields: readonly unknown[]): string {
  return fields.map(csvField).join(",");
}

/** The byte-order mark that makes Excel read a UTF-8 CSV (Arabic names) correctly. */
export const CSV_BOM = "﻿";
