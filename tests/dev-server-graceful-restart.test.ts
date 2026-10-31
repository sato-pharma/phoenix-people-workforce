// The dev server's memory restart waits until no request is in flight.
//
// WHY THIS EXISTS. Next restarts its dev server once the heap passes 80% of the cap, and it does so
// with process.exit in the `finally` of whichever request happened to finish — so every other request
// still streaming died with it. On 2026-10-31 that was React error 419 ("The server could not finish
// this Suspense boundary") on /admin and /sales/vs-target, twice in one session.
// scripts/dev-server-graceful-restart.mjs keeps the trigger and moves the exit to the first quiet
// moment, with a hard stop at 92% of the cap and a 90 s limit on the wait.
//
// Four layers, because each one alone can pass while a page is still cut mid-render:
//   1. the decision (decideRestart) and where it installs (shouldInstall);
//   2. the hook on a REAL http server: a restart that comes due while a slow request streams must
//      wait for it, deliver its whole body, then exit with Next's restart code;
//   3. the launcher hands the switch to Next's process, and PHOENIX_DEV_GRACEFUL_RESTART=0 takes it back;
//   4. next.config.ts installs it and turns Next's own exit off, and the installed Next still honours
//      that switch and still respawns its server on exit code 77. If an upgrade drops either, the
//      dev server would either never restart (and die out of memory) or never come back.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  HARD_STOP_AT,
  MAX_WAIT_MS,
  NEXT_RESTART_EXIT_CODE,
  RESTART_AT,
  decideRestart,
  installGracefulRestart,
  shouldInstall,
} from "../scripts/dev-server-graceful-restart.mjs";

const LIMIT = 4_000_000_000;
const at = (share: number) => Math.round(LIMIT * share);

function testTheDecision() {
  assert.equal(RESTART_AT, 0.8, "the trigger is Next's own 80% — only the moment of the exit changes");
  assert.equal(NEXT_RESTART_EXIT_CODE, 77, "77 is the code `next dev` respawns its server on");
  const base = { limitBytes: LIMIT, waitingSinceMs: null, nowMs: 1_000 };

  assert.equal(decideRestart({ ...base, usedBytes: at(0.5), inFlight: 3 }).action, "none");
  assert.equal(decideRestart({ ...base, usedBytes: at(RESTART_AT), inFlight: 0 }).action, "none", "exactly at the line is under it, as in Next");
  assert.equal(decideRestart({ ...base, usedBytes: at(0.85), inFlight: 0 }).action, "restart", "over the line and quiet: restart now");
  assert.equal(decideRestart({ ...base, usedBytes: at(0.85), inFlight: 2 }).action, "wait", "over the line with a page streaming: wait for it");
  assert.equal(
    decideRestart({ ...base, usedBytes: at(HARD_STOP_AT + 0.01), inFlight: 2 }).action,
    "restart",
    "past the hard stop the wait would become the out-of-memory crash, so it restarts whatever is open",
  );
  assert.equal(decideRestart({ ...base, usedBytes: at(0.85), inFlight: 1, waitingSinceMs: 0, nowMs: MAX_WAIT_MS - 1 }).action, "wait");
  assert.equal(
    decideRestart({ ...base, usedBytes: at(0.85), inFlight: 1, waitingSinceMs: 0, nowMs: MAX_WAIT_MS }).action,
    "restart",
    "a page that never goes quiet cannot hold the restart off for ever",
  );
  assert.equal(decideRestart({ ...base, limitBytes: 0, usedBytes: 5, inFlight: 0 }).action, "none", "no limit read is never a restart");

  const server = ["C:\\repo\\node_modules\\next\\dist\\server\\lib\\start-server.js"];
  const on = { PHOENIX_DEV_GRACEFUL_RESTART: "1", NODE_ENV: "development" };
  assert.equal(shouldInstall(on, ["node", ...server]), true, "the dev server's own process, launched by the launcher");
  assert.equal(shouldInstall(on, ["node", "/repo/node_modules/next/dist/bin/next", "dev"]), false, "never the `next dev` parent, which serves nothing");
  assert.equal(shouldInstall({ ...on, NODE_ENV: "production" }, ["node", ...server]), false, "never production");
  assert.equal(shouldInstall({ NODE_ENV: "development" }, ["node", ...server]), false, "only when the launcher asked for it");
  assert.equal(shouldInstall({ ...on, PHOENIX_DEV_GRACEFUL_RESTART: "0" }, ["node", ...server]), false);
}

