// Unified Deductions module: orchestrates all 5 automated connectors for one
// month into the candidate ledger. Loan/Other are excluded here — those are
// one-at-a-time HR entries (see connectors/manual.ts + service.ts's
// insertCandidateDrafts with autoDecideStatus), not a company-wide scan.
//
// Work is exposed one connector at a time on purpose. Running all five inside a
// single HTTP request is what got the first cut of this module reverted (#1377):
// each connector is a company-wide scan, nothing bounded how slow they were
// together, and the request burned the full 300s Cloud Run limit and was killed.
// Callers that face a request timeout must drive `DEDUCTION_COLLECTORS`
// one at a time via `collectOneConnectorForMonth`.

import { currentCairoDateParts } from "@/lib/i18n/format";

import { collectFingerprintCandidates } from "./connectors/fingerprint.ts";
import { collectDsmNoRecordCandidates } from "./connectors/dsm-no-record.ts";
import { collectHolidayBridgeCandidates } from "./connectors/holiday-bridge.ts";
import { collectCrmCandidates } from "./connectors/crm.ts";
import {
  collectInsufficientBalanceVacationCandidates,
  collectUnpaidVacationCandidates,
} from "./connectors/vacation.ts";
import { insertCandidateDrafts, type CandidateDraftInsertResult } from "./service.ts";

export type DeductionCollectorKey =
  | "fingerprint"
  | "crm"
  | "no_records_activity"
  | "unpaid_vacation"
  | "insufficient_balance_vacation"
  | "dsm_no_record"
  | "holiday_bridge";

export type MonthlyCollectionResult = Record<DeductionCollectorKey, CandidateDraftInsertResult>;

type CollectorInput = { month: number; year: number; createdBy: string };

type Collector = {
  key: DeductionCollectorKey;
  label: string;
  run: (input: CollectorInput) => Promise<Awaited<ReturnType<typeof collectFingerprintCandidates>>>;
};

/**
 * The automated connectors, in the order they should be run. Exported so the
 * admin UI can drive them one request at a time and show per-connector progress.
 */
export const DEDUCTION_COLLECTORS: readonly Collector[] = [
  { key: "fingerprint", label: "Fingerprint attendance report", run: collectFingerprintCandidates },
  { key: "crm", label: "CRM no-activity", run: collectCrmCandidates },
  // no_records_activity is NOT here. Its connector has no population left: the field
  // workforce belongs to `crm`, and Head Office has no CRM obligation, which between
  // them is everybody. Leaving it registered made the collection UI offer a step that
  // always reports "created=0" and the workspace render a permanently empty category —
  // an operator cannot tell that apart from a broken connector. The category constant
  // and its historical rows stay untouched; only the live collection step is retired.
  { key: "unpaid_vacation", label: "Unpaid Vacation", run: collectUnpaidVacationCandidates },
  { key: "insufficient_balance_vacation", label: "Insufficient Balance Vacation", run: collectInsufficientBalanceVacationCandidates },
  // After the four that own their own populations, before holiday_bridge. Like
  // holiday_bridge it dedups against the live ledger, so it must not run before
  // the categories whose days it needs to avoid.
  { key: "dsm_no_record", label: "District manager CRM no-record days", run: collectDsmNoRecordCandidates },
  // LAST on purpose. Its dedup reads the live ledger to skip any employee-day
  // another category already charges, so it must run after those categories
  // have been written — running it first would find an empty ledger and
  // manufacture the exact duplicates the rule forbids.
  { key: "holiday_bridge", label: "Governmental-holiday bridging", run: collectHolidayBridgeCandidates },
];

const COLLECTORS_BY_KEY = new Map(DEDUCTION_COLLECTORS.map((collector) => [collector.key, collector]));

export function isDeductionCollectorKey(value: unknown): value is DeductionCollectorKey {
  return typeof value === "string" && COLLECTORS_BY_KEY.has(value as DeductionCollectorKey);
}

/**
 * Refuses to collect a month that has not finished.
 *
 * Owner's rule (2026-08-03), and it is not theoretical: collecting an in-progress
 * month happened three times in one day and every time it charged people for days
 * that had not ended. On 3 August a run produced 72 candidates covering 1-3
 * August — 69 of them CRM, which is mandatory-unless-cleared and publishes with
 * NO approval step — for 39,225.73 EGP. An earlier pair of accidental runs added
 * 28 more. All were withdrawn, but only because somebody noticed.
 *
 * A no-activity day is only meaningful once the day is over. Judging today, or a
 * day still to come, is not a strict rule — it is a wrong one.
 *
 * CAIRO boundaries, not UTC. The deductions page already seeds its month key from
 * `currentCairoDateParts` for exactly this reason: in the first two or three hours
 * of a Cairo month a UTC clock still reads the previous month, so a UTC guard
 * would wave through the very window it exists to block.
 *
 * Exported so callers and tests can ask the question without triggering a run.
 */
export function isCollectableMonth(input: { month: number; year: number }): boolean {
  const { month, year } = currentCairoDateParts();
  // Strictly earlier than the current Cairo month. A future month is refused too:
  // there is nothing to detect, and collecting one would create candidates for
  // days nobody has worked yet.
  return input.year < year || (input.year === year && input.month < month);
}

/**
 * Runs exactly one connector for one month and inserts whatever's new into
 * deductions_candidates. The connector's own idempotency probe means re-running
 * this for the same month and connector is always safe — already-live
 * candidates are skipped, not duplicated.
 *
 * A connector that throws is reported as a warning rather than propagated, so a
 * caller stepping through all five gets the same "one failure does not stop the
 * others" isolation the single-shot version had.
 */
export async function collectOneConnectorForMonth(
  input: CollectorInput & { connector: DeductionCollectorKey },
): Promise<CandidateDraftInsertResult> {
  const collector = COLLECTORS_BY_KEY.get(input.connector);
  if (!collector) {
    throw new Error(`Validation: unknown deductions connector "${input.connector}".`);
  }

  // Before anything reads source data. THROWS rather than returning an empty
  // result: "created 0" is indistinguishable from "nobody qualified", and this
  // needs to be unmissable.
  if (!isCollectableMonth(input)) {
    const cairo = currentCairoDateParts();
    throw new Error(
      `Validation: ${String(input.month).padStart(2, "0")}/${input.year} has not finished — collection only runs on a completed month. ` +
        `Today is ${String(cairo.month).padStart(2, "0")}/${cairo.year} in Cairo. Collecting an in-progress month charges people for days that have not ended, ` +
        `and CRM candidates publish without an approval step.`,
    );
  }

  const { month, year, createdBy } = input;
  try {
    const drafts = await collector.run({ month, year, createdBy });
    return await insertCandidateDrafts({ createdBy, drafts, sourceLabel: collector.label });
  } catch (error) {
    return {
      created: 0,
      skippedExisting: 0,
      warnings: [`${collector.label}: connector failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Runs every automated connector for one month, sequentially.
 *
 * NOT safe to call from an HTTP request handler — the five company-wide scans
 * together exceed the 300s Cloud Run request limit on production-sized data.
 * This exists for server-side batch callers that have no request deadline;
 * anything request-bound must step through `DEDUCTION_COLLECTORS` with
 * `collectOneConnectorForMonth` instead.
 */
export async function collectAllCandidatesForMonth(input: CollectorInput): Promise<MonthlyCollectionResult> {
  const results = {} as MonthlyCollectionResult;
  for (const collector of DEDUCTION_COLLECTORS) {
    results[collector.key] = await collectOneConnectorForMonth({ ...input, connector: collector.key });
  }
  return results;
}
