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
import { ORPHAN_PRUNE_BATCH, pruneUserErrorScreens, SCREEN_PRUNE_BATCH, type ScreenPruneResult } from "../src/lib/system-audit/user-screens.ts";

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

/**
 * Just the calls pruneUserErrorScreens makes, answering the way PostgREST and Storage do. A bucket is
 * a set of object paths; `list` answers like Storage — the next path segment under a prefix, a
 * folder with `id: null`, a file with an id, name order, `limit`/`offset` — and `remove` takes the
 * paths away, listing only the ones that existed.
 */
function fakeStore(input: {
  oldRows: number;
  countAnswer: { count: number | null; error: { message: string } | null };
  objects?: Record<string, string[]>;
  listFails?: Record<string, string>;
  removeFails?: Record<string, string>;
}) {
  const calls: Call[] = [];
  const rows = Array.from({ length: input.oldRows }, (_, index) => ({ id: `id-${index}`, storage_path: `p/${index}.webp` }));
  const buckets = new Map<string, Set<string>>();
  const bucket = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Set(input.objects?.[name] ?? []));
    return buckets.get(name)!;
  };
  // The rows' own files live in the people's bucket, under a folder of no day's shape.
  for (const row of rows) bucket("user-error-screens").add(row.storage_path);
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
      from(name: string) {
        return {
          list: async (prefix: string, options: { limit: number; offset: number }) => {
            calls.push({ op: "list", args: [name, prefix] });
            if (input.listFails?.[name]) return { data: null, error: { message: input.listFails[name] } };
            const entries = new Map<string, { name: string; id: string | null }>();
            for (const path of bucket(name)) {
              if (prefix && !path.startsWith(`${prefix}/`)) continue;
              const rest = prefix ? path.slice(prefix.length + 1) : path;
              const segment = rest.split("/")[0];
              entries.set(segment, { name: segment, id: rest.includes("/") ? null : `obj:${path}` });
            }
            const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            return { data: sorted.slice(options.offset, options.offset + options.limit), error: null };
          },
          remove: async (paths: string[]) => {
            calls.push({ op: "remove", args: [paths.length, name] });
            if (input.removeFails?.[name]) return { data: null, error: { message: input.removeFails[name] } };
            const gone = paths.filter((path) => bucket(name).delete(path));
            return { data: gone.map((path) => ({ name: path })), error: null };
          },
        };
      },
    },
  };
  return { client: client as never, calls, left: (name: string) => [...bucket(name)].sort() };
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

// ── 4. The 91-day backstop for files no row points at ───────────────────────────────────────────
//
// 17 Nov 2026 audit: both removals take a file only through its row, so a file whose row never landed
// or was deleted without it stayed in its bucket for ever — an unmasked picture of someone's screen.

const SCREEN = (day: string, owner: string, n: number, ext = "webp") => `${day}/${owner}/aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}.${ext}`;
const CRASH = (day: string, n: number, ext = "webp") => `${day.replaceAll("-", "/")}/bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}.${ext}`;

