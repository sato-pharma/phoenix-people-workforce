/**
 * The `scope` each finance download understands — and they do NOT share one vocabulary.
 *
 * The finance sheet (`/api/automated-payroll/finance/download`) reads `part1 | full`. The FAB and
 * CIB bank files (`fab-download`, `cib-download`) read `part1 | part2`, and turn ANY other word into
 * `part1`. The Finance Command Center used to send one shared `scope=full` to all three once Part 2
 * was confirmed, so its "Ready to pay" FAB and CIB buttons handed finance the PART 1 bank files: a
 * file paying every First Part a second time, and never checked against the Part 2 stamp (live from
 * 10 Aug 2026 until this was found in the November 2026 audit). Each link asks in its own words.
 *
 * Browser-safe and pure: the command center imports it, and the test calls it directly.
 */

export type FinanceDownloadKind = "finance" | "fab" | "cib";

export function financeDownloadScope(kind: FinanceDownloadKind, part2Confirmed: boolean): "part1" | "part2" | "full" {
  if (!part2Confirmed) return "part1";
  return kind === "finance" ? "full" : "part2";
}
