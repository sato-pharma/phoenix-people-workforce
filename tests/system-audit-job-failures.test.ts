import assert from "node:assert/strict";

import {
  JOB_FAILURES_DETECTOR,
  buildJobFailureFindings,
  createJobFailuresDetector,
  jobDisplayName,
  type BackgroundJobRow,
} from "../src/lib/system-audit/detectors/job-failures.ts";
import type { JobHeartbeatProblem, JobHeartbeatRow } from "../src/lib/observability/job-heartbeat-assess.ts";
import type { FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";

/**
 * Background job failures: the heartbeat register's stranded / failing / misdeclared verdicts, and
 * failed rows of the export queue. A job is never a sidebar module, so it is named in words; a queue
 * row names the person who asked for it; and one row per missed fire, per failure, per queue row,
 * so a re-run lands on itself.
 */

const NOW_ISO = "2026-10-23T02:00:00.000Z";
const LABEL = (route: string | null, jobName: string) =>
  route ? { label: "Data backup", shell: "admin" as const, route } : { label: `Background job — ${jobName}`, shell: null, route: null };

function problem(overrides: Partial<JobHeartbeatProblem> = {}): JobHeartbeatProblem {
  return {
    slug: "phoenix-crm-daily-digest",
    kind: "stranded",
    detail: "CRM daily digest has not reported since 21 Oct.",
    lastSuccessAt: "2026-10-21T05:00:00.000Z",
    overdueSince: "2026-10-22T07:00:00.000Z",
    ...overrides,
  };
}

function heartbeat(overrides: Partial<JobHeartbeatRow> = {}): JobHeartbeatRow {
  return {
    slug: "phoenix-sos-closing-refresh",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastOutcome: "fail",
    lastSuccessAt: "2026-10-21T05:00:00.000Z",
    lastFailAt: "2026-10-22T05:00:00.000Z",
    lastDetail: "boom",
    ...overrides,
  };
}

function queued(overrides: Partial<BackgroundJobRow> = {}): BackgroundJobRow {
  return {
    id: "job-1",
    job_type: "data_backup_export",
    status: "failed",
    requested_by: "B-77",
    error: "Storage upload refused",
    attempts: 3,
    created_at: "2026-10-22T09:00:00.000Z",
    finished_at: "2026-10-22T09:05:00.000Z",
    updated_at: "2026-10-22T09:05:00.000Z",
    ...overrides,
  };
}

function testDisplayNames() {
  assert.equal(jobDisplayName("phoenix-crm-daily-digest"), "CRM daily digest");
  assert.equal(jobDisplayName("phoenix-system-audit-sweep"), "System audit sweep");
  assert.equal(jobDisplayName("phoenix-ireports360-sync"), "iReports360 sync", "A listed word keeps its own spelling");
  assert.equal(jobDisplayName(""), "Unnamed job", "A job is always named in words, never left blank");
}

function testHeartbeatRows() {
  const built = buildJobFailureFindings({
    stranded: [problem()],
    failing: [problem({ slug: "phoenix-sos-closing-refresh", kind: "failing", detail: "Source of Sales closing refresh failed.", overdueSince: null })],
    misdeclared: [problem({ slug: "phoenix-bad-cron", kind: "misdeclared", detail: "The cron expression cannot be parsed.", overdueSince: null })],
    heartbeats: [heartbeat()],
    backgroundJobs: [],
    people: new Map(),
    nowIso: NOW_ISO,
    label: LABEL,
  });

  assert.deepEqual(
    built.occurrences.map((row) => row.dedupeKey),
    [
      "job:phoenix-crm-daily-digest:stranded:2026-10-22T07:00:00.000Z",
      "job:phoenix-sos-closing-refresh:fail:2026-10-22T05:00:00.000Z",
      "job:phoenix-bad-cron:misdeclared",
    ],
    "One row per missed fire, per recorded failure, and one standing row for a declaration that cannot be judged",
  );
  assert.deepEqual(
    built.issues.map((issue) => issue.signatureKey),
    ["job:phoenix-crm-daily-digest:stranded", "job:phoenix-sos-closing-refresh:failing", "job:phoenix-bad-cron:misdeclared"],
  );
  const stranded = built.occurrences[0];
  assert.equal(stranded.hrKey, null, "A scheduled job is a system row");
  assert.equal(stranded.moduleLabel, "Background job — CRM daily digest", "A job is named in words, not by its slug");
  assert.equal(stranded.occurredAt, "2026-10-22T07:00:00.000Z", "A stranded job is dated from when it became overdue");
  assert.equal(built.occurrences[1].occurredAt, "2026-10-22T05:00:00.000Z", "A failing job is dated by its recorded failure");
  const misdeclared = built.issues[2];
  assert.equal(misdeclared.rootCauseLevel, "confirmed", "A declaration that cannot be evaluated is a confirmed cause");
}

function testQueueRows() {
  const people = new Map([
    ["b-77", { hrIdDisplay: "B-77", name: "Mona Adel", role: "Medical Rep" }],
    ["mona.adel", { hrIdDisplay: "B-77", name: "Mona Adel", role: "Medical Rep" }],
  ]);
  const built = buildJobFailureFindings({
    stranded: [],
    failing: [],
    misdeclared: [],
    heartbeats: [],
    backgroundJobs: [
      queued(),
      queued({ id: "job-2", requested_by: "mona.adel", finished_at: null, updated_at: "2026-10-22T10:00:00.000Z" }),
      queued({ id: "job-3", requested_by: "system", error: "Disk full" }),
      queued({ id: "job-4", status: "succeeded" }),
    ],
    people,
    nowIso: NOW_ISO,
    label: LABEL,
  });

  assert.equal(built.occurrences.length, 3, "Only FAILED queue rows are findings");
  assert.equal(built.issues.length, 2, "The same error is one issue; a different error is another");
  assert.ok(built.issues.every((issue) => /^bgjob:data_backup_export:[0-9a-f]{12}$/.test(issue.signatureKey)));

  const [first, second, systemRow] = built.occurrences;
  assert.equal(first.dedupeKey, "bgjob:job-1");
  assert.equal(first.hrKey, "b-77");
  assert.equal(first.employeeName, "Mona Adel", "The person who asked for the export is named");
  assert.equal(first.attemptCount, 3);
  assert.equal(first.isSilent, false, "The requester watched it fail on the page");
  assert.equal(first.userMessage, null, "The words shown were never kept, so none are invented");
  assert.equal(first.route, "/admin/data-backup");
  assert.equal(second.hrKey, "b-77", "A login id resolves to the person's HR id");
  assert.equal(second.occurredAt, "2026-10-22T10:00:00.000Z", "With no finish time the last update dates it");
  assert.equal(systemRow.hrKey, null, "A job the system requested belongs to nobody");
}

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

async function testDetector() {
  const now = () => Date.parse(NOW_ISO);
  const failingBoth = createJobFailuresDetector({
    readHeartbeats: async () => {
      throw new Error("heartbeats down");
    },
    standDown: async () => null,
    readBackgroundJobs: async () => {
      throw new Error("queue down");
    },
  });
  const nothing = recordingSink();
  const errored = await failingBoth.run({ mode: "cron", deadline: now() + 60_000, sink: nothing.sink, runId: "r", now });
  assert.equal(errored.status, "errored", "Both sources unreadable is no answer at all, never a quiet night");
  assert.deepEqual(errored.unreadableSources, ["job_heartbeats", "background_jobs"]);
  assert.equal(nothing.writes.length, 0, "…and the watermark does not move");

  const queueOnly = createJobFailuresDetector({
    readHeartbeats: async () => {
      throw new Error("heartbeats down");
    },
    standDown: async () => null,
    readBackgroundJobs: async () => [queued()],
    people: { lookup: async () => new Map([["b-77", { hrIdDisplay: "B-77", name: "Mona Adel", role: "Medical Rep" }]]) },
  });
  const cron = recordingSink({ scannedUntil: "2026-10-22T02:00:00.000Z" });
  const partial = await queueOnly.run({ mode: "cron", deadline: now() + 60_000, sink: cron.sink, runId: "r", now });
  assert.equal(partial.status, "partial", "One unreadable source makes the night partial");
  assert.equal(cron.writes[0].detector, JOB_FAILURES_DETECTOR);
  assert.equal(cron.writes[0].batch.occurrences[0].employeeName, "Mona Adel");
  assert.deepEqual(cron.writes[0].batch.cursor, { scannedUntil: NOW_ISO });
  assert.match(String(partial.report?.coverage), /keeps only each job's last outcome/, "Every run says what the register cannot show");

  const quiet = createJobFailuresDetector({ readHeartbeats: async () => [], standDown: async () => null, readBackgroundJobs: async () => [] });
  const historical = recordingSink();
  const clean = await quiet.run({ mode: "historical", deadline: now() + 60_000, sink: historical.sink, runId: null, now, window: { from: "2026-10-01", to: "2026-10-02" } });
  assert.equal(clean.status, "ok");
  assert.equal(historical.writes.length, 0, "A historical run with nothing to say writes nothing");
}

export async function runSystemAuditJobFailuresTests() {
  testDisplayNames();
  testHeartbeatRows();
  testQueueRows();
  await testDetector();
}
