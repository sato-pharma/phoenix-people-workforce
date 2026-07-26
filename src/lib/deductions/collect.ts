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

  const results = {} as MonthlyCollectionResult;
  for (const job of jobs) {
    try {
      const drafts = await job.run();
      results[job.key] = await insertCandidateDrafts({
        createdBy: input.createdBy,
        drafts,
        sourceLabel: job.label,
      });
    } catch (error) {
      results[job.key] = {
        created: 0,
        skippedExisting: 0,
        warnings: [`${job.label}: connector failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
  return results;
}
