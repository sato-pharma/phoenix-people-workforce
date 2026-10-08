/**
 * Phoenix CRM — the weekly visit-fraud scan: the summary composition and the job slug.
 *
 * This is pure logic with NO I/O — it imports only the window and case types from
 * `@/lib/phoenix-crm/fraud-scan-rules`, so the unit test imports it without pulling the server's
 * Supabase client. It lives under `server/` for ONE reason: Golden Rule #1's blind half
 * (`tests/phoenix-crm-blind-half.test.ts`) forbids a rep-bundled file from naming the checks in a
 * string — "integrity", "flagged", "fraud" — and the summary and the slug must say exactly those
 * words. `server/**` is excluded from that rep sweep, so the words are allowed here and nowhere a rep
 * can read. The slug carries "fraud" too, which is why it is defined here rather than in the rules.
 */

import type { FraudScanCase, FraudScanSummary, FraudScanWindow } from "@/lib/phoenix-crm/fraud-scan-rules";

export const FRAUD_SCAN_JOB_SLUG = "phoenix-crm-fraud-scan";

/** The most territories-worth of reps one message will name before it counts the rest. */
export const FRAUD_SCAN_MAX_LINES = 15;

/**
 * Summarise a week's flagged captures for one recipient. The caller has already narrowed the list to
 * what that recipient may see, so this is tier-agnostic: it counts, groups by rep, and names the
 * reasons. A clean week is reported as clean, never suppressed (see the rules-file header).
 */
export function summarizeFraudCases(cases: ReadonlyArray<FraudScanCase>, window: FraudScanWindow): FraudScanSummary {
  const flaggedVisits = cases.length;
  const strongVisits = cases.filter((entry) => entry.strong).length;

  if (flaggedVisits === 0) {
    return {
      title: `No integrity flags · ${window.label}`,
      message: `${window.label}\nNo Phoenix CRM visits were flagged this week. The scan ran and found nothing to look at.`,
      flaggedVisits: 0,
      strongVisits: 0,
      reps: 0,
    };
  }

  const perRep = new Map<string, { repName: string; cases: number; strong: number; reasons: Set<string> }>();
  for (const entry of cases) {
    const current = perRep.get(entry.repHrId) ?? { repName: entry.repName, cases: 0, strong: 0, reasons: new Set<string>() };
    current.cases += 1;
    if (entry.strong) current.strong += 1;
    for (const reason of entry.reasons) current.reasons.add(reason);
    perRep.set(entry.repHrId, current);
  }

  const ranked = [...perRep.values()].sort(
    (left, right) => right.strong - left.strong || right.cases - left.cases || left.repName.localeCompare(right.repName),
  );
  const shown = ranked.slice(0, FRAUD_SCAN_MAX_LINES);
  const rest = ranked.length - shown.length;

  const lines = shown.map((rep) => {
    const strong = rep.strong > 0 ? ` (${rep.strong} strong)` : "";
    const reasons = [...rep.reasons].join(", ");
    return `• ${rep.repName} — ${rep.cases}${strong}: ${reasons}`;
  });
  if (rest > 0) lines.push(`• and ${rest} more on the board.`);

  const headline =
    `${flaggedVisits} ${flaggedVisits === 1 ? "visit" : "visits"} carried an integrity flag across ` +
    `${perRep.size} ${perRep.size === 1 ? "rep" : "reps"}. Strong: ${strongVisits}.`;

  return {
    title:
      strongVisits > 0
        ? `${strongVisits} strong, ${flaggedVisits} flagged · ${window.label}`
        : `${flaggedVisits} flagged · ${window.label}`,
    message: `${window.label}\n${headline}\n${lines.join("\n")}`,
    flaggedVisits,
    strongVisits,
    reps: perRep.size,
  };
}
