#!/usr/bin/env node
// phx-live-sync.mjs — keeps the Hetzner box's phx-live checkout identical to a folder on this laptop.
//
// Started by phx-live.ps1 in its own minimised window, after the box has been prepared at <base>:
//   node phx-live-sync.mjs --folder <dir> --base <sha> --devauth 0|1
//   node phx-live-sync.mjs --print-base --folder <dir>     prints the sha the box should start from
//
// It talks to the box as `phxlive`, whose ONLY command is /opt/phx-live/live-receiver.mjs (a forced
// command in authorized_keys): one JSON object per line each way. Nothing else on the box is reachable
// through this connection.
//
//   1. First sync: every file that differs from <base> (`git diff --name-status --no-renames <base>`)
//      plus every untracked, not-ignored file is written; files deleted locally are deleted.
//   2. Watch: fs.watch (recursive) → 150 ms debounce → filter through `git check-ignore` → write/delete.
//   3. Reconcile every 60 s: ask the box for the sha1 of every file we have ever touched or that now
//      differs from <base>, and re-send any that disagree. That is what repairs a missed watch event
//      (a git checkout, a mass rename, an editor that writes through a temp file).
//   4. Every 60 s it also reads `live-ctl.sh status` as phx; a scope that is inactive and NOT stopped
//      by the idle reaper (preview-state/3100.stopped) is restarted.
//   4b. In production-build mode (--mode fast, phx-live's default since 2026-10-16) the box rebuilds
//      after every save; every 15 s this reads the build state and prints each change — "rebuilding",
//      "SERVING … reload the page", or "BUILD FAILED" with the reason — since that is the moment a
//      saved edit actually reaches the page.
//   5. The ssh connection drops → wait 5 s, reconnect, resync from scratch.
//
// It never runs pnpm, a build or a typecheck here. Memory on this laptop: one node process (~50 MB).
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BOX = "46.225.184.142";
const KEY = path.join(os.homedir(), ".ssh", "railway_phoenix_ed25519");
const SSH_OPTS = ["-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
  "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];
const IGNORE_DIRS = new Set([".git", "node_modules", ".next", "xlsx", ".turbo", "coverage"]);
const MAX_FILE = 20 * 1024 * 1024;
const REBASE_OVER = 400; // more files than this differ from <base> → the box should move to a new base

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const FOLDER = path.resolve(arg("folder", "F:\\Phoenix Workforce\\phoenix-workforce"));
let BASE = arg("base", "");
const DEVAUTH = arg("devauth", "0") === "1" ? "1" : "0";
const MODE = arg("mode", "dev") === "fast" ? "fast" : "dev";

function git(args, input) {
  const r = spawnSync("git", ["-C", FOLDER, ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !args.includes("check-ignore")) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The sha the box checks out: HEAD when GitHub has it, else where HEAD left origin/main. */
export function chooseBase() {
  git(["fetch", "--quiet", "origin"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  const onRemote = git(["branch", "-r", "--contains", head]).trim();
  return onRemote ? head : git(["merge-base", head, "origin/main"]).trim();
}

if (process.argv.includes("--print-base")) {
  process.stdout.write(chooseBase() + "\n");
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/.test(BASE)) {
  console.error("usage: phx-live-sync.mjs --folder <dir> --base <40-char sha> [--devauth 0|1]");
  process.exit(2);
}

const stamp = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour12: false });
const log = (m) => console.log(`[${stamp()}] ${m}`);

function toRel(abs) {
  return path.relative(FOLDER, abs).split(path.sep).join("/");
}
function ignoredByName(rel) {
  const parts = rel.split("/");
  if (parts.some((p) => IGNORE_DIRS.has(p) || /^_wt-/.test(p))) return true;
  if (parts.some((p) => /^\.env/i.test(p))) return true;
  return false;
}
function filterIgnored(rels) {
  const cand = rels.filter((r) => r && !ignoredByName(r));
  if (!cand.length) return [];
  const out = git(["check-ignore", "--stdin"], cand.join("\n") + "\n");
  const ignored = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  return cand.filter((r) => !ignored.has(r));
}
function sha1OfLocal(rel) {
  try {
    return createHash("sha1").update(fs.readFileSync(path.join(FOLDER, rel))).digest("hex");
  } catch {
    return null;
  }
}
/** Every path that differs from BASE right now, plus untracked files. */
function changedSinceBase() {
  const paths = new Set();
  for (const line of git(["diff", "--name-status", "--no-renames", BASE]).split("\n")) {
    const m = line.match(/^[A-Z]\t(.+)$/);
    if (m) paths.add(m[1]);
  }
  for (const p of git(["ls-files", "-o", "--exclude-standard"]).split("\n")) if (p.trim()) paths.add(p.trim());
  return [...paths].filter((p) => !ignoredByName(p));
}

// ---- the connection --------------------------------------------------------------------------
let conn = null;
const touched = new Set(); // every path ever sent this run — the reconcile re-checks all of them

function connect() {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTS, `phxlive@${BOX}`], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const pending = [];
    const rl = readline.createInterface({ input: child.stdout });
    let first = true;
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.op === "installing") return log("lockfile moved — pnpm install on the box (1–2 min), HMR resumes after");
      if (msg.op === "refused") log(`box refused ${msg.path} (outside the checkout, or a protected path)`);
      if (msg.op === "error" && first) { child.kill(); return reject(new Error(msg.message)); }
      const p = pending.shift();
      if (p) p(msg);
    });
    child.on("exit", (code) => {
      if (conn && conn.child === child) conn = null;
      for (const p of pending.splice(0)) p({ op: "error", message: "connection closed" });
      if (first) reject(new Error(`ssh exited ${code}`));
    });
    const send = (obj) => new Promise((res) => {
      pending.push(res);
      child.stdin.write(JSON.stringify(obj) + "\n");
    });
    send({ op: "ping" }).then((pong) => {
      first = false;
      if (pong.op !== "pong") return reject(new Error(pong.message || "no pong"));
      conn = { child, send };
      resolve(pong);
    });
  });
}

