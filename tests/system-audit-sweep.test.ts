import assert from "node:assert/strict";

import type { SystemAuditDailyMessageResult } from "../src/lib/system-audit/daily-message.ts";
import {
  PER_DETECTOR_MS,
  RESTART_QUIET_HOURS,
  SWEEP_BUDGET_MS,
  isDatabaseUnhealthy,
  runSystemAuditSweep,
  type SweepDeps,
} from "../src/lib/system-audit/sweep.ts";
import {
  emptyDetectorResult,
  type AuditDetector,
  type DetectorContext,
  type DetectorResult,
  type FindingSink,
} from "../src/lib/system-audit/types.ts";

/**
 * The nightly sweep's guards — all about NOT being the thing that hurts the database it audits:
 * one sweep at a time (a lease), no detectors the night after a database restart, stop at the first
 * sign the database is struggling, and a time budget. Every detector it did not run is RECORDED as
 * not run, never left as a quiet night. The daily message still goes out on a night the detectors
 * sat out; it does not go out from a call that found another sweep already running.
 */

const NOW = Date.parse("2026-10-23T01:57:00.000Z");
const SINK: FindingSink = { kind: "database", write: async () => ({ issues: 0, inserted: 0, updated: 0 }), readCursor: async () => null };
const MESSAGE: SystemAuditDailyMessageResult = { sent: true, candidates: 1, delivered: 1, marked: 1 };

function detector(id: string, run: (ctx: DetectorContext) => Promise<DetectorResult> | DetectorResult, log: string[]): AuditDetector {
  return {
    id,
    family: "app_error",
    version: 1,
    async run(ctx) {
      log.push(id);
      return run(ctx);
    },
  };
}

function harness(overrides: Partial<SweepDeps> = {}) {
  const ran: string[] = [];
  const finished: Array<{ runId: string; status: string; error: string | null }> = [];
  const leases = { acquired: 0, released: 0 };
  let messages = 0;
  let runs = 0;
  const deps: SweepDeps = {
    sink: SINK,
    acquireLease: async () => {
      leases.acquired += 1;
      return true;
    },
    releaseLease: async () => {
      leases.released += 1;
    },
    lastDatabaseRestart: async () => new Date(NOW - 3 * 24 * 3_600_000).toISOString(),
    startRun: async () => `run-${(runs += 1)}`,
    finishRun: async (runId, result) => {
      finished.push({ runId, status: result.status, error: result.error ?? null });
    },
    sendDailyMessage: async () => {
      messages += 1;
      return MESSAGE;
    },
    now: () => NOW,
    release: "abc1234",
    ...overrides,
  };
  return { deps, ran, finished, leases, messages: () => messages };
}

function testUnhealthyWords() {
  for (const text of [
    "canceling statement due to statement timeout",
    "57014",
    "fetch failed",
    "read ECONNRESET",
    "PGRST002: Could not query the database for the schema cache",
    "Request failed with status 503",
    "HTTP 522 from the gateway",
    "The operation timed out",
  ]) {
    assert.equal(isDatabaseUnhealthy(text), true, `"${text}" means the database is struggling`);
  }
  for (const text of ["Cannot read properties of undefined", "duplicate key value violates unique constraint", null, ""]) {
    assert.equal(isDatabaseUnhealthy(text), false, `"${text}" is a detector's own bug, not the database`);
  }
}

async function testLeaseHeld() {
  const h = harness({ acquireLease: async () => false });
  const result = await runSystemAuditSweep({ ...h.deps, detectors: [detector("a", () => emptyDetectorResult(), h.ran)] });
  assert.equal(result.status, "skipped");
  assert.deepEqual(h.ran, [], "A sweep that finds another running steps aside");
  assert.equal(h.messages(), 0, "…and sends no message: the sweep holding the lease sends it");
  assert.equal(result.dailyMessage, null);
}

