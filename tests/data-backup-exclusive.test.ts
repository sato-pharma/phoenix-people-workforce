import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runBackupExclusive } from "@/lib/admin/data-backup";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-009 — data backups run one at a time per process.
 *
 * A backup holds every row of every table it covers, then a workbook built from them. The download
 * route and the background worker could each start one, so two or three ran side by side on the
 * single production container and stacked their memory peaks. `runBackupExclusive` queues them:
 * the next starts only once the previous has SETTLED, a failure releases the queue, and every
 * caller gets its own result or its own error — never another caller's.
 */
export async function runDataBackupExclusiveTests() {
  const tick = () => new Promise<void>((done) => setTimeout(done, 0));
  const deferred = <T>() => {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    return { promise, reject, resolve };
  };

  // 1. The second backup starts only after the first SETTLES, and each result reaches its caller.
  {
    const events: string[] = [];
    const firstGate = deferred<string>();
    const first = runBackupExclusive(async () => {
      events.push("first:start");
      const value = await firstGate.promise;
      events.push("first:end");
      return value;
    });
    const second = runBackupExclusive(async () => {
      events.push("second:start");
      return "second-result";
    });
    await tick();
    await tick();
    assert.deepEqual(events, ["first:start"], "a second backup must NOT start while the first is still running");
    firstGate.resolve("first-result");
    assert.equal(await first, "first-result", "the first caller must receive the first backup's own result");
    assert.equal(await second, "second-result", "the second caller must receive its own result, never the first's");
    assert.deepEqual(
      events,
      ["first:start", "first:end", "second:start"],
      "the second backup must start only after the first has finished",
    );
  }

  // 2. A FAILED backup releases the queue: the next caller still runs, and the error reaches only
  //    the caller whose backup failed.
  {
    const events: string[] = [];
    const failGate = deferred<never>();
    const failing = runBackupExclusive(async () => {
      events.push("failing:start");
      return failGate.promise;
    });
    const after = runBackupExclusive(async () => {
      events.push("after:start");
      return "after-result";
    });
    await tick();
    await tick();
    assert.deepEqual(events, ["failing:start"], "the next backup must wait for a failing one too, until it settles");
    failGate.reject(new Error("table load failed"));
    await assert.rejects(failing, /table load failed/, "the failure must reach the caller whose backup failed");
    // Settled into a value, so a queue that hands the failure on reads as THIS message, not the stray error.
    const afterOutcome = await after.then(
      (value) => value,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    assert.equal(
      afterOutcome,
      "after-result",
      "a failed backup must release the queue — the next caller still runs and gets its own result",
    );
    assert.deepEqual(events, ["failing:start", "after:start"], "the next backup starts only after the failure settles");
  }

  // 3. A callback that throws synchronously becomes its own caller's rejection and releases the queue.
  {
    const thrown = runBackupExclusive((() => {
      throw new Error("threw before awaiting");
    }) as () => Promise<never>);
    const next = runBackupExclusive(async () => "still-runs");
    await assert.rejects(thrown, /threw before awaiting/, "a synchronous throw must reject that caller's promise");
    const nextOutcome = await next.then(
      (value) => value,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    assert.equal(nextOutcome, "still-runs", "and must not jam the queue for the next caller");
  }

  // 4. Source pins: the download route and the background worker both go through the queue.
  const root = process.cwd();
  const route = stripComments(readFileSync(resolve(root, "app/api/admin/data-backup/route.ts"), "utf8"));
  const getAt = route.indexOf("export async function GET");
  const postAt = route.indexOf("export async function POST");
  assert.ok(getAt !== -1 && postAt > getAt, "the GET handler must still exist — this pin cannot silently stop checking anything");
  const getBody = route.slice(getAt, postAt);
  assert.match(
    getBody,
    /await runBackupExclusive\(async \(\) => \{\s*const payload = await loadDataBackup\([\s\S]*?JSON\.stringify\(payload\)[\s\S]*?await buildBackupWorkbook\(payload\)[\s\S]*?\}\);/,
    "the GET route must load AND build (both the JSON and the XLSX branch) inside runBackupExclusive",
  );
  assert.doesNotMatch(
    getBody.replace(/await runBackupExclusive\(async \(\) => \{[\s\S]*?\}\);/, ""),
    /loadDataBackup\(|buildBackupWorkbook\(/,
    "the GET route must not load or build a backup outside runBackupExclusive",
  );

  // loadDataBackup normalises the freshly fetched rows IN PLACE rather than copying every row.
  const lib = stripComments(readFileSync(resolve(root, "src/lib/admin/data-backup.ts"), "utf8"));
  const loadAt = lib.indexOf("export async function loadDataBackup");
  assert.notEqual(loadAt, -1, "loadDataBackup must still exist — this pin cannot silently stop checking anything");
  const loadBody = lib.slice(loadAt, lib.indexOf("export async function buildBackupWorkbook"));
  assert.match(
    loadBody,
    /for \(const row of rows\) \{\s*for \(const key of Object\.keys\(row\)\) \{\s*row\[key\] = safeToJsonValue\(row\[key\]\);/,
    "loadDataBackup must normalise each fetched row in place, not copy every row into a new object",
  );
  assert.doesNotMatch(loadBody, /rows\.map\(/, "loadDataBackup must not map the rows into a second full copy");

  const worker = stripComments(readFileSync(resolve(root, "src/lib/background-jobs/worker.ts"), "utf8"));
  assert.match(
    worker,
    /await runBackupExclusive\(\(\) => runDataBackupExport\(job\)\)/,
    "the background worker must run each data-backup job through runBackupExclusive",
  );
  assert.doesNotMatch(
    worker.replace(/runBackupExclusive\(\(\) => runDataBackupExport\(job\)\)/, ""),
    /runDataBackupExport\(job\)/,
    "the worker must not call runDataBackupExport outside runBackupExclusive",
  );
}
