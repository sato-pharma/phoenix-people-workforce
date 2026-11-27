// Does the rewritten lock actually hold? Four checks, the last one with real concurrent work.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { sweepRepos } from "file:///C:/Users/satoh/.claude/scripts/repo-archive.mjs";

const ARCHIVE = "F:/Claude Scratchpad Archive";
const LOCK = `${ARCHIVE}/_repo-sweep.lock`;
const LOG = `${ARCHIVE}/_archive.log`;
import os from "node:os";
// The racers sit beside this file; the harnesses go in a stable temp folder of their own.
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
fs.mkdirSync(SP, { recursive: true });
const PHOENIX = "F:/Phoenix Workforce/phoenix-workforce";

const lastLine = (s) => String(s).trim().split(String.fromCharCode(10)).pop().trim();
const clean = () => { try { fs.rmSync(LOCK, { force: true }); } catch {} };
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};
const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 26 }, (e, out, err) =>
    // The script's own say() line lands on stdout too, so the verdict is the LAST line.
    resolve({ out: lastLine(out), raw: String(out).trim(), err: String(err).trim(), code: e ? e.code ?? 1 : 0 }));
});

// If a real scheduled sweep is holding the lock right now, say so instead of fighting it.
if (fs.existsSync(LOCK)) {
  const age = Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 1000);
  console.log(`NOTE  a lock was already present (${age}s old, pid ${fs.readFileSync(LOCK, "utf8")}) — a scheduled sweep may be running`);
  if (age < 120) { console.log("ABORT  not going to race a live sweep; re-run in a minute"); process.exit(3); }
  clean();
}

// 1. 'wx' atomicity on THIS filesystem (F: is where the archive lives — NTFS is assumed, not proven).
clean();
const racerRaw = `${SP}/wx-racer.mjs`;
fs.writeFileSync(racerRaw, [
  'import fs from "node:fs";',
  `try { fs.writeFileSync("${LOCK}", String(process.pid), { flag: "wx" }); process.stdout.write("won"); }`,
  'catch (e) { process.stdout.write(e.code === "EEXIST" ? "lost" : "err:" + e.code); }',
].join("\n"));
const raw = await Promise.all(Array.from({ length: 8 }, () => run([racerRaw])));
const won = raw.filter((r) => r.out === "won").length;
check("wx is atomic on the archive drive: exactly one of 8 wins", won === 1, raw.map((r) => r.out).join(" "));
clean();

// 2. A FRESH lock -> refused, and the other sweep's lock is left untouched.
fs.writeFileSync(LOCK, "999999");
check("fresh lock: the sweep is refused", sweepRepos({ only: [] }) === null);
check("fresh lock: the other sweep's lock survives",
  fs.existsSync(LOCK) && fs.readFileSync(LOCK, "utf8") === "999999");

// 3. A STALE lock (past LOCK_STALE_MS = 15 min) -> taken over, and the takeover is logged.
const logBefore = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
const old = Date.now() - 16 * 60 * 1000;
fs.utimesSync(LOCK, new Date(old), new Date(old));
check("stale lock: taken over and the sweep runs", sweepRepos({ only: [] }) !== null);
check("stale lock: released in the finally block", !fs.existsSync(LOCK));
// logBefore is a BYTE size, so the new part is cut as bytes: the log holds non-ASCII text (dashes, Arabic
// file names), and cutting the decoded string at a byte count skipped the new line (fixed 2026-11-06).
const logAfter = fs.existsSync(LOG) ? fs.readFileSync(LOG).subarray(logBefore).toString("utf8") : "";
check("stale lock: the takeover is in the log", /took over a stale lock \(9[0-9][0-9]s old\)/.test(logAfter),
  logAfter.trim().split("\n").pop() ?? "");

// 4. No lock at all -> it runs and cleans up.
clean();
check("no lock: the sweep runs", sweepRepos({ only: [] }) !== null);
check("no lock: the lock is released afterwards", !fs.existsSync(LOCK));

// 5. THE REAL RACE: four processes sweeping the phoenix repo at once, each holding the lock for
//    real work. Exactly one may run; the rest must be refused, not crash and not half-sweep.
clean();
const started = Date.now();
const results = await Promise.all(Array.from({ length: 4 }, () => run([`${HERE}/lock-racer.mjs`, PHOENIX])));
console.log(`      race took ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const r of results) console.log(`      -> ${r.out || "(no output)"}${r.err ? ` stderr: ${r.err.split("\n")[0]}` : ""}`);
const ran = results.filter((r) => r.out.startsWith("ran"));
const skipped = results.filter((r) => r.out === "skipped");
check("race on real work: exactly one sweep ran", ran.length === 1, `${ran.length} ran, ${skipped.length} skipped`);
check("race on real work: every other process was refused", skipped.length === 3);
check("race on real work: nobody exited non-zero", results.every((r) => r.code === 0));
check("race on real work: the winner really walked the tree", ran.length === 1 && /seen=\d\d+/.test(ran[0].out), ran[0]?.out);
check("race on real work: the lock is not left behind", !fs.existsSync(LOCK));

console.log(failed === 0 ? "\nALL LOCK TESTS PASS" : `\n${failed} LOCK TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
