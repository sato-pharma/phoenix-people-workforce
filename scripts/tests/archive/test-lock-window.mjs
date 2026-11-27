// Two sweeps that overlap INSIDE the window: how many think they hold the lock?
// Six processes, barrier-synchronised to one timestamp on the archive drive, with the barrier
// ITSELF checked — a race whose processes arrived at different times proves nothing either way.
// Then the same question asked of the production function's shape, so a re-added pre-check fails.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

import os from "node:os";
// The racers sit beside this file; the harnesses go in a stable temp folder of their own.
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
fs.mkdirSync(SP, { recursive: true });
const LOCK = "F:/Claude Scratchpad Archive/_window-test.lock";
const SCRIPT = "C:/Users/satoh/.claude/scripts/repo-archive.mjs";
const RACERS = 6;
const GAP_MS = 40;
const LEAD_MS = 4000; // node startup here has run past 700ms with six processes launching at once

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

async function race(mode) {
  try { fs.rmSync(LOCK, { force: true }); } catch {}
  const startAt = Date.now() + LEAD_MS;
  const out = await Promise.all(Array.from({ length: RACERS }, () => new Promise((resolve) => {
    execFile(process.execPath, [`${HERE}/window-racer.mjs`, mode, LOCK, String(startAt), String(GAP_MS)],
      { encoding: "utf8" }, (_e, stdout) => resolve(String(stdout).trim()));
  })));
  const parsed = out.map((line) => {
    const [result, delta] = line.split(" ");
    return { result, delta: Number(delta) };
  });
  return {
    parsed,
    won: parsed.filter((p) => p.result === "won").length,
    lost: parsed.filter((p) => p.result === "lost").length,
    spread: Math.max(...parsed.map((p) => p.delta)) - Math.min(...parsed.map((p) => p.delta)),
    show: parsed.map((p) => `${p.result}@${p.delta}ms`).join(" "),
  };
}

// 0. The barrier has to hold, or neither result below means anything. Every process must arrive
//    well inside the window the losers would otherwise miss.
const oldRun = await race("old");
console.log(`      old (check, ${GAP_MS}ms gap, write): ${oldRun.show}`);
check(`barrier held: all ${RACERS} arrived within the ${GAP_MS}ms window`, oldRun.spread < GAP_MS, `spread ${oldRun.spread}ms`);

// 1. The OLD algorithm, with the window open: more than one process believes it won.
check("old form: more than one sweep holds the lock", oldRun.won > 1, `${oldRun.won} of ${RACERS} won`);

// 2. The SHIPPED algorithm, same barrier: exactly one, and the losers lost for the right reason.
const newRun = await race("new");
console.log(`      new (atomic wx):                 ${newRun.show}`);
check("shipped form: exactly one sweep holds the lock", newRun.won === 1, `${newRun.won} of ${RACERS} won`);
check("shipped form: every loser got EEXIST, not an unexpected error", newRun.lost === RACERS - 1, newRun.show);

// 3. The production function must have no check before the create — this is what regresses.
const src = fs.readFileSync(SCRIPT, "utf8");
const body = src.slice(src.indexOf("function acquireLock() {"), src.indexOf("function sweepTree("));
const createAt = body.indexOf("flag: 'wx'");
check("production acquireLock creates the lock atomically with 'wx'", createAt > 0);
check("production acquireLock does NOT stat the lock before creating it",
  createAt > 0 && !/statSync\(LOCK\)/.test(body.slice(0, createAt)),
  body.slice(0, createAt).includes("statSync") ? "a pre-check is back" : "no pre-check");
check("production acquireLock still takes over a stale lock after the create fails",
  /EEXIST[\s\S]*statSync\(LOCK\)[\s\S]*LOCK_STALE_MS[\s\S]*rmSync\(LOCK/.test(body.slice(createAt)));

try { fs.rmSync(LOCK, { force: true }); } catch {}
console.log(failed === 0 ? "\nALL WINDOW TESTS PASS" : `\n${failed} WINDOW TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