async function orphanTests() {
  const nowMs = Date.parse(NOW_ISO); // 91 days before is 01:30 on 24 Jul 2026 in Cairo.
  const notAfter = "2026-10-22T20:00:00.000Z";
  const quiet = { count: 0, error: null };

  {
    const store = fakeStore({
      oldRows: 0,
      countAnswer: quiet,
      objects: {
        "user-error-screens": [
          SCREEN("2026-07-23", "B-10", 1),
          SCREEN("2026-07-23", "unknown", 2, "jpg"),
          SCREEN("2026-07-24", "B-10", 3),
          "2026-06-01/B-10/notes.txt",
          "archive/2026-01-01/B-10/aaaaaaaa-0000-4000-8000-000000000009.webp",
        ],
        "error-screenshots": [CRASH("2026-07-23", 1), CRASH("2025-12-31", 2, "jpg"), CRASH("2026-07-24", 3), CRASH("2026-08-01", 4), "2026/7/01/x.webp", "misc/readme.webp"],
      },
    });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter }, store.client);
    assert.deepEqual(
      store.left("user-error-screens"),
      ["2026-06-01/B-10/notes.txt", SCREEN("2026-07-24", "B-10", 3), "archive/2026-01-01/B-10/aaaaaaaa-0000-4000-8000-000000000009.webp"].sort(),
      "user-error-screens: a picture in a day folder more than 91 days old is removed; a younger one, and any name not of the bucket's own shape, is left",
    );
    assert.deepEqual(
      store.left("error-screenshots"),
      [CRASH("2026-07-24", 3), CRASH("2026-08-01", 4), "2026/7/01/x.webp", "misc/readme.webp"].sort(),
      "error-screenshots: the same 91 days over YYYY/MM/DD, across a year boundary; nothing of another shape is touched",
    );
    const [screens, crashes] = pruned.orphans!.buckets;
    assert.deepEqual(screens, { bucket: "user-error-screens", before: "2026-07-24", found: 2, removed: 2, skipped: null, error: null }, "the report names the bucket, the day and what went");
    assert.deepEqual(crashes, { bucket: "error-screenshots", before: "2026-07-24", found: 2, removed: 2, skipped: null, error: null });
    assert.equal(pruned.orphans!.capped, false);
    assert.equal(pruned.error, null, "a clean backstop adds no error");
  }
  {
    const store = fakeStore({
      oldRows: 0,
      countAnswer: quiet,
      objects: { "user-error-screens": [SCREEN("2026-07-09", "B-10", 1), SCREEN("2026-07-15", "B-10", 2)] },
    });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter: "2026-07-10T12:00:00.000Z" }, store.client);
    assert.deepEqual(
      store.left("user-error-screens"),
      [SCREEN("2026-07-15", "B-10", 2)],
      "a day folder the detector has not folded past is never swept, however old — a picture is in the ledger before it goes",
    );
    assert.equal(pruned.orphans!.buckets[0].before, "2026-07-10");
  }
  {
    const store = fakeStore({
      oldRows: 0,
      countAnswer: quiet,
      objects: { "user-error-screens": [SCREEN("2026-07-01", "B-10", 1)], "error-screenshots": [CRASH("2026-07-01", 1)] },
    });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter: null }, store.client);
    assert.deepEqual(store.left("user-error-screens"), [SCREEN("2026-07-01", "B-10", 1)], "before the first fold no person's picture is swept");
    assert.equal(pruned.orphans!.buckets[0].skipped, "the detector has not folded any picture yet");
    assert.equal(pruned.orphans!.buckets[0].found, null);
    assert.deepEqual(store.left("error-screenshots"), [], "…while the crash pictures, which no watermark guards, still are");
  }
  {
    const store = fakeStore({
      oldRows: 0,
      countAnswer: quiet,
      objects: {
        "user-error-screens": [SCREEN("2026-07-01", "B-10", 1), SCREEN("2026-07-01", "B-20", 2), SCREEN("2026-07-02", "B-10", 3)],
        "error-screenshots": [CRASH("2026-07-01", 1), CRASH("2026-07-02", 2)],
      },
    });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter, orphanLimit: 4 }, store.client);
    assert.equal(pruned.orphans!.buckets[0].removed, 3, "the people's pictures go first");
    assert.equal(pruned.orphans!.buckets[1].found, 1, "one cap shared by both buckets: the crash pictures get what is left of it");
    assert.deepEqual(store.left("error-screenshots"), [CRASH("2026-07-02", 2)], "oldest first, the rest wait for the next night");
    assert.equal(pruned.orphans!.capped, true, "a night that reached the cap says so");
    assert.equal(ORPHAN_PRUNE_BATCH, 1_000, "the cap is 1,000 a night");
  }
  {
    const many = Array.from({ length: 250 }, (_, index) => SCREEN("2026-07-01", "B-10", index));
    const store = fakeStore({ oldRows: 0, countAnswer: quiet, objects: { "user-error-screens": many } });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter }, store.client);
    assert.deepEqual(
      store.calls.filter((call) => call.op === "remove" && call.args[1] === "user-error-screens").map((call) => call.args[0]),
      [100, 100, 50],
      "removed a hundred at a time — the paths travel in the request",
    );
    assert.equal(pruned.orphans!.buckets[0].removed, 250);
  }
  {
    const store = fakeStore({
      oldRows: 0,
      countAnswer: quiet,
      objects: { "user-error-screens": [SCREEN("2026-07-01", "B-10", 1)], "error-screenshots": [CRASH("2026-07-01", 1)] },
      listFails: { "user-error-screens": "Request failed with status 503" },
      removeFails: { "error-screenshots": "Object is locked" },
    });
    const pruned = await pruneUserErrorScreens({ nowMs, notAfter }, store.client);
    const [screens, crashes] = pruned.orphans!.buckets;
    assert.equal(screens.found, null, "a listing that failed is null — never 0, which would read as nothing left");
    assert.match(String(screens.error), /listing the bucket failed: Request failed with status 503/);
    assert.equal(crashes.found, 1, "one bucket's failure does not stop the other");
    assert.equal(crashes.removed, 0);
    assert.match(String(crashes.error), /Storage refused a removal: Object is locked/);
    assert.match(
      String(pruned.error),
      /91-day sweep of files no row points at did not finish — user-error-screens: .*503; error-screenshots: .*Object is locked/,
      "a failed backstop is carried in the night's error, bucket by bucket",
    );
  }
  {
    // End to end through the detector: a failed backstop makes the night partial, never clean.
    const store = fakeStore({
      oldRows: 0,
      countAnswer: quiet,
      objects: { "error-screenshots": [CRASH("2026-07-01", 1)] },
      listFails: { "error-screenshots": "fetch failed" },
    });
    const now = Date.parse(NOW_ISO);
    const detector = createUserScreensDetector({
      source: { async readPage() { return []; } },
      people: createStaticPersonDirectory(new Map()),
      prune: (input) => pruneUserErrorScreens(input, store.client),
    });
    const run = await detector.run({ mode: "cron", deadline: now + 60_000, sink: sink().sink, runId: "run-orphans", now: () => now });
    assert.equal(run.status, "partial", "a backstop that could not list its bucket makes the user_screens run partial");
    const retention = run.report?.retention as ScreenPruneResult;
    assert.equal(retention.orphans?.buckets[1].found, null, "and the run report keeps the unknown as unknown");
  }
}

export async function runUserErrorScreensRetentionCapTests() {
  await pruneTests();
  findingTests();
  await detectorTests();
  await orphanTests();
}
