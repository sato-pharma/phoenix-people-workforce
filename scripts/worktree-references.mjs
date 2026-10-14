// Does a RUNNING process still intend to use this worktree, though nothing is standing in it?
//
// WHY THIS IS ITS OWN FILE, NEXT TO worktree-liveness.mjs. That module asks "is a process's
// working directory inside the folder" by reading each process's PEB. It cannot see a process that
// has NOT YET ENTERED the folder, and a parked background chain is exactly that.
//
// HIT LIVE 2026-09-17, ABOUT 11:30 CAIRO. `repo-doctor --strip-idle` emptied `node_modules` and
// `.next` from two worktrees whose sessions had queued work behind a memory waiter:
//
//   - `_wt-closing-details-publication-gate`: a bash chain queued since 09:44,
//       cd "F:/Phoenix Workforce/_wt-closing-details-publication-gate" && node <scratchpad>/wait-for-dev-window.mjs 230
//         && PHOENIX_ENABLE_DEV_AUTH_HEADERS=true node node_modules/next/dist/bin/next dev --webpack --port 3000
//     The waiter sat in `node`, its cwd the primary; the folder name lived only in the BASH
//     process's command line. When memory freed, the dev server would have died with
//     MODULE_NOT_FOUND.
//   - `_wt-weekly-dashboard-owner-rules`: `wait-dev-slot.mjs 8` parked since 09:45 "to resume the
//     browser checks" there, plus a scratchpad `wait-live.mjs` that hard-codes the folder.
//
// Files untouched for 120 minutes cannot tell a finished session from one parked behind a waiter,
// and a sleeping process has no activity of its own to show. The one durable trace is TEXT: the
// folder is named in a running process's command line, or in the source of a script that process is
// running. This module reads exactly that.
//
// THE DIRECTION IS ONE-WAY. A name match only ever REFUSES a strip or a retirement; it never
// clears one. A comment in some long-running script that merely mentions a worktree keeps that
// worktree's cache for as long as the script runs, which costs disk and nothing else. And, like
// the PEB probe, a sweep that cannot run answers "held" — never "free".
//
// WHAT IT STILL CANNOT SEE, stated so it is not read as total: a script that BUILDS the path at
// run time from pieces, a process whose command line Windows will not show, and a session that
// has queued nothing and is simply open at a prompt in an `_wt-*` folder (that one is the
// transcript signal's job, and its blind spot is documented in repo-doctor-session-hold.mjs).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ pid: number, name: string, commandLine: string }} ProcessRow
 * @typedef {{ rows: ProcessRow[] }} ProcessProbe
 */

/** A script bigger than this is a bundle or a log, not a waiter — skipping it only reads as "no mention". */
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** The kinds of file a running process takes as its program: only these are opened and read. */
const SCRIPT_EXTENSION = /\.(?:mjs|cjs|js|ts|mts|cts|ps1|sh|bash|cmd|bat)$/i;

/**
 * The folder's own name, however it is spelled in the text that names it.
 *
 * `_wt-<task>` and `.claude/worktrees/<name>` are the only two shapes this repo has, and a script
 * rarely carries the whole absolute path (it computes it from the sibling root), so the NAME is
 * what is matched — preceded by `worktrees` + a separator for a nested one, so an unrelated word
 * that happens to equal a nested worktree's name cannot refuse it.
 *
 * @param {string} dir
 * @returns {{ name: string, nested: boolean } | null}
 */
export function worktreeNameOf(dir) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const parts = dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const name = parts[parts.length - 1];
  if (!name) return null;
  const nested = parts[parts.length - 2]?.toLowerCase() === "worktrees" && parts[parts.length - 3]?.toLowerCase() === ".claude";
  if (!nested && !name.startsWith("_wt-")) return null;
  return { name, nested };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `text` name this worktree?
 *
 * The right-hand boundary is the point: this repo names worktrees by extending a shared stem
 * (`_wt-pharmacy`, `_wt-pharmacy-guard`), so a bare substring test would let one folder's waiter
 * pin another. `_wt-foo.` and `_wt-foo/` and `_wt-foo"` end a name; `_wt-foo-bar` and `_wt-foo2`
 * do not. JSON-escaped (`\\`) and mixed separators are covered by `[\\/]+`.
 *
 * @param {string} dir
 * @param {string} text
 */
export function textNamesWorktree(dir, text) {
  const wt = worktreeNameOf(dir);
  if (!wt || typeof text !== "string" || !text) return false;
  const stem = escapeRegExp(wt.name);
  const lead = wt.nested ? "worktrees[\\\\/]+" : "(?<![A-Za-z0-9_-])";
  return new RegExp(`${lead}${stem}(?![A-Za-z0-9_-])`, "i").test(text);
}