async function testAfterRestart() {
  const restartAt = new Date(NOW - (RESTART_QUIET_HOURS - 1) * 3_600_000).toISOString();
  const h = harness({ lastDatabaseRestart: async () => restartAt });
  const result = await runSystemAuditSweep({ ...h.deps, detectors: [detector("a", () => emptyDetectorResult(), h.ran)] });
  assert.equal(result.status, "skipped");
  assert.deepEqual(h.ran, [], "No detector runs the night after a database restart");
  assert.match(String(result.reason), /restarted at .* Cairo, so the detectors sit this night out/);
  assert.equal(h.messages(), 1, "The daily message still goes out — the integrity checks' findings are owed one");
  assert.equal(h.leases.released, 1, "The lease is released");

  const unreadable = harness({
    lastDatabaseRestart: async () => {
      throw new Error("permission denied");
    },
  });
  const ran = await runSystemAuditSweep({ ...unreadable.deps, detectors: [detector("a", () => emptyDetectorResult(), unreadable.ran)] });
  assert.equal(ran.status, "ok", "An unreadable restart record is unknown, not 'restarted' — the sweep runs");
  assert.deepEqual(unreadable.ran, ["a"]);
}

async function testAbortsWhenUnhealthy() {
  const h = harness();
  const errored = (message: string) => {
    const result = emptyDetectorResult("errored");
    result.error = message;
    return result;
  };
  const result = await runSystemAuditSweep({
    ...h.deps,
    detectors: [
      detector("first", () => errored("Cannot read properties of undefined (reading 'x')"), h.ran),
      detector("second", () => errored("canceling statement due to statement timeout"), h.ran),
      detector("third", () => emptyDetectorResult(), h.ran),
      detector("fourth", () => emptyDetectorResult(), h.ran),
    ],
  });
  assert.deepEqual(h.ran, ["first", "second"], "A detector's own bug does not stop the sweep; a struggling database does");
  assert.equal(result.status, "aborted_db_unhealthy");
  assert.match(String(result.reason), /Stopped after second/);
  assert.deepEqual(
    result.detectors.map((row) => [row.detector, row.status]),
    [
      ["first", "errored"],
      ["second", "errored"],
      ["third", "aborted_db_unhealthy"],
      ["fourth", "aborted_db_unhealthy"],
    ],
    "Every detector it did not run is recorded as not run — a gap, never a quiet night",
  );
  assert.equal(h.finished.length, 4, "Each one gets its run row, the ones not run included");
  assert.match(String(h.finished[3].error), /Not run: the sweep stopped after second/);
  assert.equal(h.messages(), 1);
  assert.equal(h.leases.released, 1);

  const thrown = harness();
  const partial = await runSystemAuditSweep({
    ...thrown.deps,
    detectors: [
      detector(
        "throws",
        () => {
          throw new Error("a bug");
        },
        thrown.ran,
      ),
      detector("after", () => emptyDetectorResult(), thrown.ran),
    ],
  });
  assert.equal(partial.status, "partial", "A detector that throws is recorded as errored and the sweep carries on");
  assert.deepEqual(thrown.ran, ["throws", "after"]);
}

async function testBudget() {
  let clock = NOW;
  const deadlines: number[] = [];
  const h = harness({ now: () => clock });
  const result = await runSystemAuditSweep({
    ...h.deps,
    detectors: [
      detector(
        "slow",
        (ctx) => {
          deadlines.push(ctx.deadline);
          clock += SWEEP_BUDGET_MS;
          return emptyDetectorResult();
        },
        h.ran,
      ),
      detector("never", () => emptyDetectorResult(), h.ran),
    ],
  });
  assert.equal(deadlines[0], NOW + PER_DETECTOR_MS, "Each detector gets at most its own slice of the budget");
  assert.deepEqual(h.ran, ["slow"]);
  assert.equal(result.detectors[1].status, "budget_exhausted", "A detector the budget ran out on is recorded as such");
  assert.equal(result.status, "partial");
}

export async function runSystemAuditSweepTests() {
  testUnhealthyWords();
  await testLeaseHeld();
  await testAfterRestart();
  await testAbortsWhenUnhealthy();
  await testBudget();
}
