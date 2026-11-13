import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createStepBudget, runStep, summarizeTimings } from "../src/lib/notifications/step-runner.ts";

function src(p: string) {
  return readFileSync(p, "utf8");
}

export async function runNotificationStepRunnerTests() {
  // 1. Success path: returns the value and records an "ok" timing.
  {
    const budget = createStepBudget({ totalBudgetMs: 60_000, perStepMs: 30_000 });
    const value = await runStep("ok-step", async () => 42, budget, { fallback: -1 });
    assert.equal(value, 42);
    assert.equal(budget.timings.length, 1);
    assert.equal(budget.timings[0].step, "ok-step");
    assert.equal(budget.timings[0].status, "ok");
  }

  // 2. Error path: returns the fallback, records "error", invokes onError with the cause.
  {
    const budget = createStepBudget({ totalBudgetMs: 60_000, perStepMs: 30_000 });
    let captured: unknown = null;
    const value = await runStep(
      "bad-step",
      async () => {
        throw new Error("boom");
      },
      budget,
      { fallback: "fallback-value", onError: (e) => { captured = e; } },
    );
    assert.equal(value, "fallback-value");
    assert.equal(budget.timings[0].status, "error");
    assert.ok(captured instanceof Error && captured.message === "boom");
  }

  // 3. Timeout path: a step that never resolves is bounded by the per-step cap and yields
  //    the fallback with a "timeout" status — the chain is never blocked (the outage fix).
  {
    const budget = createStepBudget({ totalBudgetMs: 60_000, perStepMs: 20 });
    const value = await runStep(
      "hang-step",
      () => new Promise<string>(() => {}), // never resolves
      budget,
      { fallback: "bounded" },
    );
    assert.equal(value, "bounded");
    assert.equal(budget.timings[0].status, "timeout");
  }

  // 4. Global deadline: once elapsed, a step is skipped instantly without running its thunk,
  //    so the handler always returns before the request cap even if many steps remain.
  {
    let clock = 1_000_000;
    const budget = createStepBudget({ totalBudgetMs: 0, perStepMs: 30_000, now: () => clock });
    clock += 5; // now strictly past the (zero-length) budget deadline
    let ran = false;
    const value = await runStep(
      "past-deadline",
      async () => {
        ran = true;
        return "should-not-run";
      },
      budget,
      { fallback: "skipped-fallback" },
    );
    assert.equal(value, "skipped-fallback");
    assert.equal(ran, false, "thunk must not run once past the deadline");
    assert.equal(budget.timings[0].status, "skipped");
  }

  // 5. No-fallback overload returns undefined on timeout (used for the never-throw steps).
  {
    const budget = createStepBudget({ totalBudgetMs: 60_000, perStepMs: 20 });
    const value = await runStep("hang-nofallback", () => new Promise<number>(() => {}), budget);
    assert.equal(value, undefined);
    assert.equal(budget.timings[0].status, "timeout");
  }

  // 6. summarizeTimings marks non-ok statuses and includes the total.
  {
    const summary = summarizeTimings(
      [
        { step: "a", ms: 5, status: "ok" },
        { step: "b", ms: 30000, status: "timeout" },
      ],
      30010,
    );
    assert.match(summary, /a=5ms/);
    assert.match(summary, /b=30000ms\(timeout\)/);
    assert.match(summary, /finished in 30010ms/);
  }

  // 7. Handler wiring: the cron enforces a budget + overlap guard around its steps, and
  //    still references the real domain functions (guards against an accidental drop).
  {
    const handler = src("src/lib/notifications/scheduled-processing.ts");
    assert.match(handler, /createStepBudget\(/, "handler builds a step budget");
    assert.match(handler, /runStep\(/, "handler runs steps through the bounded runner");
    assert.match(handler, /createExclusiveRunGuard\(/, "handler has an overlap guard, shared across instances through the job lease (REC-083)");
    assert.match(handler, /ttlMs: OVERLAP_LOCK_MS/, "overlap guard self-heals: the lease runs out after OVERLAP_LOCK_MS");
    assert.doesNotMatch(handler, /let inFlightStartedAt/, "the per-process module variable must not come back as the guard");
    assert.match(handler, /processNotificationOutbox\(limit\)/);
    assert.match(handler, /processDueProbationReminderEvents\(limit\)/);
  }
}
