// The scratchpad sweep's lock — the one the Stop hook fires at the end of every turn in every
// session. Behaviour through its own exported entry point, plus the structural assertion that
// catches a re-added pre-check. `only: []` sweeps nothing, so no file is copied by this test.
import fs from "node:fs";
import { sweep } from "file:///C:/Users/satoh/.claude/scripts/scratchpad-archive.mjs";

const ARCHIVE = "F:/Claude Scratchpad Archive";
const LOCK = `${ARCHIVE}/_sweep.lock`;
const LOG = `${ARCHIVE}/_archive.log`;
const SCRIPT = "C:/Users/satoh/.claude/scripts/scratchpad-archive.mjs";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};
const clear = () => { try { fs.rmSync(LOCK, { force: true }); } catch {} };

if (fs.existsSync(LOCK)) {
  const age = Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 1000);
  if (age < 120) { console.log(`ABORT  a live sweep holds the lock (${age}s old) — re-run shortly`); process.exit(3); }
  clear();
}

// 1. A fresh lock is another sweep's: refuse, and leave it exactly as it was.
fs.writeFileSync(LOCK, "999999");
check("fresh lock: the sweep is refused", sweep({ only: [] }) === null);
check("fresh lock: the other sweep's lock is untouched",
  fs.existsSync(LOCK) && fs.readFileSync(LOCK, "utf8") === "999999");

// 2. A lock past 15 minutes belonged to a killed sweep: take it over, and say so in the log.
const logBefore = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
const old = Date.now() - 16 * 60 * 1000;
fs.utimesSync(LOCK, new Date(old), new Date(old));
check("stale lock: taken over and the sweep runs", sweep({ only: [] }) !== null);
check("stale lock: released in the finally block", !fs.existsSync(LOCK));
const logAfter = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").slice(logBefore) : "";
check("stale lock: the takeover is logged", /took over a stale lock \(9[0-9][0-9]s old\)/.test(logAfter),
  logAfter.trim().split("\n").pop() ?? "");

// 3. No lock: runs and cleans up.
clear();
check("no lock: the sweep runs", sweep({ only: [] }) !== null);
check("no lock: the lock is released", !fs.existsSync(LOCK));

// 4. The shape that regresses.
const body = fs.readFileSync(SCRIPT, "utf8");
const fn = body.slice(body.indexOf("function acquireLock() {"), body.indexOf("export function sweep("));
const createAt = fn.indexOf("flag: 'wx'");
check("the lock is created atomically with 'wx'", createAt > 0);
check("nothing stats the lock before creating it", createAt > 0 && !/statSync\(LOCK\)/.test(fn.slice(0, createAt)),
  fn.slice(0, createAt).includes("statSync") ? "a pre-check is back" : "no pre-check");
check("a stale lock is still taken over after the create fails",
  /EEXIST[\s\S]*LOCK_STALE_MS[\s\S]*rmSync\(LOCK/.test(fn.slice(createAt)));

console.log(failed === 0 ? "\nALL SIBLING LOCK TESTS PASS" : `\n${failed} SIBLING LOCK TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
