import { reconciliationChecks } from "@/lib/reconciliation/checks";
import { runReconciliationCheckList, type RunReconciliationOptions } from "@/lib/reconciliation/runner";
import type { ReconciliationCheck, ReconciliationReport } from "@/lib/reconciliation/types";

export { buildReconciliationAlertMessage } from "@/lib/reconciliation/runner";
export type { RunReconciliationOptions } from "@/lib/reconciliation/runner";

/**
 * Runs every reconciliation check with bounded concurrency and returns a structured report.
 *
 * Never throws — a failing check is a recorded result, not an exception, so one broken check
 * cannot blind the other twenty-one. Read-only by design: nothing here writes to the database,
 * because a harness that mutated while measuring could not be trusted to be measuring what the
 * users actually see, and it must stay safe to run at any hour against production.
 */
export async function runReconciliationChecks(
  options: RunReconciliationOptions & { checks?: readonly ReconciliationCheck[] } = {},
): Promise<ReconciliationReport> {
  return runReconciliationCheckList(options.checks ?? reconciliationChecks, options);
}