// node's own http client and timers, never the globals: many test files in the same process swap
// globalThis.fetch (and some the timers) for a stub, and one left in place meant /slow never reached
// this server, so the wait below spun for ever and froze the whole test shard (2026-10-31).
function get(url: string): Promise<string> {
  return new Promise((done, fail) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done(body));
        res.on("error", fail);
      })
      .on("error", fail);
  });
}

async function testOnARealServer() {
  const heap = { used_heap_size: at(0.5), heap_size_limit: LIMIT };
  const exits: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  const hook = installGracefulRestart({
    serverPrototypes: [http.Server.prototype],
    getHeapStatistics: () => heap,
    exit: (code: number) => exits.push(code),
    log: (line: string) => logs.push(line),
    now: () => clock,
    intervalMs: 3_600_000,
  });
  assert.ok(hook, "the hook installs");
  assert.equal(
    installGracefulRestart({ serverPrototypes: [http.Server.prototype], exit: () => exits.push(-1), intervalMs: 3_600_000 }),
    null,
    "a second install (the config is loaded more than once) is refused rather than counting every request twice",
  );

  let releaseSlow!: () => void;
  const slowReleased = new Promise<void>((done) => (releaseSlow = done));
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") {
      res.write("first half, ");
      void slowReleased.then(() => res.end("second half"));
    } else {
      res.end("fast");
    }
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const slow = get(`${base}/slow`);
    slow.catch(() => {}); // a failure path drops the socket; the assertion, not this, is the report
    const deadline = Date.now() + 10_000;
    while (hook.state.inFlight < 1) {
      assert.ok(Date.now() < deadline, "/slow never reached the server within 10 s — a failure, never a hang");
      await sleep(5);
    }

    heap.used_heap_size = at(0.85);
    assert.equal(await get(`${base}/fast`), "fast");
    await sleep(20);
    assert.deepEqual(exits, [], "the restart came due while /slow was streaming, so it must wait — this exit is the 419");
    assert.equal(hook.state.inFlight, 1);
    assert.ok(logs.some((line) => line.includes("restarting once the 1 request(s) in flight finish")), `the wait is announced: ${logs.join(" | ")}`);

    releaseSlow();
    assert.equal(await slow, "first half, second half", "the streaming request is delivered whole before the restart");
    await sleep(20);
    assert.deepEqual(exits, [NEXT_RESTART_EXIT_CODE], "and the moment it closes, the server restarts with Next's own code");
    assert.ok(logs.some((line) => /restarting now \(no request in flight\)/.test(line)), `the restart says why: ${logs.join(" | ")}`);

    // The two limits, on the same hook's clock.
    hook.state.exited = false;
    exits.length = 0;
    hook.state.inFlight = 1;
    hook.state.waitingSinceMs = null;
    clock = 0;
    hook.check();
    assert.deepEqual(exits, [], "one request in flight: wait");
    clock = MAX_WAIT_MS;
    hook.check();
    assert.deepEqual(exits, [NEXT_RESTART_EXIT_CODE], "90 s of waiting is the limit");

    hook.state.exited = false;
    exits.length = 0;
    hook.state.waitingSinceMs = null;
    clock = 0;
    heap.used_heap_size = at(0.95);
    hook.check();
    assert.deepEqual(exits, [NEXT_RESTART_EXIT_CODE], "past 92% it restarts at once, request or not");
  } finally {
    // A failed assertion above leaves /slow open, and close() waits for it: release it and drop
    // every socket, so a regression fails here instead of hanging the suite.
    releaseSlow();
    hook.uninstall();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(http.Server.prototype, "emit"), false, "uninstall leaves http.Server as it found it");
}

