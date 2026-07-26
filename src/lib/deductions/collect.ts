// Unified Deductions module: orchestrates all 5 automated connectors for one
// month into the candidate ledger. Loan/Other are excluded here — those are
// one-at-a-time HR entries (see connectors/manual.ts + service.ts's
// insertCandidateDrafts with autoDecideStatus), not a company-wide scan.

import { collectFingerprintCandidates } from "./connectors/fingerprint.ts";
import { collectCrmCandidates } from "./connectors/crm.ts";
import { collectNoRecordsActivityCandidates } from "./connectors/no-records-activity.ts";
import {
  collectInsufficientBalanceVacationCandidates,
  collectUnpaidVacationCandidates,
} from "./connectors/vacation.ts";
import { insertCandidateDrafts, type CandidateDraftInsertResult } from "./service.ts";

export type MonthlyCollectionResult = Record<
  "fingerprint" | "crm" | "no_records_activity" | "unpaid_vacation" | "insufficient_balance_vacation",
  CandidateDraftInsertResult
>;

/**
 * Runs every automated connector for one month and inserts whatever's new
 * into deductions_candidates (each connector's own idempotency probe means
 * re-running this for the same month is always safe — already-live
 * candidates are skipped, not duplicated). Each connector is isolated: one
 * failing does not stop the others.
 */
export async function collectAllCandidatesForMonth(input: {
  month: number;
  year: number;
  createdBy: string;
}): Promise<MonthlyCollectionResult> {
  const jobs: Array<{
    key: keyof MonthlyCollectionResult;
    label: string;
    run: () => Promise<Awaited<ReturnType<typeof collectFingerprintCandidates>>>;
  }> = [
    { key: "fingerprint", label: "Fingerprint attendance report", run: () => collectFingerprintCandidates(input) },
    { key: "crm", label: "CRM no-activity", run: () => collectCrmCandidates(input) },
    { key: "no_records_activity", label: "No Records Activity (Private Calendar)", run: () => collectNoRecordsActivityCandidates(input) },
    { key: "unpaid_vacation", label: "Unpaid Vacation", run: () => collectUnpaidVacationCandidates(input) },
    { key: "insufficient_balance_vacation", label: "Insufficient Balance Vacation", run: () => collectInsufficientBalanceVacationCandidates(input) },
  ];

  // Connectors run CONCURRENTLY. Run sequentially, the five company-wide scans summed past
  // Cloud Run's 300s request ceiling and this endpoint 504'd — observed on staging
  // 2026-07-26 with httpRequest.latency exactly 300.001338024s, i.e. killed by the platform
  // rather than failing on its own. Concurrency makes wall-clock the slowest SINGLE connector
  // instead of the sum of all five.
  //
  // Each job keeps its own try/catch, so one connector failing still cannot take down the
  // others — that isolation is why this is Promise.all over already-safe thunks rather than
  // Promise.allSettled.
  //
  // The per-connector timing log is deliberate and load-bearing, not debug leftovers: if the
  // ceiling is still exceeded, these lines are what identify WHICH connector to fix. Without
  // them a timeout tells you only that the total was too slow, which is how this landed in
  // review as a guess ("crm.ts looks big") instead of a measurement.
  const settled = await Promise.all(
    jobs.map(async (job): Promise<[keyof MonthlyCollectionResult, CandidateDraftInsertResult]> => {
      const startedAt = Date.now();
      try {
        const drafts = await job.run();
        const result = await insertCandidateDrafts({
          createdBy: input.createdBy,
          drafts,
          sourceLabel: job.label,
        });
        console.log(`[deductions:collect] ${job.key} ok in ${Date.now() - startedAt}ms (created=${result.created} skipped=${result.skippedExisting})`);
        return [job.key, result];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[deductions:collect] ${job.key} FAILED in ${Date.now() - startedAt}ms: ${message}`);
        return [
          job.key,
          {
            created: 0,
            skippedExisting: 0,
            warnings: [`${job.label}: connector failed: ${message}`],
          },
        ];
      }
    }),
  );
  return Object.fromEntries(settled) as MonthlyCollectionResult;
}
