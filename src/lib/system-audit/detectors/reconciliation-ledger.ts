import type { ReconciliationReport } from "@/lib/reconciliation/types";
import {
  RECONCILIATION_DETECTOR,
  createDatabaseRunStore,
  createMemoryRunStore,
  recordReconciliationRun,
  type ReconciliationRunStore,
} from "@/lib/system-audit/reconciliation-ledger";
import { emptyDetectorResult, type AuditDetector, type DetectorContext, type DetectorResult } from "@/lib/system-audit/types";

/**
 * The nightly integrity checks as a detector — for the HISTORICAL runner and manual runs only.
 *
 * NOT in the nightly sweep. The checks already run on their own at 04:40 Cairo
 * (/api/cron/reconciliation-check), which stores the report and writes its findings through
 * recordReconciliationRun; running them again at 04:57 would measure production twice for nothing.
 * The historical runner has no stored past to replay — the report was never kept before the ledger —
 * so it runs the checks ONCE, as of now, and that night becomes the first stored run.
 *
 * This detector records its OWN run row (recordReconciliationRun does, with the whole report on it),
 * so a caller must not open a second one for it: `RECORDS_OWN_RUN` says so. Writing through a FILE
 * sink keeps the run in memory as well, so a dry run writes nothing anywhere.
 */

export const RECONCILIATION_RECORDS_OWN_RUN = true;

export type ReconciliationDetectorDeps = {
  /** Runs the checks. Injected so the detector can be tested without a database. */
  runChecks?: () => Promise<ReconciliationReport>;
  runStore?: ReconciliationRunStore;
};

async function defaultRunChecks(): Promise<ReconciliationReport> {
  // Imported lazily: the check registry pulls every domain service in, which a test of the adapter
  // (and the sweep, which never runs this) should not have to load.
  const { runReconciliationChecks } = await import("@/lib/reconciliation/service");
  return runReconciliationChecks();
}

export function createReconciliationDetector(deps: ReconciliationDetectorDeps = {}): AuditDetector & {
  readonly recordsOwnRun: true;
} {
  const runChecks = deps.runChecks ?? defaultRunChecks;
  return {
    id: RECONCILIATION_DETECTOR,
    family: "reconciliation",
    version: 1,
    recordsOwnRun: true,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const report = await runChecks();
      const runStore = deps.runStore ?? (ctx.sink.kind === "file" ? createMemoryRunStore() : createDatabaseRunStore());
      const recorded = await recordReconciliationRun(report, {
        sink: ctx.sink,
        runStore,
        mode: ctx.mode,
        now: new Date(ctx.now()),
      });
      const result = emptyDetectorResult(recorded.status);
      result.scanned = report.results.length;
      result.inserted = recorded.inserted;
      result.updated = recorded.updated;
      result.unreadableSources = recorded.notMeasured.map((id) => `reconciliation:${id}`);
      result.report = {
        runId: recorded.runId,
        breached: report.counts.breached,
        knownOpen: report.counts.knownOpen,
        notMeasured: recorded.notMeasured,
      };
      return result;
    },
  };
}

export const reconciliationDetector = createReconciliationDetector();
