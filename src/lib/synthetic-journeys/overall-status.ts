/**
 * The one word a smoke run is filed under, and what makes a skipped check harmless.
 *
 * Owner, 14 November 2026: a run where every check passes reads healthy. Until then ANY skipped
 * check made the run a warning, and one check is skipped on purpose every hour (the Outstation
 * Expenses export, which would record an export nobody made). So from 9 September 2026 not one run
 * read healthy — 936 read warning — and amber meant "everything passed", which is no signal at all.
 *
 * The line between the two kinds of skip is whether the check SAID WHY. A check that skips itself
 * gives its reason in the same call, and the reporter copies it (tests/synthetic/helpers/skip-reason.ts).
 * A check that never ran because something before it went wrong has no reason to give, and that one
 * still turns the run amber.
 *
 * Kept free of imports so the suite's reporter, the save script and the tests can all read it.
 */

export type OverallStatus = "healthy" | "warning" | "failed" | "no_data";

export interface JourneyStatusInput {
  status: "passed" | "failed" | "skipped";
  skipReason?: string | null;
}

/** A skipped check that gave its own reason. One that gave none did not choose to be skipped. */
export function isSkippedOnPurpose(result: JourneyStatusInput): boolean {
  return result.status === "skipped" && typeof result.skipReason === "string" && result.skipReason.trim().length > 0;
}

export function computeOverallStatus(results: readonly JourneyStatusInput[]): OverallStatus {
  if (results.length === 0) return "no_data";
  if (results.some((r) => r.status === "failed")) return "failed";
  if (results.some((r) => r.status === "skipped" && !isSkippedOnPurpose(r))) return "warning";
  // Nothing failed and every skip was on purpose — but a run in which nothing passed checked nothing.
  if (!results.some((r) => r.status === "passed")) return "warning";
  return "healthy";
}

/** The sentence the Synthetic Journeys page prints under a check that skipped itself. */
export function skippedOnPurposeNote(skipReason: string): string {
  return `Skipped on purpose: ${skipReason.trim()}`;
}
