/**
 * The `scope` each finance download understands — and they do NOT share one vocabulary.
 *
 * The finance sheet (`/api/automated-payroll/finance/download`) reads `part1 | full`. The FAB and
 * CIB bank files (`fab-download`, `cib-download`) read `part1 | part2`. The Finance Command Center
 * used to send one shared `scope=full` to all three once Part 2 was confirmed, and the bank routes
 * turned any word they did not know into `part1` — so its "Ready to pay" FAB and CIB buttons handed
 * finance the PART 1 bank files: a file paying every First Part a second time, and never checked
 * against the Part 2 stamp (live from 10 Aug 2026 until the November 2026 audit). Each link asks in
 * its own words, and since 14 Nov 2026 each route REFUSES a word it does not know (the parsers
 * below), so an old bookmark or a new caller cannot be handed the wrong month's money.
 *
 * Browser-safe and pure: the command center imports it, and the test calls it directly.
 */

export type FinanceDownloadKind = "finance" | "fab" | "cib";

export function financeDownloadScope(kind: FinanceDownloadKind, part2Confirmed: boolean): "part1" | "part2" | "full" {
  if (!part2Confirmed) return "part1";
  return kind === "finance" ? "full" : "part2";
}

/** A bank file's scope, or null for any other word — never a default, because the default paid twice. */
export function parseBankFileScope(value: string | null): "part1" | "part2" | null {
  return value === "part1" || value === "part2" ? value : null;
}

/** The finance sheet's scope, or null for any other word. */
export function parseFinanceSheetScope(value: string | null): "part1" | "full" | null {
  return value === "part1" || value === "full" ? value : null;
}

/**
 * A FAB value date that is a real calendar day, "YYYY-MM-DD". The shape check alone let 2026-13-45
 * through to the bank file builder.
 */
export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
