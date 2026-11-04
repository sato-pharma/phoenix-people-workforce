#!/usr/bin/env node
// remove-ftp-github-mcp.mjs — one-shot: remove the dead `github` MCP server from the
// "F:/FTP 2026/FTP PORTAL" entry in ~/.claude.json, but ONLY while no Claude Code session is running.
//
// Why (settings review, 17 Sep 2026): the entry sends `Authorization: Bearer ${GITHUB_MCP_PAT}` and that
// variable is set nowhere (process, Windows user, Windows machine), so every session in that checkout
// fails to connect it ("Authorization header is badly formatted"). Nothing in the FTP Portal repository
// uses the server; GitHub work there goes through the `gh` CLI.
//
// Why it waits: every Claude Code session rewrites ~/.claude.json, so an edit made while one is open
// can be written straight back over. The owner's rule is to touch the file only with no session open.
//
//   node remove-ftp-github-mcp.mjs --log <file>            # one check; removes only if no session is open
//   node remove-ftp-github-mcp.mjs --log <file> --watch    # polls every 2 min until done (gives up after 14 days)
//
// Refuses (and logs why) if: a session is open; the entry is already gone; the header no longer reads
// `Bearer ${GITHUB_MCP_PAT}`; or GITHUB_MCP_PAT has since been set anywhere — someone meant to use it.
// Every write is backup-first, validated, then temp-and-rename, then read back.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const WATCH = argv.includes("--watch");
const LOG = arg("--log") || path.join(os.homedir(), ".claude", "scripts", "remove-ftp-github-mcp.log");
const FILE = path.join(os.homedir(), ".claude.json");
const PROJECT = "F:/FTP 2026/FTP PORTAL";
const SERVER = "github";
const EXPECTED_HEADER = "Bearer ${GITHUB_MCP_PAT}";
const POLL_MS = 120_000;
const CLEAR_POLLS_NEEDED = 2; // sessions flush the file on exit; wait one more poll after the last closes
const GIVE_UP_MS = 14 * 24 * 3600_000;

const cairo = () => new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo", hour12: false });
function log(msg) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${cairo()} Cairo  ${msg}\n`); } catch {}
}

/** Claude Code CLI processes: the desktop app's bundled claude.exe, a native install, or the npm CLI.
 *  The desktop app's own Claude.exe (WindowsApps\Claude_*) is not a session and is ignored. */
function openSessions() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' or Name='node.exe'\" | " +
    "ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8", timeout: 60_000, windowsHide: true,
  });
  return out.split(/\r?\n/).filter(Boolean).filter((line) => {
    const [pid, exe = "", cmd = ""] = line.split("\t");
    if (Number(pid) === process.pid) return false;
    const e = exe.toLowerCase().replace(/\//g, "\\");
    const c = cmd.toLowerCase().replace(/\//g, "\\");
    if (e.includes("\\windowsapps\\claude_")) return false; // the desktop shell, not a session
    if (e.endsWith("\\claude.exe")) return true;
    return c.includes("@anthropic-ai\\claude-code") || c.includes("\\npm\\claude");
  });
}

function tokenSetAnywhere() {
  if (process.env.GITHUB_MCP_PAT) return true;
  const ps =
    "[bool]([Environment]::GetEnvironmentVariable('GITHUB_MCP_PAT','User')) -or " +
    "[bool]([Environment]::GetEnvironmentVariable('GITHUB_MCP_PAT','Machine'))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8", timeout: 60_000, windowsHide: true,
  }).trim().toLowerCase() === "true";
}

/** Returns "done" | "gone" | "wait" | "refuse". */
function attempt() {
  const sessions = openSessions();
  if (sessions.length) return { state: "wait", why: `${sessions.length} Claude Code process(es) open` };

  const raw = fs.readFileSync(FILE, "utf8");
  const j = JSON.parse(raw);
  const server = j.projects?.[PROJECT]?.mcpServers?.[SERVER];
  if (!server) return { state: "gone", why: "the entry is already absent" };
  const header = server.headers?.Authorization;
  if (header !== EXPECTED_HEADER) return { state: "refuse", why: "the Authorization header changed since the review; left alone" };
  if (tokenSetAnywhere()) return { state: "refuse", why: "GITHUB_MCP_PAT is now set; someone means to use the server; left alone" };

  const backup = `${LOG.replace(/\.log$/, "")}.claude.json.${Date.now()}.bak`;
  fs.writeFileSync(backup, raw);
  delete j.projects[PROJECT].mcpServers[SERVER];
  const out = JSON.stringify(j, null, 2) + "\n";
  JSON.parse(out);

  // Last look immediately before the rename: a session that opened during the backup wins.
  if (openSessions().length) return { state: "wait", why: "a session opened while preparing the write; not written" };
  fs.writeFileSync(FILE + ".github-mcp.tmp", out);
  fs.renameSync(FILE + ".github-mcp.tmp", FILE);

  const back = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (back.projects?.[PROJECT]?.mcpServers?.[SERVER]) return { state: "wait", why: "read back still shows the server; will retry" };
  return { state: "done", why: `removed; backup ${backup}; ${Object.keys(back.projects[PROJECT].mcpServers).length} server(s) left in that entry` };
}

const started = Date.now();
let clear = 0;
log(`start pid ${process.pid} ${WATCH ? "watch" : "once"}`);
for (;;) {
  let r;
  try {
    // Two consecutive session-free polls before writing, so a session that just closed has flushed.
    const sessions = openSessions();
    clear = sessions.length ? 0 : clear + 1;
    r = clear >= (WATCH ? CLEAR_POLLS_NEEDED : 1) ? attempt() : { state: "wait", why: `${sessions.length} Claude Code process(es) open` };
  } catch (e) {
    r = { state: "wait", why: `error: ${e?.message ?? e}` };
  }
  if (r.state !== "wait" || !WATCH) { log(`${r.state}: ${r.why}`); process.exit(r.state === "wait" ? 3 : 0); }
  if (Date.now() - started > GIVE_UP_MS) { log(`gave up after 14 days: ${r.why}`); process.exit(4); }
  await new Promise((res) => setTimeout(res, POLL_MS));
}
