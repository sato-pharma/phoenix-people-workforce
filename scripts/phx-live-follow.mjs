#!/usr/bin/env node
// phx-live-follow.mjs — keeps phx-live on main, and only on main.
//
// Owner, 2026-10-17: "I want the PHX live to always run on main. Any update I will do, I will push to
// main and test on main, never on any branch." So the box no longer mirrors a laptop folder (that was
// phx-live-sync.mjs, kept for history): it serves GitHub's main and moves with it.
//
// Started by phx-live.ps1 in its own minimised window, after the box has been prepared at main:
//   node phx-live-follow.mjs --base <sha> --devauth 0|1 --mode fast|dev
//
//   1. Every 60 s: main's sha from GitHub (`gh api`), compared with the commit the BOX is on. A new one → `live-ctl.sh follow <sha>`, which moves
//      the RUNNING server's tree without stopping it: the production build rebuilds while the old build
//      keeps serving (about 3-4 min), `next dev` recompiles. When the dependencies changed it answers
//      NEEDS_INSTALL and this runs `prepare` + `serve` instead (about a minute with no server).
//   2. Every 60 s: `live-ctl.sh status`. A scope that is inactive and NOT stopped by the idle reaper is
//      restarted; one the reaper stopped after 60 idle minutes is left stopped.
//   3. Production-build mode: every 15 s the build state, and each change is printed — "rebuilding",
//      "SERVING main <sha> — reload the page", or "BUILD FAILED" with the reason.
//
// It never runs pnpm, a build or a typecheck on this laptop. One small node process.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const BOX = "46.225.184.142";
const REPO = "Gawish-1997/phoenix-people-workforce";
const KEY = path.join(os.homedir(), ".ssh", "railway_phoenix_ed25519");
const SSH_OPTS = ["-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
  "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
let base = arg("base", "");
const DEVAUTH = arg("devauth", "0") === "1" ? "1" : "0";
const MODE = arg("mode", "fast") === "dev" ? "dev" : "fast";

const cairo = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" });
const log = (msg) => console.log(`[${cairo()}] ${msg}`);
const short = (sha) => String(sha).slice(0, 9);

function ctl(sub) {
  const r = spawnSync("ssh", [...SSH_OPTS, `phx@${BOX}`, `bash /home/phx/live-ctl.sh ${sub} 2>&1`],
    { encoding: "utf8", windowsHide: true, timeout: 15 * 60_000 });
  return { out: (r.stdout || "").trim(), code: r.status };
}
function ctlAsync(cmd) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_OPTS, `phx@${BOX}`, cmd], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(out.trim()));
  });
}

/** main's sha on GitHub, or "" when GitHub cannot be read this minute. */
export function mainSha() {
  const r = spawnSync("gh", ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  const sha = (r.stdout || "").trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}

function follow(sha) {
  log(`main moved to ${short(sha)} — moving the box`);
  const f = ctl(`follow ${sha}`);
  if (/^FOLLOWED |^ALREADY /m.test(f.out)) {
    base = sha;
    log(f.out.split("\n").pop());
    if (MODE === "dev") log("next dev picks the change up as you open pages — reload");
    return;
  }
  if (/^NEEDS_INSTALL /m.test(f.out)) {
    log(f.out.split("\n").pop() + " — installing; the server is down for about a minute");
    const p = ctl(`prepare ${sha}`);
    p.out.split("\n").slice(-3).forEach((l) => log(l));
    if (!/^PREPARED /m.test(p.out)) return log("❌ prepare failed — the next minute tries again");
    base = sha;
    ctl(`serve ${DEVAUTH} ${MODE}`).out.split("\n").forEach((l) => l && log(l));
    return;
  }
  log("❌ could not move the box: " + (f.out || `no answer (exit ${f.code})`) + " — the next minute tries again");
}

/** "idle" when the reaper stopped it; otherwise the commit the box's tree is on (short), or "". */
async function watchServer() {
  const s = ctl("status").out;
  if (!/^STATUS /.test(s)) { log("could not read the box status: " + (s || "no answer")); return ""; }
  const active = /scope=active/.test(s);
  const idle = !/idle_stopped=no/.test(s);
  if (!active && idle) {
    log("the box stopped phx-live after 60 idle minutes — run  phx-live  to start it again");
    return "idle";
  }
  if (!active) {
    log("phx-live's server is not running (killed or crashed) — restarting it");
    ctl(`serve ${DEVAUTH} ${MODE}`).out.split("\n").forEach((l) => l && log(l));
  }
  return (s.match(/base=([0-9a-f]{7,40})/) || [])[1] || "";
}

let lastBuild = null;
let watchingBuild = false;
async function watchBuild() {
  if (watchingBuild) return;
  watchingBuild = true;
  try {
    const s = await ctlAsync("bash /home/phx/live-ctl.sh status 2>&1");
    const m = s.match(/build=(\S+)/);
    if (!m) return;
    const b = m[1];
    if (b === lastBuild) return;
    const first = lastBuild === null;
    lastBuild = b;
    const at = (s.match(/base=(\S+)/) || [])[1] || "?";
    if (b === "building") log(`the box is building main ${at} (about 3-4 min) — the page keeps the previous build until then`);
    else if (b === "serving") { if (!first) log(`✅ SERVING main ${at} — reload the page`); }
    else if (b === "failed") {
      log(`❌ the box build of main ${at} FAILED — the previous build keeps serving. The reason:`);
      const tail = await ctlAsync("tail -40 /home/phx/live.log");
      const i = tail.lastIndexOf("BUILD FAILED");
      console.log((i >= 0 ? tail.slice(i) : tail).split("\n").slice(0, 32).join("\n"));
    }
  } finally {
    watchingBuild = false;
  }
}

async function main() {
  log(`phx-live follow — the box serves main and moves with it (now ${short(base)}, ${MODE === "fast" ? "production build: a merge shows after a rebuild, about 3-4 min" : "next dev"}, dev-auth ${DEVAUTH === "1" ? "ON" : "off"})`);
  if (MODE === "fast") setInterval(watchBuild, 15_000);
  let stopped = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 60_000));
    try {
      if (stopped) continue;
      const onBox = await watchServer();
      if (onBox === "idle") { stopped = true; continue; }
      // Compared with what the BOX is on, not with what this window last did, so anything that moved
      // the box off main (a hand-run prepare, a restart at an old base) is put right within a minute.
      const sha = mainSha();
      if (sha && onBox && !sha.startsWith(onBox)) follow(sha);
    } catch (e) {
      log("follow error: " + e.message);
    }
  }
}

if (process.argv.includes("--print-main")) console.log(mainSha());
else main();