/**
 * Candidate program/script paths in a command line.
 *
 * Quoted segments are kept whole (a scratchpad path under `C:\Users\...\Temp` has no spaces, but a
 * repo path here always does), and an MSYS `/c/Users/...` spelling is mapped to a drive letter,
 * since the bash tool hands node exactly that.
 *
 * @param {string} commandLine
 * @returns {string[]}
 */
export function scriptPathsIn(commandLine, { msys = process.platform === "win32" } = {}) {
  if (typeof commandLine !== "string") return [];
  const out = [];
  for (const m of commandLine.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    let token = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!SCRIPT_EXTENSION.test(token)) continue;
    // On Linux `/c/x` is a real path, so the drive mapping is a Windows-only reading.
    const drive = msys ? /^\/([a-zA-Z])\/(.*)$/.exec(token) : null;
    if (drive) token = `${drive[1].toUpperCase()}:/${drive[2]}`;
    out.push(token);
  }
  return out;
}

/**
 * Parse the process sweep's JSON. Null for anything unparseable — "could not tell", never "none".
 *
 * @param {string} stdout
 * @returns {ProcessProbe | null}
 */
export function parseProcessProbe(stdout) {
  if (typeof stdout !== "string") return null;
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = parsed
    .map((r) => ({
      pid: Number(r?.ProcessId ?? r?.pid),
      name: String(r?.Name ?? r?.name ?? "").trim() || "unknown",
      commandLine: String(r?.CommandLine ?? r?.commandLine ?? ""),
    }))
    .filter((r) => Number.isFinite(r.pid));
  // The positive control: a machine always runs more than a handful of processes, so a list this
  // short means the sweep was refused or filtered, and an empty answer would read as "nothing queued".
  if (rows.length < 5) return null;
  return { rows };
}

/**
 * Every process whose command line — or whose script's source — names the worktree.
 *
 * @param {string} dir
 * @param {ProcessProbe | null} probe
 * @param {{ ownPid?: number, readFile?: (p: string) => string | null, baseDirs?: string[] }} [options]
 * @returns {{ pid: number, name: string, how: string }[]}
 */
export function referenceHolders(dir, probe, { ownPid = process.pid, readFile = readScript, baseDirs = [] } = {}) {
  if (!probe) return [];
  const found = [];
  for (const row of probe.rows) {
    // The doctor itself carries no worktree in its command line, but it must never refuse over its
    // own existence, and a parent shell that ran `cd <wt> && node repo-doctor` IS a genuine holder.
    if (row.pid === ownPid) continue;
    if (textNamesWorktree(dir, row.commandLine)) {
      found.push({ pid: row.pid, name: row.name, how: "its command line names it" });
      continue;
    }
    for (const token of scriptPathsIn(row.commandLine)) {
      const candidates = path.isAbsolute(token) ? [token] : baseDirs.map((b) => path.resolve(b, token));
      let hit = null;
      for (const file of candidates) {
        const text = readFile(file);
        if (text !== null && textNamesWorktree(dir, text)) {
          hit = file;
          break;
        }
      }
      if (hit) {
        found.push({ pid: row.pid, name: row.name, how: `it runs ${path.basename(hit)}, whose source names it` });
        break;
      }
    }
  }
  return found;
}

/**
 * The reason a worktree is spoken for by a queued or parked process, or null when none is.
 * A probe that never ran answers HELD, in the same words every unknown in this family uses.
 *
 * @param {string} dir
 * @param {ProcessProbe | null} probe
 * @param {Parameters<typeof referenceHolders>[2]} [options]
 */
export function referenceHoldReason(dir, probe, options) {
  if (!probe) {
    return "cannot read the running processes' command lines, so a queued job aimed at it cannot be ruled out";
  }
  const holders = referenceHolders(dir, probe, options);
  if (!holders.length) return null;
  const who = holders.map((h) => `${h.name} pid ${h.pid}: ${h.how}`).join("; ");
  return `a running process is queued on it (${who})`;
}

function readScript(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * One sweep of every process's command line, for the whole machine. Filtered HERE, in JS, never in
 * the WMI query: a `Win32_Process` filter on CommandLine matches the very PowerShell running it.
 *
 * @param {{ run?: () => string }} [options]
 * @returns {ProcessProbe | null}
 */
export function readProcessProbe({ run = defaultRun } = {}) {
  try {
    return parseProcessProbe(run());
  } catch {
    return null;
  }
}

function defaultRun() {
  const command =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}