async function pushPaths(rels) {
  if (!conn || !rels.length) return 0;
  let n = 0;
  for (const rel of rels) {
    const abs = path.join(FOLDER, rel);
    let st = null;
    try { st = fs.statSync(abs); } catch {}
    touched.add(rel);
    if (!st) { await conn.send({ op: "delete", path: rel }); n++; continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) { log(`skipped ${rel} (${Math.round(st.size / 1048576)} MB, over the 20 MB limit)`); continue; }
    const r = await conn.send({ op: "write", path: rel, b64: fs.readFileSync(abs).toString("base64") });
    if (r.op === "ok") n++;
  }
  const c = await conn.send({ op: "commit" });
  if (c.op === "installed") log(c.ok ? "pnpm install finished" : "pnpm install FAILED on the box:\n" + c.tail);
  return n;
}

async function reconcile(label) {
  if (!conn) return;
  const changed = changedSinceBase();
  if (changed.length > REBASE_OVER) {
    log(`${changed.length} files differ from the box base ${BASE.slice(0, 9)} — run  phx-live -Resync  to move the box to this folder's HEAD`);
  }
  const all = [...new Set([...changed, ...touched])];
  const paths = filterIgnored(all);
  if (!paths.length) return;
  const m = await conn.send({ op: "manifest", paths });
  if (m.op !== "manifest") return;
  const stale = paths.filter((p) => (m.hashes[p] ?? null) !== sha1OfLocal(p));
  if (stale.length) {
    const n = await pushPaths(stale);
    log(`${label}: ${n} file(s) brought in line${stale.length <= 6 ? " — " + stale.join(", ") : ""}`);
  } else if (label === "first sync") {
    log(`first sync: box already matches (${paths.length} changed file(s) vs base)`);
  }
}

