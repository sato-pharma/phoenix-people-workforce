import { normalizeNumberText } from "@/lib/sales/normalizer/number-text";
import type { CellCorrection, NormalizeException } from "@/lib/sales/normalizer/types";

// What an upload tells a person about a row it refuses, and about a number it read only after fixing
// it. One wording for every screen that blocks — Sales Upload, Diagnostics, the monthly wizard and the
// validated import — so a refusal always names the row, the cell as the sheet wrote it, and what is
// wrong with it, instead of sending the person to Mapping for a cell no mapping can fix.

// What each refused row is missing, for the reasons no mapping can fix: the cell or the customer is
// wrong in the sheet itself. An unknown territory or customer ("brick"/"both") is listed as an unmapped
// item instead, because mapping it IS the fix. Keyed on every other reason in the union, so a new
// reason cannot be added without deciding how it is shown here.
export const REFUSED_ROW_REASONS: Record<Exclude<NormalizeException["reason"], "product" | "brick" | "both">, string> = {
  blank_customer: "no customer code, territory or brick",
  unparseable_qty: "a quantity that cannot be read",
  unparseable_value: "a value that cannot be read",
  discount_out_of_range: "a discount that is unreadable, negative, or 100% or more",
};

export type RefusedRow = NormalizeException & { reason: keyof typeof REFUSED_ROW_REASONS };

export function isRefusedRow(exception: NormalizeException): exception is RefusedRow {
  return exception.reason in REFUSED_ROW_REASONS;
}

// How many row lines a message spells out before it says "and N more".
export const ROW_LINE_LIMIT = 8;

export function listRowLines(lines: readonly string[], limit = ROW_LINE_LIMIT): string {
  const shown = lines.slice(0, limit).join("; ");
  return lines.length > limit ? `${shown}; and ${(lines.length - limit).toLocaleString("en-US")} more` : shown;
}

// "2 with no customer code, territory or brick · 1 with a value that cannot be read"
export function summarizeRefusedRows(rows: readonly RefusedRow[]): string {
  const byReason = new Map<RefusedRow["reason"], number>();
  for (const row of rows) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
  return [...byReason].map(([reason, n]) => `${n.toLocaleString("en-US")} with ${REFUSED_ROW_REASONS[reason]}`).join(" · ");
}

const CELL_FIELD = {
  unparseable_qty: "quantity",
  unparseable_value: "value",
  discount_out_of_range: "discount",
} as const;

// A Latin (or any cased) letter, or anything left in the Arabic block once normalizeNumberText has
// turned its digits and separators into plain ones, which can only be a letter or a mark.
function hasLetters(written: string): boolean {
  return Array.from(written).some((c) => c.toLowerCase() !== c.toUpperCase() || (c.charCodeAt(0) >= 0x0600 && c.charCodeAt(0) <= 0x06ff));
}

// Why a number cell cannot be read, in the terms the person will recognise in their sheet. Only forms
// normalizeNumberText refuses to guess at reach here: it has already read everything with one meaning.
function numberProblem(written: string): string {
  if (hasLetters(written)) return "has letters in it";
  if (/^\(.*\)$/.test(written)) return "is in brackets";
  return "is not a number";
}

// Mirrors discountFrac's rules exactly: unreadable, negative, a bare "1", or 100% and above.
function discountProblem(raw: string): string {
  const written = normalizeNumberText(raw);
  const n = Number(written.replace(/%/g, "").replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return numberProblem(written);
  if (n < 0) return "is negative";
  if (n === 1 && !written.includes("%")) return "could mean 1% or 100%, so it is not guessed; write 1% or 100%";
  return "is 100% or more";
}

// "Row 145: quantity "1,2OO" has letters in it"
export function describeRefusedRow(row: RefusedRow): string {
  const at = `Row ${row.rawRowNumber}`;
  if (row.reason === "blank_customer") return `${at}: ${REFUSED_ROW_REASONS.blank_customer}`;
  const field = CELL_FIELD[row.reason];
  const raw = row.rawCell?.trim() ?? "";
  if (!raw) return `${at}: the ${field} ${row.reason === "discount_out_of_range" ? "is unreadable, negative, or 100% or more" : "cannot be read"}`;
  const problem = row.reason === "discount_out_of_range" ? discountProblem(raw) : numberProblem(normalizeNumberText(raw));
  return `${at}: ${field} "${raw}" ${problem}`;
}

// "Row 14: quantity "١٢٠" read as 120"
export function describeCellCorrection(correction: CellCorrection): string {
  const read = correction.field === "discount"
    ? `${Number((correction.read * 100).toFixed(4))}%`
    : correction.read.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `Row ${correction.rawRowNumber}: ${correction.field} "${correction.raw}" read as ${read}`;
}
