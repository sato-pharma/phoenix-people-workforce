// Per-step timing + timeout budget for the multi-step notification-processing cron.
//
// runScheduledNotificationProcessing runs ~13 steps serially under Cloud Run's 300s
// request cap. With no budget, a single slow or hung step — e.g. an unbounded external
// call — blocks the whole chain, the handler never returns, and the request 504s at
// 300s. That is exactly the 2026-07-15 outage: every 5-minute invocation timed out for
// ~20h. This runner:
//   • bounds each step with a soft per-step cap (Promise.race) so one bad step cannot
//     consume the whole window;
//   • enforces a global deadline (via the shrinking per-step cap) so the handler always
//     returns before the request cap;
//   • records per-step timing so the slow step is visible in Cloud Run logs.
//
// It never throws: a timed-out or failing step records its outcome and yields the
// caller's fallback, so the rest of the chain still runs. Every step in this cron is
// idempotent, so skipping one for a run is safe — it simply retries next run.
//
// Note: a soft cap does not CANCEL the underlying work (JS promises aren't cancellable);
// it stops the step from BLOCKING the chain. The abandoned promise settles on its own,
// and because Promise.race attaches handlers to it, a late rejection is not unhandled.

import { logError } from "@/lib/observability/log";
import { trackJob } from "@/lib/observability/running-jobs";

export type StepStatus = "ok" | "timeout" | "error" | "skipped";
export type StepTiming = { step: string; ms: number; status: StepStatus };

export type StepBudget = {
  readonly timings: StepTiming[];
  /** Epoch-ms after which remaining steps are skipped (backstop below the request cap). */
  readonly deadlineAt: number;
  /** Per-step soft cap in ms. */
  readonly perStepMs: number;
  /** Clock source (injectable for tests). */
  readonly now: () => number;
};

export function createStepBudget(opts: {
  totalBudgetMs: number;
  perStepMs: number;
  now?: () => number;
}): StepBudget {
  const now = opts.now ?? Date.now;
  return { timings: [], deadlineAt: now() + opts.totalBudgetMs, perStepMs: opts.perStepMs, now };
}

type RunStepOptions<T> = { fallback?: T; onError?: (error: unknown) => void };

const TIMED_OUT = Symbol("timed-out");

// With a fallback, always resolves to T. Without one, resolves to T | undefined
// (undefined only on timeout/error, which for the never-throw steps is a theoretical edge).
export function runStep<T>(
  name: string,
  thunk: () => Promise<T>,
  budget: StepBudget,
  options: RunStepOptions<T> & { fallback: T },
): Promise<T>;
export function runStep<T>(
  name: string,
  thunk: () => Promise<T>,
  budget: StepBudget,
  options?: RunStepOptions<T>,
): Promise<T | undefined>;
export async function runStep<T>(
  name: string,
  thunk: () => Promise<T>,
  budget: StepBudget,
  options: RunStepOptions<T> = {},
): Promise<T | undefined> {
  const start = budget.now();
  const remaining = budget.deadlineAt - start;
  if (remaining <= 0) {
    // Past the global deadline — skip instantly so the handler can return in time.
    budget.timings.push({ step: name, ms: 0, status: "skipped" });
    return options.fallback;
  }
  const cap = Math.min(budget.perStepMs, remaining);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race<{ value: T } | { error: unknown } | typeof TIMED_OUT>([
      // Registered so the process-health stall line can name the step that froze the server.
      trackJob(`cron:process:${name}`, thunk).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), cap);
      }),
    ]);
    const ms = budget.now() - start;

    if (outcome === TIMED_OUT) {
      budget.timings.push({ step: name, ms, status: "timeout" });
      console.warn(`[cron:process] step "${name}" exceeded ${cap}ms cap — skipped this run, continuing`);
      return options.fallback;
    }
    if ("error" in outcome) {
      budget.timings.push({ step: name, ms, status: "error" });
      if (options.onError) options.onError(outcome.error);
      else {
        logError(`Notification-processing cron step "${name}" failed`, {
          labels: { event: "cron_step_failed", step: name, duration_ms: ms },
          error: outcome.error,
        });
      }
      return options.fallback;
    }
    budget.timings.push({ step: name, ms, status: "ok" });
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One-line run summary for Cloud Run logs — surfaces the slow step. */
export function summarizeTimings(timings: StepTiming[], totalMs: number): string {
  const parts = timings.map((t) => `${t.step}=${t.ms}ms${t.status === "ok" ? "" : `(${t.status})`}`);
  return `[cron:process] finished in ${totalMs}ms — ${parts.join(" ")}`;
}