// ---- watch -----------------------------------------------------------------------------------
const queued = new Set();
let timer = null;
function onEvent(_type, filename) {
  if (!filename) return;
  const rel = filename.split(path.sep).join("/");
  if (ignoredByName(rel)) return;
  queued.add(rel);
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}
let flushing = false;
async function flush() {
  if (flushing) { timer = setTimeout(flush, 150); return; }
  flushing = true;
  try {
    const rels = filterIgnored([...queued]);
    queued.clear();
    if (rels.length && conn) {
      const t = Date.now();
      const n = await pushPaths(rels);
      if (n) log(`synced ${n} file(s) in ${Date.now() - t} ms${rels.length <= 4 ? " — " + rels.join(", ") : ""}`);
    }
  } catch (e) {
    log("sync error: " + e.message);
  } finally {
    flushing = false;
  }
}

// ---- the box's server ------------------------------------------------------------------------
function ctl(sub) {
  const r = spawnSync("ssh", [...SSH_OPTS, `phx@${BOX}`, `bash /home/phx/live-ctl.sh ${sub} 2>&1`], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}
async function watchServer() {
  const s = ctl("status");
  if (!/^STATUS /.test(s)) return log("could not read the box status: " + (s || "no answer"));
  const active = /scope=active/.test(s);
  const idle = !/idle_stopped=no/.test(s);
  if (!active && idle) {
    log("the box stopped phx-live after 60 idle minutes — run  phx-live  to start it again");
    return "idle";
  }
  if (!active) {
    log("phx-live's server is not running (killed or crashed) — restarting it");
    log(ctl(`serve ${DEVAUTH} ${MODE}`));
  }
}

// ---- production-build mode: say when a save has actually reached the page ---------------------
let lastBuild = null;
let watchingBuild = false;
function ctlAsync(cmd) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_OPTS, `phx@${BOX}`, cmd], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(out.trim()));
  });
}
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
    if (b === "building") log("the box is rebuilding with your edits (about 3 min) — the page keeps the previous build until then");
    else if (b === "serving") { if (!first) log("✅ SERVING your latest edits — reload the page"); }
    else if (b === "failed") {
      log("❌ the box build FAILED — the previous build keeps serving. The reason:");
      const tail = await ctlAsync("tail -40 /home/phx/live.log");
      const at = tail.lastIndexOf("BUILD FAILED");
      console.log((at >= 0 ? tail.slice(at) : tail).split("\n").slice(0, 32).join("\n"));
    }
  } finally {
    watchingBuild = false;
  }
}
if (MODE === "fast") setInterval(watchBuild, 15_000);

// ---- main ------------------------------------------------------------------------------------
async function session() {
  const pong = await connect();
  log(`connected · box base ${String(pong.base).slice(0, 9)} · folder ${FOLDER}`);
  if (pong.base && pong.base !== BASE) log(`🔴 the box is at ${pong.base.slice(0, 9)}, not ${BASE.slice(0, 9)} — run  phx-live -Resync`);
  await reconcile("first sync");
}

async function main() {
  log(`phx-live sync — ${FOLDER} → box (base ${BASE.slice(0, 9)}, ${MODE === "fast" ? "production build: a save shows after a rebuild" : "next dev"}, dev-auth ${DEVAUTH === "1" ? "ON" : "off"})`);
  fs.watch(FOLDER, { recursive: true }, onEvent);
  let stopped = false;
  for (;;) {
    try {
      if (!conn) await session();
    } catch (e) {
      log("connection failed: " + e.message + " — retrying in 5 s");
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 60_000));
    try {
      if (conn) await reconcile("reconcile");
      if (!stopped && (await watchServer()) === "idle") stopped = true;
    } catch (e) {
      log("reconcile error: " + e.message);
    }
  }
}

main();
