import { systemClock, type ReconciliationClock, type ReconciliationTimer } from "@/lib/reconciliation/clock";
import { classifyReconciliationOutcome, shouldAlert, summarizeReconciliationResults } from "@/lib/reconciliation/compare";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import {
  RECONCILIATION_FINDINGS_CAP,
  type ReconciliationCheck,
  type ReconciliationCheckResult,
  type ReconciliationOutcome,
  type ReconciliationReport,
} from "@/lib/reconciliation/types";

/**
 * The engine, deliberately separated from the registry in service.ts: it imports nothing but types
 * and the pure comparison layer, so the verdict logic, the report shaping and the "one bad check
 * must not blind the rest" guarantee can be tested without a database or a Next runtime.
 */

/**
 * Three at a time. Every check reads production Postgres, several of them run heavy aggregates
 * (the SoS dashboard fan-out, the payroll batch sweep), and the 8s statement timeout is shared —
 * firing all twenty-three at once would make the harness the thing that breaks the database it is
 * watching.
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
 * Twenty-two checks, three at a time, at 60s each is eight waves — up to 480s, past the route's own
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
  /**
   * Both ceilings below are rules about elapsed time, and a test that proves them against real
   * timers is racing the machine rather than asserting the rule. Overriding this lets the test
   * advance time by hand; production leaves it alone and gets the system clock.
   */
  clock?: ReconciliationClock;
};

/** Every time the owner reads is Cairo local time — a raw UTC stamp makes him do the arithmetic. */
function cairoNowLabel(nowMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(nowMs));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Runs one check and ALWAYS returns a result.
 *
 * A thrown check is recorded as "errored", never rethrown: one broken check must not blind the
 * others, and an error is itself a finding — "we could not tell" is the state this harness
 * exists to stop mistaking for "everything is fine". `holds` stays null rather than false so a
 * failure to measure can never be read as a passing measurement.
 */
async function runOne(
  check: ReconciliationCheck,
  timeoutMs: number,
  deadline: number,
  clock: ReconciliationClock,
): Promise<ReconciliationCheckResult> {
  const startedAt = clock.now();
  const base = {
    id: check.id,
    title: check.title,
    domain: check.domain,
    severity: check.severity,
    expectation: check.expectation,
    // Carried on every result, not only the known-open ones that print it: the System Audit ledger
    // stores it as the issue's probable root cause, and the stored report names it on its own line.
    ...(check.openDefect ? { openDefect: check.openDefect } : {}),
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
    let timer: ReconciliationTimer | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = clock.setTimeout(() => reject(new Error(`Check exceeded ${Math.round(budget / 1000)}s and was abandoned.`)), budget);
    });
    let outcome: ReconciliationOutcome;
    try {
      outcome = await Promise.race([check.run(), timeout]);
    } finally {
      // Cancelling matters beyond tidiness: a timer left armed behind a check that already answered
      // would reject a race nobody is listening to any more.
      if (timer) timer.cancel();
    }

    // The rows behind a disagreement ride through untouched, capped per check. The cap is stated as
    // a number on the result, so a check with 3,000 affected rows reads "500 shown, 2,500 more",
    // never as a check with 500.
    const findings = Array.isArray(outcome.findings) ? outcome.findings : [];
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
      durationMs: clock.now() - startedAt,
      error: null,
      ...(findings.length > 0
        ? {
            findings: findings.slice(0, RECONCILIATION_FINDINGS_CAP),
            findingsTruncated: Math.max(0, findings.length - RECONCILIATION_FINDINGS_CAP),
          }
        : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: "errored",
      holds: null,
      left: null,
      right: null,
      detail: `This check could not be answered, so nothing about it is confirmed: ${errorMessage(error)}`,
      durationMs: clock.now() - startedAt,
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
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();
  const deadline = startedAt + Math.max(1_000, options.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS);

  // A lane is one unit of work: its checks run one after another in a single slot. Lanes run AFTER every
  // other check has finished, never beside one (owner, 14 Nov 2026: "Run sales months last"). The first
  // night the sales months started first, the two in-app notification checks — 43-45 s on a quiet night —
  // ran out their 60 s while the months loaded closings beside them. Results still come back in registry
  // order.
  const lanes = new Map<string, number[]>();
  const singles: number[][] = [];
  checks.forEach((check, index) => {
    if (!check.lane) {
      singles.push([index]);
      return;
    }
    const lane = lanes.get(check.lane) ?? [];
    lane.push(index);
    lanes.set(check.lane, lane);
  });
  const results = new Array<ReconciliationCheckResult>(checks.length);
  const runUnit = async (unit: number[]) => {
    for (const index of unit) results[index] = await runOne(checks[index], timeoutMs, deadline, clock);
  };
  await mapWithConcurrency(singles, concurrency, runUnit);
  await mapWithConcurrency([...lanes.values()], concurrency, runUnit);

  const counts = summarizeReconciliationResults(results);
  return {
    generatedAt: cairoNowLabel(clock.now()),
    durationMs: clock.now() - startedAt,
    counts,
    alerting: shouldAlert(counts),
    results,
  };
}

/**
 * The whole night in words. Leads with what a human must do, names every breach in full, and
 * states the known-open findings separately so a persistent, already-understood defect never reads
 * as a new emergency.
 *
 * NO LONGER SENT ON ITS OWN. The separate breach notification was retired on 2026-10-23: a breach
 * is now a System Audit issue, and the one daily System Audit message carries it
 * (src/lib/system-audit/daily-message.ts). This text stays for the cron route's response and for
 * anyone reading a stored report by hand.
 */
export function buildReconciliationAlertMessage(report: ReconciliationReport): string {
  const lines: string[] = [];
  const breaches = report.results.filter((result) => result.status === "breached");
  const errored = report.results.filter((result) => result.status === "errored");
  const knownOpen = report.results.filter((result) => result.status === "known-open");

  // The checks that could not be answered are in the TITLE, not only the body: a night where half
  // the checks errored and none breached must not read like a quiet night with one small finding.
  const notAnswered = errored.length > 0 ? `, ${errored.length} could not be answered` : "";
  lines.push(
    `⚠️ Reconciliation breach — ${breaches.length} of ${report.counts.total} checks disagree${notAnswered} — ${report.generatedAt} Cairo`,
  );
  lines.push("");
  lines.push(
    `${breaches.length} of ${report.counts.total} checks disagree with themselves${errored.length > 0 ? `, and ${errored.length} could not be answered` : ""}.`,
  );

  for (const result of [...breaches, ...errored]) {
    lines.push("");
    lines.push(`• ${result.title}`);
    if (result.left && result.right) {
      lines.push(`  Screen: ${result.left.value}`);
      // "Second source", not "Actual": the right side is the same fact derived another way, and it
      // can be the wrong one of the two — calling it the actual figure prejudges the investigation.
      lines.push(`  Second source: ${result.right.value}`);
    }
    lines.push(`  ${result.detail}`);
  }

  if (knownOpen.length > 0) {
    lines.push("");
    lines.push(`Already known and unchanged: ${knownOpen.map((result) => result.title).join("; ")}`);
  }

  lines.push("");
  lines.push("Full report → /admin/system-audit (Integrity checks)");
  return lines.join("\n");
}
