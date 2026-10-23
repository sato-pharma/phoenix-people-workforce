import { appErrorFoldDetector } from "@/lib/system-audit/detectors/app-error-fold";
import { dataLinkageDetector } from "@/lib/system-audit/detectors/data-linkage";
import { jobFailuresDetector } from "@/lib/system-audit/detectors/job-failures";
import { syncRunsDetector } from "@/lib/system-audit/detectors/sync-runs";
import { userScreensDetector } from "@/lib/system-audit/detectors/user-screens";
import { createVerifierDetector } from "@/lib/system-audit/detectors/verifier";
import { visitLifecycleDetector } from "@/lib/system-audit/detectors/visit-lifecycle";
import { RECONCILIATION_DETECTOR } from "@/lib/system-audit/reconciliation-ledger";
import type { AuditDetector, SystemAuditFamily } from "@/lib/system-audit/types";

/**
 * The nightly sweep's detectors, IN THE ORDER THEY RUN — one at a time, never in parallel.
 *
 *   1. app_error_fold   the errors people were shown — the newest evidence, and the biggest table,
 *                       so it goes first while the time budget is whole.
 *   2. user_screens     the screenshots of every error or block a person met (owner, 23 Oct 2026),
 *                       then the 90-day retention of those pictures — at most 500 a night.
 *   3. sync_runs        iReports360 pulls that failed or never finished.
 *   4. job_failures     scheduled jobs that stopped or reported failure, and failed queued exports.
 *   5. data_linkage     logins, fingerprint users and seats that point at nothing or the wrong thing.
 *   6. visit_lifecycle  field visits that were not carried through to the screens that consume them.
 *   7. verifier         LAST, so a recurrence any of the six found tonight reopens its issue tonight.
 *
 * The nightly integrity checks are NOT here: they run on their own at 04:40 Cairo and write through
 * reconciliation-ledger.ts, seventeen minutes before this sweep starts.
 */

export const FINDING_DETECTORS: readonly AuditDetector[] = [
  appErrorFoldDetector,
  userScreensDetector,
  syncRunsDetector,
  jobFailuresDetector,
  dataLinkageDetector,
  visitLifecycleDetector,
];

/** Which detector re-measures each family — what the verifier counts clean nights against. */
export function detectorIdByFamily(detectors: readonly AuditDetector[] = FINDING_DETECTORS): Partial<Record<SystemAuditFamily, string>> {
  const map: Partial<Record<SystemAuditFamily, string>> = { reconciliation: RECONCILIATION_DETECTOR };
  for (const detector of detectors) map[detector.family] = detector.id;
  return map;
}

export const SWEEP_DETECTORS: readonly AuditDetector[] = [
  ...FINDING_DETECTORS,
  createVerifierDetector({ detectorIdByFamily: detectorIdByFamily() }),
];
