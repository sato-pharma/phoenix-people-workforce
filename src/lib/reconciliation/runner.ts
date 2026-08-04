import { classifyReconciliationOutcome, shouldAlert, summarizeReconciliationResults } from "@/lib/reconciliation/compare";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import type {
  ReconciliationCheck,
  ReconciliationCheckResult,
  ReconciliationOutcome,
  ReconciliationReport,
} from "@/lib/reconciliation/types";

/**
 * The engine, deliberately separated from the registry in service.ts: it imports nothing but types
 * and the pure comparison layer, so the verdict logic, the report shaping and the "one bad check
 * must not blind the rest" guarantee can be tested without a database or a Next runtime.
 */

/**
 * Three at a time. Every check reads production Postgres, several of them run heavy aggregates
 * (the SoS dashboard fan-out, the payroll batch sweep), and the 8s statement timeout is shared —
 * firing sixteen at once would make the harness the thing that breaks the database it is watching.
 */
const DEFAULT_CONCURRENCY = 3;

/**
 * A check that hangs must not take the cron with it. The route's maxDuration is 300s, so a
 * per-check ceiling well under that leaves room for the remaining checks plus the notification.
 */
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

/**
 * The ceiling for the WHOLE run, which the per-check ceiling alone cannot give.
 *
 * Sixteen checks, three at a time, at 60s each is six waves — up to 360s, past the route's own
 * 300s maxDuration. The platform would then kill the request mid-run and the night would produce
 * no report and no alert at all: the harness would go silent in exactly the situation it exists to
 * announce. Bounding the run below maxDuration leaves room for the notification and turns "we ran
 * out of time" into a recorded, alerting result instead of a dead request.
 */
const DEFAULT_RUN_BUDGET_MS = 240_000;

export type RunReconciliationOptions = {
  concurrency?: number;
  timeoutMs?: number;
  runBudgetMs?: number;
};

/** Every time the owner reads is Cairo local time — a raw UTC stamp makes him do the arithmetic. */
function cairoNowLabel(): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date());
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Runs one check and ALWAYS returns a result.
 *
 * A thrown check is recorded as "errored", never rethrown: one broken check must not blind the
 * other fifteen, and an error is itself a finding — "we could not tell" is the state this harness
 * exists to stop mistaking for "everything is fine". `holds` stays null rather than false so a
 * failure to measure can never be read as a passing measurement.
 */
async function runOne(
  check: ReconciliationCheck,
  timeoutMs: number,
  deadline: number,
): Promise<ReconciliationCheckResult> {
  const startedAt = Date.now();
  const base = {
    id: check.id,
    title: check.title,
    domain: check.domain,
    severity: check.severity,
    expectation: check.expectation,
  };

  // A check must never be given more time than the whole run has left, or the last wave would push
  // the request past maxDuration and lose every earlier finding with it.
  const remaining = deadline - startedAt;
  if (remaining <= 0) {
    return {
      ...base,
      status: "errored",
      holds: null,
      left: null,
      right: null,
      detail:
        "This check was never run: the reconciliation run hit its overall time budget first, so nothing about it is confirmed.",
      durationMs: 0,
      error: "Run budget exhausted before this check started.",
    };
  }

  try {
    const budget = Math.min(timeoutMs, remaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Check exceeded ${Math.round(budget / 1000)}s and was abandoned.`)), budget);
    });
    let outcome: ReconciliationOutcome;
    try {
      outcome = await Promise.race([check.run(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return {
      ...base,
      status: classifyReconciliationOutcome(check.expectation, outcome.holds),
      holds: outcome.holds,
      left: outcome.left,
      right: outcome.right,
      detail:
        outcome.holds || check.expectation !== "known-open"
          ? outcome.detail
          : `${outcome.detail} — known open defect: ${check.openDefect ?? "documented on the check"}`,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      status: "errored",
      holds: null,
      left: null,
      right: null,
      detail: `This check could not be answered, so nothing about it is confirmed: ${errorMessage(error)}`,
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

/**
 * Runs a list of checks with bounded concurrency and returns a structured report. Never throws:
 * every failure mode a check can have is already turned into a recorded result by runOne above.
 */
export async function runReconciliationCheckList(
  checks: readonly ReconciliationCheck[],
  options: RunReconciliationOptions = {},
): Promise<ReconciliationReport> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1_000, options.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS);

  const results = await mapWithConcurrency(checks, concurrency, (check) => runOne(check, timeoutMs, deadline));

  const counts = summarizeReconciliationResults(results);
  return {
    generatedAt: cairoNowLabel(),
    durationMs: Date.now() - startedAt,
    counts,
    alerting: shouldAlert(counts),
    results,
  };
}

/**
 * The alert body. Leads with what a human must do, names every breach in full, and states the
 * known-open findings separately so a persistent, already-understood defect never reads as a new
 * emergency.
 */
export function buildReconciliationAlertMessage(report: ReconciliationReport): string {
  const lines: string[] = [];
  const breaches = report.results.filter((result) => result.status === "breached");
  const errored = report.results.filter((result) => result.status === "errored");
  const knownOpen = report.results.filter((result) => result.status === "known-open");

  lines.push(`⚠️ Reconciliation breach — ${report.generatedAt} Cairo`);
  lines.push("");
  lines.push(
    `${breaches.length} of ${report.counts.total} checks disagree with themselves${errored.length > 0 ? `, and ${errored.length} could not be answered` : ""}.`,
  );

  for (const result of [...breaches, ...errored]) {
    lines.push("");
    lines.push(`• ${result.title}`);
    if (result.left && result.right) {
      lines.push(`  Screen: ${result.left.value}`);
      lines.push(`  Actual: ${result.right.value}`);
    }
    lines.push(`  ${result.detail}`);
  }

  if (knownOpen.length > 0) {
    lines.push("");
    lines.push(`Already known and unchanged: ${knownOpen.map((result) => result.title).join("; ")}`);
  }

  lines.push("");
  lines.push("Full report → /api/cron/reconciliation-check");
  return lines.join("\n");
}
