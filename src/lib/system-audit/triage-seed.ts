import type { SystemAuditStatus } from "@/lib/system-audit/types";

/**
 * THE REVIEWED TRIAGE SEED — statuses a person has already proven, applied once by the historical
 * runner (`scripts/system-audit-historical.ts --apply`) with the actor `seed:<short sha>`.
 *
 * IT IS EMPTY, AND IT STAYS EMPTY UNTIL A PERSON HAS REVIEWED EACH ENTRY AGAINST EVIDENCE.
 *
 * Every issue the historical run finds starts where the detectors put it: INVESTIGATING, or NOT
 * FIXED with a probable cause for a documented open defect. An entry here moves one issue on, and
 * the ledger's own rules still apply to it:
 *
 *   - FIXED — VERIFIED needs `evidence` (the re-measurement that proved it) and a `fixSha` that is a
 *     full 40-character commit; a fix from before `release_gates` existed (2026-10-19) also needs
 *     `fixLiveAt`, its merge time, because the gate table cannot supply it.
 *   - FIX IMPLEMENTED needs the `fixSha`.
 *   - NO DEFECT and UNKNOWN need a `reason`.
 *
 * WHY NOT FILL IT FROM GIT HISTORY OR FROM THE OLD "RESOLVED" FLAG. `app_error_events.resolved`
 * was derived from deploys, not from anything re-measured, and a commit message that says "fix" is a
 * claim, not a proof. Seeding either would print FIXED — VERIFIED against issues nobody verified —
 * the exact false comfort this audit replaces. So nothing is guessed: an entry is added here, in a
 * reviewed pull request, only with the evidence beside it.
 */

export type TriageSeedEntry = {
  /** The issue's signature key, exactly as the ledger stores it (`recon:<check-id>`, `job:<slug>:failing`, …). */
  signatureKey: string;
  to: SystemAuditStatus;
  reason: string;
  fixSha?: string;
  /** ISO instant the fix went live; only for a fix older than the release gate table. */
  fixLiveAt?: string;
  /** What proves it — required for FIXED — VERIFIED. */
  evidence?: Record<string, unknown>;
};

export const TRIAGE_SEED: readonly TriageSeedEntry[] = [];

/** Pure: the entries the ledger would refuse, with why — checked before anything is applied. */
export function triageSeedProblems(entries: readonly TriageSeedEntry[] = TRIAGE_SEED): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.signatureKey || "(no signature)";
    if (!entry.signatureKey) problems.push(`${name}: no signature key`);
    if (seen.has(entry.signatureKey)) problems.push(`${name}: listed twice`);
    seen.add(entry.signatureKey);
    if (!entry.reason?.trim()) problems.push(`${name}: no reason`);
    if (entry.fixSha !== undefined && !/^[0-9a-f]{40}$/.test(entry.fixSha)) problems.push(`${name}: the fix commit is not a full 40-character sha`);
    if ((entry.to === "fix_implemented" || entry.to === "fixed_verified") && !entry.fixSha) {
      problems.push(`${name}: ${entry.to === "fixed_verified" ? "FIXED — VERIFIED" : "FIX IMPLEMENTED"} needs the fix commit`);
    }
    if (entry.to === "fixed_verified" && (!entry.evidence || Object.keys(entry.evidence).length === 0)) {
      problems.push(`${name}: FIXED — VERIFIED needs the evidence that proved it`);
    }
    if (entry.fixLiveAt !== undefined && !Number.isFinite(Date.parse(entry.fixLiveAt))) problems.push(`${name}: fixLiveAt is not a time`);
  }
  return problems;
}
