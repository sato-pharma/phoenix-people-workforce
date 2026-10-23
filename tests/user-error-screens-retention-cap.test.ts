import assert from "node:assert/strict";

import {
  buildRetentionCapFinding,
  createUserScreensDetector,
  RETENTION_CAP_ERROR_CODE,
  RETENTION_CAP_SIGNATURE,
  USER_SCREENS_DETECTOR,
} from "../src/lib/system-audit/detectors/user-screens.ts";
import { createStaticPersonDirectory } from "../src/lib/system-audit/person-directory.ts";
import type { SidebarLabel } from "../src/lib/system-audit/sidebar-label.ts";
import type { FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";
import { pruneUserErrorScreens, SCREEN_PRUNE_BATCH, type ScreenPruneResult } from "../src/lib/system-audit/user-screens.ts";

/**
 * The nightly screenshot removal raises an issue on the System Audit board when it stops at its cap
 * with pictures still past their 90 days (owner, 23 Oct 2026: "alert when the nightly screenshot
 * removal hits its 1,000 cap").
 *
 * Before this, a capped night showed only as `candidates` in the run report, which nobody reads: after
 * a day of more than 1,000 captures the pictures outlive the owner's 90 days for as many nights as the
 * backlog takes. What is pinned, each by the failure it prevents:
 *   1. The removal says it stopped at the cap, and counts what is still waiting; an unreadable count
 *      is null, never 0, and an uncapped night makes no extra read.
 *   2. A capped night with pictures left becomes ONE issue and one occurrence per CAIRO night. A full
 *      batch that left nothing behind, or an uncapped night, raises nothing.
 *   3. The detector writes it on the nightly sweep — before the morning message reads the board —
 *      without moving the watermark, and a failed write is reported, never thrown.
 */

const NOW_ISO = "2026-10-22T22:30:00.000Z"; // 01:30 on 23 Oct in Cairo, 22 Oct in UTC.
const LABEL: SidebarLabel = { label: "System Audit", source: "nav_exact", shell: "admin", href: "/admin/system-audit" };

function result(overrides: Partial<ScreenPruneResult>): ScreenPruneResult {
  return {
    cutoff: "2026-07-24T22:30:00.000Z",
    cap: SCREEN_PRUNE_BATCH,
    candidates: SCREEN_PRUNE_BATCH,
    deletedRows: SCREEN_PRUNE_BATCH,
    deletedFiles: SCREEN_PRUNE_BATCH,
    keptForRetry: 0,
    capped: true,
    remaining: 2345,
    error: null,
    ...overrides,
  };
}

// ── 1. The removal reports the cap and what is still waiting ─────────────────────────────────────

type Call = { op: string; args: unknown[] };

/** Just the calls pruneUserErrorScreens makes, answering the way PostgREST and Storage do. */
function fakeStore(input: { oldRows: number; countAnswer: { count: number | null; error: { message: string } | null } }) {
  const calls: Call[] = [];
  const rows = Array.from({ length: input.oldRows }, (_, index) => ({ id: `id-${index}`, storage_path: `p/${index}.webp` }));
  const client = {
    from(table: string) {
      return {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          calls.push({ op: "select", args: [table, columns, options ?? null] });
          if (options?.head) {
            return { lt: async () => input.countAnswer };
          }
          return {
            lt() {
              return {
                order() {
                  return {
                    limit: async (limit: number) => ({ data: rows.slice(0, limit), error: null }),
                  };
                },
              };
            },
          };
        },
        delete() {
          return {
            in: async (_column: string, ids: string[]) => {
              calls.push({ op: "delete", args: [table, ids.length] });
              return { error: null, count: ids.length };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          remove: async (paths: string[]) => {
            calls.push({ op: "remove", args: [paths.length] });
            return { data: paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
  };
  return { client: client as never, calls };
}

async function pruneTests() {
  const nowMs = Date.parse(NOW_ISO);
  const notAfter = "2026-10-22T20:00:00.000Z";

  {
    const store = fakeStore({ oldRows: 5, countAnswer: { count: 3, error: null } });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter, limit: 2 }, store.client);
    assert.equal(pruned.cap, 2, "the result carries the cap it ran under");
    assert.equal(pruned.capped, true, "a full batch means the night stopped at the cap");
    assert.equal(pruned.deletedRows, 2);
    assert.equal(pruned.remaining, 3, "what is still past the cutoff is counted once the night is done");
    const count = store.calls.find((call) => call.op === "select" && (call.args[2] as { head?: boolean } | null)?.head);
    assert.ok(count, "the waiting pictures are counted with a head-only count");
    assert.ok(
      store.calls.indexOf(count) > store.calls.findIndex((call) => call.op === "delete"),
      "counted AFTER the night's removals, so it is what is still waiting",
    );
  }
  {
    const store = fakeStore({ oldRows: 5, countAnswer: { count: null, error: { message: "statement timeout" } } });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter, limit: 2 }, store.client);
    assert.equal(pruned.capped, true);
    assert.equal(pruned.remaining, null, "an unreadable count is null — never 0, which would read as caught up");
  }
  {
    const store = fakeStore({ oldRows: 1, countAnswer: { count: 99, error: null } });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter, limit: 2 }, store.client);
    assert.equal(pruned.capped, false, "a short batch removed everything that was due");
    assert.equal(pruned.remaining, 0);
    assert.ok(
      !store.calls.some((call) => (call.args[2] as { head?: boolean } | null)?.head),
      "an uncapped night makes no extra read",
    );
  }
  assert.equal(SCREEN_PRUNE_BATCH, 1_000, "the owner's figure: 1,000 a night");
}

// ── 2. One issue, one occurrence per Cairo night ────────────────────────────────────────────────

function findingTests() {
  assert.equal(buildRetentionCapFinding(result({ capped: false, remaining: 0 }), NOW_ISO, () => LABEL), null, "an uncapped night raises nothing");
  assert.equal(
    buildRetentionCapFinding(result({ remaining: 0 }), NOW_ISO, () => LABEL),
    null,
    "a full batch that left nothing behind raises nothing — exactly 1,000 were due",
  );

  const finding = buildRetentionCapFinding(result({}), NOW_ISO, () => LABEL);
  assert.ok(finding, "a capped night with pictures left raises the issue");
  assert.equal(finding.issue.signatureKey, RETENTION_CAP_SIGNATURE, "one issue for every such night");
  assert.equal(finding.issue.family, "user_screen");
  assert.equal(finding.issue.errorCode, RETENTION_CAP_ERROR_CODE);
  assert.match(finding.issue.title, /^Screenshot removal hit its nightly cap of 1,000/);
  assert.equal(finding.occurrence.signatureKey, RETENTION_CAP_SIGNATURE);
  assert.equal(
    finding.occurrence.dedupeKey,
    `${RETENTION_CAP_SIGNATURE}:2026-10-23`,
    "one occurrence per CAIRO night — 22:30 UTC on 22 Oct is the night of 23 Oct in Cairo",
  );
  assert.equal(finding.occurrence.hrKey, null, "a system row, nobody's screen");
  assert.equal(finding.occurrence.isSilent, true);
  assert.equal(finding.occurrence.moduleLabel, "System Audit");
  assert.equal(finding.occurrence.route, "/admin/system-audit");
  assert.match(finding.occurrence.technicalMessage ?? "", /2,345 pictures are still past their 90 days/, "says how far behind the 90 days are");
  assert.match(finding.occurrence.technicalMessage ?? "", /stopped at its cap of 1,000/);
  assert.equal((finding.occurrence.evidence as { remaining: number }).remaining, 2345);

  const unknown = buildRetentionCapFinding(result({ remaining: null }), NOW_ISO, () => LABEL);
  assert.ok(unknown, "an unreadable count still raises it");
  assert.match(unknown.occurrence.technicalMessage ?? "", /could not be counted/, "and says the count could not be read");

  const one = buildRetentionCapFinding(result({ remaining: 1 }), NOW_ISO, () => LABEL);
  assert.match(one?.occurrence.technicalMessage ?? "", /1 picture is still past/);

  const real = buildRetentionCapFinding(result({}), NOW_ISO);
  assert.ok(real && real.occurrence.moduleLabel.trim().length > 0, "the real sidebar label names the page");
}

// ── 3. The detector writes it on the nightly sweep ──────────────────────────────────────────────

function sink(options: { failOn?: string } = {}) {
  const writes: Array<{ detector: string; batch: FindingBatch }> = [];
  const value: FindingSink = {
    kind: "file",
    async write(detector, _runId, batch) {
      if (options.failOn && batch.issues.some((issue) => issue.signatureKey === options.failOn)) throw new Error("ledger write timed out");
      writes.push({ detector, batch });
      return { issues: batch.issues.length, inserted: batch.occurrences.length, updated: 0 };
    },
    async readCursor() {
      return null;
    },
  };
  return { sink: value, writes };
}

async function detectorTests() {
  const now = Date.parse(NOW_ISO);
  const people = createStaticPersonDirectory(new Map());
  const empty = { async readPage() { return []; } };

  {
    const target = sink();
    const detector = createUserScreensDetector({ source: empty, people, prune: async () => result({}) });
    const run = await detector.run({ mode: "cron", deadline: now + 60_000, sink: target.sink, runId: "run-1", now: () => now });
    assert.equal(run.status, "ok");
    const alarm = target.writes.find((write) => write.batch.issues.some((issue) => issue.signatureKey === RETENTION_CAP_SIGNATURE));
    assert.ok(alarm, "a capped night with pictures left writes the issue to the board");
    assert.equal(alarm.detector, USER_SCREENS_DETECTOR);
    assert.equal(alarm.batch.cursor, null, "the watermark stays where the fold put it");
    assert.equal(alarm.batch.merge, "max", "a re-run of the same night lands on the same occurrence");
    assert.equal(alarm.batch.occurrences.length, 1);
    assert.equal(run.report?.retentionAlert, "raised", "the run record says the alarm was raised");
    assert.equal(run.inserted, 1);
  }
  {
    const target = sink();
    const detector = createUserScreensDetector({ source: empty, people, prune: async () => result({ capped: false, candidates: 12, remaining: 0 }) });
    const run = await detector.run({ mode: "cron", deadline: now + 60_000, sink: target.sink, runId: "run-2", now: () => now });
    assert.equal(target.writes.length, 0, "an ordinary night writes nothing about retention");
    assert.equal(run.report?.retentionAlert, "none");
  }
  {
    const target = sink({ failOn: RETENTION_CAP_SIGNATURE });
    const detector = createUserScreensDetector({ source: empty, people, prune: async () => result({}) });
    const run = await detector.run({ mode: "cron", deadline: now + 60_000, sink: target.sink, runId: "run-3", now: () => now });
    assert.equal(run.status, "partial", "an alarm that could not be written makes the night partial, never clean");
    assert.deepEqual(run.report?.retentionAlert, { error: "ledger write timed out" });
    assert.equal((run.report?.retention as ScreenPruneResult).deletedRows, SCREEN_PRUNE_BATCH, "and never undoes what the removal did");
  }
  {
    const target = sink();
    const prunes: unknown[] = [];
    const detector = createUserScreensDetector({
      source: empty,
      people,
      prune: async (input) => {
        prunes.push(input);
        return result({});
      },
    });
    await detector.run({ mode: "historical", deadline: now + 60_000, sink: target.sink, runId: null, now: () => now, window: { from: "2026-10-22", to: "2026-10-22" } });
    assert.deepEqual(prunes, [], "the historical runner never removes, so never alarms");
    assert.ok(!target.writes.some((write) => write.batch.issues.some((issue) => issue.signatureKey === RETENTION_CAP_SIGNATURE)));
  }
}

export async function runUserErrorScreensRetentionCapTests() {
  await pruneTests();
  findingTests();
  await detectorTests();
}
