import { VerifierInputUnreadable, createDatabaseVerifierStore, runVerifier, type VerifierStore } from "@/lib/system-audit/verifier";
import {
  emptyDetectorResult,
  type AuditDetector,
  type DetectorContext,
  type DetectorResult,
  type SystemAuditFamily,
} from "@/lib/system-audit/types";

/**
 * The verifier as the LAST detector of the nightly sweep — after every other detector has written
 * tonight's findings, so a recurrence found tonight reopens its issue tonight, not tomorrow.
 *
 * It writes no findings. It changes STATUSES, through system_audit_transition_status as
 * `system:verifier`, which is why it refuses to run against a file sink: a dry run that rewrote the
 * ledger's statuses would not be a dry run. The historical runner leaves it out for the same reason.
 */

export const VERIFIER_DETECTOR = "verifier";

export type VerifierDetectorDeps = {
  /** Which detector re-measures each family — built from the sweep's own list, never hardcoded. */
  detectorIdByFamily: Partial<Record<SystemAuditFamily, string>>;
  store?: VerifierStore;
};

export function createVerifierDetector(deps: VerifierDetectorDeps): AuditDetector {
  return {
    id: VERIFIER_DETECTOR,
    // The family it serves is "every family"; the contract wants one, and the verifier writes no row
    // under it, so the label it carries here is never shown against a finding.
    family: "app_error",
    version: 1,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      if (ctx.sink.kind !== "database") {
        const skipped = emptyDetectorResult("skipped");
        skipped.report = { reason: "The verifier changes statuses in the ledger, so it never runs against a file." };
        return skipped;
      }
      const result = emptyDetectorResult();
      const store = deps.store ?? createDatabaseVerifierStore();
      let outcome;
      try {
        outcome = await runVerifier({
          store,
          nowMs: ctx.now(),
          now: ctx.now,
          deadline: ctx.deadline,
          detectorIdByFamily: deps.detectorIdByFamily,
        });
      } catch (error) {
        // Only the standing fixes or the release table being unreadable lands here, and then
        // NOTHING was decided.
        result.status = "errored";
        result.unreadableSources = [error instanceof VerifierInputUnreadable ? error.source : "system_audit_issues"];
        result.error = `Nothing was verified or reopened tonight: ${error instanceof Error ? error.message : String(error)}`;
        return result;
      }
      result.scanned = outcome.reviewed;
      result.unreadableSources = outcome.unreadable;
      if (outcome.budgetExhausted) result.status = "budget_exhausted";
      else if (outcome.unreadable.length > 0) result.status = "partial";
      result.report = {
        reopened: outcome.reopened,
        // A verified fix that recurred is the strongest signal this page can give; it is called out
        // by itself rather than left inside the reopened list.
        reopenedAfterVerification: outcome.reopened.filter((row) => row.wasVerified).length,
        verified: outcome.verified,
        waiting: outcome.waiting,
        olderBuildRows: outcome.olderBuildRows,
      };
      return result;
    },
  };
}