function testTheLauncher() {
  const root = mkdtempSync(join(tmpdir(), "phx-dev-graceful-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["dev-server.mjs", "dev-server-heap-cap.mjs", "dev-server-exit-reason.mjs", "dev-server-lean.mjs"]) {
      copyFileSync(resolve("scripts", file), join(root, "scripts", file));
    }
    const bin = join(root, "node_modules", "next", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "next"),
      "process.stdout.write(JSON.stringify({ graceful: process.env.PHOENIX_DEV_GRACEFUL_RESTART ?? null }) + '\\n');\n",
    );
    const launch = (extra: Record<string, string>) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS: "1" };
      delete env.PHOENIX_DEV_GRACEFUL_RESTART;
      Object.assign(env, extra);
      const run = spawnSync(process.execPath, [join(root, "scripts", "dev-server.mjs")], { env, encoding: "utf8", timeout: 30000 });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const lines = run.stdout.split(/\r?\n/);
      const report = lines.find((line) => line.startsWith('{"graceful"'));
      assert.ok(report, `the stand-in for Next never ran.\n${run.stdout}\n${run.stderr}`);
      return { ...(JSON.parse(report) as { graceful: string | null }), line: lines.find((line) => line.startsWith("[dev-server]")) ?? "" };
    };
    const plain = launch({});
    assert.equal(plain.graceful, "1", "by default Next's process is told to restart gracefully");
    assert.match(plain.line, /memory restart waits for in-flight requests/, "the launcher says so");
    const off = launch({ PHOENIX_DEV_GRACEFUL_RESTART: "0" });
    assert.equal(off.graceful, null, "=0 gives Next's own restart back, and the child is not told otherwise");
    assert.match(off.line, /Next's own memory restart/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testTheConfigAndTheInstalledNext() {
  const config = readFileSync(resolve("next.config.ts"), "utf8");
  assert.match(config, /from "\.\/scripts\/dev-server-graceful-restart\.mjs"/, "next.config.ts loads the hook");
  assert.match(
    config,
    /const devGracefulRestart = !isProduction && shouldInstall\(\) && installGracefulRestart\(\) !== null;/,
    "it installs only outside production and only in the process shouldInstall names",
  );
  assert.match(
    config,
    /\.\.\.\(devGracefulRestart \? \{ devMemoryThresholdRestart: false \} : \{\}\)/,
    "Next's own mid-request exit is switched off exactly where the graceful one runs, and nowhere else",
  );

  const nextDir = dirname(createRequire(import.meta.url).resolve("next/package.json"));
  const read = (file: string) => readFileSync(join(nextDir, "dist", ...file.split("/")), "utf8");
  assert.match(
    read("server/lib/router-server.js"),
    /experimental\.devMemoryThresholdRestart\) !== false/,
    "the installed Next must still read experimental.devMemoryThresholdRestart, or its own exit comes back beside this one",
  );
  assert.match(read("server/lib/utils.js"), /const RESTART_EXIT_CODE = 77;/, "Next's restart code is still 77");
  assert.match(read("server/lib/utils.js"), /0\.8 \* heapStatistics\.heap_size_limit/, "Next's trigger is still 80%, which RESTART_AT copies");
  assert.match(read("cli/next-dev.js"), /code === _utils\.RESTART_EXIT_CODE/, "`next dev` still respawns its server on 77 — without it the server would stop, not restart");
  assert.match(read("server/config-schema.js"), /devMemoryThresholdRestart: _zod\.z\.boolean\(\)\.optional\(\)/, "the option still passes Next's config validation");
}

export async function runDevServerGracefulRestartTests() {
  testTheDecision();
  await testOnARealServer();
  testTheLauncher();
  testTheConfigAndTheInstalledNext();
}
