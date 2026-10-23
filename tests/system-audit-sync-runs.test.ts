import assert from "node:assert/strict";

import {
  STUCK_AFTER_MS,
  SYNC_RUNS_DETECTOR,
  buildSyncRunFindings,
  createSyncRunsDetector,
  findCoveringRun,
  scanBounds,
  type SyncRunRow,
} from "../src/lib/system-audit/detectors/sync-runs.ts";
import type { FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";

/**
 * iReports360 sync runs. A FAILED run and a run that has said "running" for more than two hours are
 * findings; a slow run inside two hours is not. Every finding is a SYSTEM row (no employee owns a
 * sync), one per run, so reading the same run again lands on itself.
 */

const NOW = Date.parse("2026-10-23T02:00:00.000Z");
const LABEL = { label: "CRM", shell: "admin" as const };

function run(overrides: Partial<SyncRunRow> = {}): SyncRunRow {
  return {
    id: "run-1",
    trigger: "cron",
    date_from: "2026-10-20",
    date_to: "2026-10-20",
    status: "success",
    error_message: null,
    started_at: "2026-10-20T10:00:00.000Z",
    completed_at: "2026-10-20T10:01:00.000Z",
    ...overrides,
  };
}

/** A sink that records each write and serves a fixed cursor. */
function recordingSink(cursor: Record<string, unknown> | null = null) {
  const writes: Array<{ detector: string; batch: FindingBatch }> = [];
  const sink: FindingSink = {
    kind: "database",
    async write(detector, _runId, batch) {
      writes.push({ detector, batch });
      return { issues: batch.issues.length, inserted: batch.occurrences.length, updated: 0 };
    },
    async readCursor() {
      return cursor;
    },
  };
  return { sink, writes };
}

function testFailedAndStuck() {
  const failedA = run({ id: "f1", status: "failed", error_message: "Vendor login refused", completed_at: "2026-10-20T10:02:00.000Z" });
  const failedB = run({ id: "f2", status: "failed", error_message: "Vendor login refused", started_at: "2026-10-21T10:00:00.000Z", completed_at: null });
  const failedOther = run({ id: "f3", status: "failed", error_message: "Upsert of visits rejected by the database" });
  const stuck = run({ id: "s1", status: "running", started_at: new Date(NOW - STUCK_AFTER_MS - 60_000).toISOString(), completed_at: null });
  const slow = run({ id: "s2", status: "running", started_at: new Date(NOW - 60 * 60_000).toISOString(), completed_at: null });

  const built = buildSyncRunFindings({ runs: [failedA, failedB, failedOther, stuck, slow], nowMs: NOW, vendorSyncRetiredAt: null, label: LABEL });
  assert.equal(built.failed, 3);
  assert.equal(built.stuck, 1, "A run still 'running' past two hours is stuck; one inside two hours is not");
  assert.equal(built.occurrences.length, 4, "One row per failed or stuck run, nothing for the slow one");

  const keys = built.issues.map((issue) => issue.signatureKey).sort();
  assert.equal(keys.length, 3, "The same error message is one issue; a different message is another");
  assert.ok(keys.includes("sync:ireports360:never-finished"));
  assert.ok(keys.every((key) => /^sync:ireports360:(?:never-finished|failed:[0-9a-f]{16})$/.test(key)), `Unexpected signature in ${keys.join(", ")}`);

  const login = built.issues.find((issue) => issue.title.includes("Vendor login refused"));
  assert.ok(login);
  assert.equal(login.firstSeenAt, "2026-10-20T10:02:00.000Z", "The issue spans its earliest failure");
  assert.equal(login.lastSeenAt, "2026-10-21T10:00:00.000Z", "…to its latest (a failure with no end time is dated by its start)");

  for (const row of built.occurrences) {
    assert.equal(row.hrKey, null, "A sync failure is a system row — it belongs to no employee");
    assert.equal(row.dedupeKey, `sync:${row.relatedId}`, "One row per run, so a re-read lands on itself");
    assert.equal(row.isSilent, true);
  }
  const stuckRow = built.occurrences.find((row) => row.relatedId === "s1");
  assert.equal(stuckRow?.occurredAtKind, "event");
  assert.match(String(stuckRow?.technicalMessage), /never recorded an end/);
}

function testCoverageAndRetirement() {
  const failed = run({ id: "f1", status: "failed", error_message: "Timeout", date_from: "2026-10-18", date_to: "2026-10-19", started_at: "2026-10-19T10:00:00.000Z" });
  const covering = run({ id: "ok-1", status: "success", date_from: "2026-10-17", date_to: "2026-10-20", started_at: "2026-10-20T10:00:00.000Z" });
  const partial = run({ id: "ok-2", status: "success", date_from: "2026-10-19", date_to: "2026-10-20", started_at: "2026-10-19T12:00:00.000Z" });
  const tooLate = run({ id: "ok-3", status: "success", date_from: "2026-10-01", date_to: "2026-10-30", started_at: "2026-10-28T10:00:00.000Z" });
  const before = run({ id: "ok-4", status: "success", date_from: "2026-10-01", date_to: "2026-10-30", started_at: "2026-10-18T10:00:00.000Z" });

  assert.equal(findCoveringRun(failed, [before, partial, covering])?.id, "ok-1", "Only a LATER success that fetched the WHOLE window covers it");
  assert.equal(findCoveringRun(failed, [partial, tooLate, before]), null, "A success more than a week later, half the window, or earlier covers nothing");

  const built = buildSyncRunFindings({
    runs: [failed],
    successes: [covering],
    nowMs: NOW,
    vendorSyncRetiredAt: "2026-10-01T00:00:00.000Z",
    label: LABEL,
  });
  const row = built.occurrences[0];
  assert.equal(row.evidence?.coveredByRunId, "ok-1", "A covered failure is still a finding, with the run that covered it as evidence");
  assert.equal(row.evidence?.afterVendorRetirement, "2026-10-01T00:00:00.000Z");
  assert.match(String(row.technicalMessage), /started after iReports360 was retired/, "A run after the cutover says something is still pulling");
}

function testScanBounds() {
  const noCursor = scanBounds({ mode: "cron", window: null, now: () => NOW }, null);
  assert.equal(noCursor.fromIso, new Date(NOW - 30 * 86_400_000).toISOString(), "With no cursor a cron run looks back thirty days");
  assert.equal(noCursor.toIso, null);
  const withCursor = scanBounds({ mode: "cron", window: null, now: () => NOW }, { scannedUntil: "2026-10-22T02:00:00.000Z" });
  assert.equal(withCursor.fromIso, "2026-10-15T02:00:00.000Z", "Each cron run re-reads a week behind its cursor");
  const historical = scanBounds({ mode: "historical", window: { from: "2026-10-01", to: "2026-10-02" }, now: () => NOW }, null);
  assert.equal(historical.fromIso, "2026-09-30T21:00:00.000Z", "A historical window starts at Cairo midnight");
  assert.equal(historical.toIso, "2026-10-02T21:00:00.000Z", "…and ends at the Cairo midnight after its last day");
}

async function testDetector() {
  const failed = run({ id: "f1", status: "failed", error_message: "Timeout", started_at: "2026-10-22T10:00:00.000Z" });
  // A holder, not a `let`: TypeScript does not see an assignment made inside the callback.
  const seen: { bounds: { fromIso: string; toIso: string | null } | null } = { bounds: null };
  const cron = recordingSink({ scannedUntil: "2026-10-22T02:00:00.000Z" });
  const detector = createSyncRunsDetector({
    readRuns: async (read) => {
      seen.bounds = read;
      return [failed];
    },
    readRetiredAt: async () => null,
  });
  const result = await detector.run({ mode: "cron", deadline: NOW + 60_000, sink: cron.sink, runId: "r", now: () => NOW });
  assert.equal(result.status, "ok");
  assert.equal(seen.bounds?.fromIso, "2026-10-15T02:00:00.000Z", "The cron run reads from the stored cursor");
  assert.equal(cron.writes.length, 1);
  assert.equal(cron.writes[0].detector, SYNC_RUNS_DETECTOR);
  assert.equal(cron.writes[0].batch.merge, "max", "A run is a state; reading it again never doubles it");
  assert.deepEqual(cron.writes[0].batch.cursor, { scannedUntil: new Date(NOW).toISOString() }, "The cron run moves the watermark with its rows");

  // Historical: rows past the window's end are read for coverage only, and the watermark is left alone.
  const lateFailure = run({ id: "f9", status: "failed", error_message: "Timeout", started_at: "2026-10-05T10:00:00.000Z" });
  const historical = recordingSink();
  const unreadable = createSyncRunsDetector({
    readRuns: async () => [failed, lateFailure],
    readRetiredAt: async () => {
      throw new Error("settings table unavailable");
    },
  });
  const past = await unreadable.run({
    mode: "historical",
    deadline: NOW + 60_000,
    sink: historical.sink,
    runId: null,
    now: () => NOW,
    window: { from: "2026-10-01", to: "2026-10-10" },
  });
  assert.equal(past.scanned, 1, "Only runs inside the window are judged");
  assert.deepEqual(historical.writes[0].batch.occurrences.map((row) => row.relatedId), ["f9"]);
  assert.equal(historical.writes[0].batch.cursor, null, "A historical run leaves the watermark to the runner");
  assert.equal(past.status, "partial", "An unreadable cutover setting is noted, never a clean pass");
  assert.deepEqual(past.unreadableSources, ["crm_cutover_setting"]);
}

export async function runSystemAuditSyncRunsTests() {
  testFailedAndStuck();
  testCoverageAndRetirement();
  testScanBounds();
  await testDetector();
}
