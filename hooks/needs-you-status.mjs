#!/usr/bin/env node
/**
 * SessionStart: turn the tier-1 board's cache into ONE pre-rendered statusline row.
 *
 * 🔴 WHY THIS EXISTS AS A SEPARATE STEP AT ALL, instead of the statusline just reading the cache.
 * The statusline runs on the critical path of opening a session (~90ms budget) and must spawn
 * nothing. But the cache holds RAW FACTS — open PRs, branch protection, the production revision —
 * and turning those into "what is waiting on him" is `classifyPr`/`buildBoard` in
 * `scripts/needs-you.mjs`. Re-implementing that rule here would give the laptop a second, drifting
 * copy of the bucket logic, which is exactly the defect this module spent a PR removing from the
 * CEO command centre. So: this hook imports the repo's own functions and writes a tiny
 * already-rendered file; the statusline becomes a dumb printer.
 *
 * 🔴 IT MAKES NO NETWORK CALL. It reads the cache the CLI already wrote and nothing else. Session
 * start is not the place to wait on four GitHub reads, and with a dozen sessions open it would be
 * a dozen bursts of them. The consequence is that the row can be STALE — so the age is printed
 * rather than hidden. A figure that reads as live and is forty minutes old is worse than one that
 * says how old it is; the RAM row on this same statusline had exactly that complaint on 2026-09-21.
 *
 * 🔴 A NAME, NEVER A BARE COUNT. "Needs you: 3" is what the statusline used to be worth, and the
 * owner's own verdict on it was that it read 9 for hours and nobody acted — a count needs a second
 * lookup before it can be acted on, and that lookup is the step nobody takes. A PR number and the
 * reason are actionable from the status bar itself.
 *
 * 🔴 AND IT PRINTS NOTHING WHEN NOTHING IS WAITING. A row that says "nothing needs you" every
 * session is a row he stops reading, and it is the one sentence that becomes a lie the moment a
 * source fails. Silence here means "no PR is waiting on you, as of the reading" — never "all
 * clear", which is a claim this cache cannot support.
 *
 * Fails open and silent in every arm. A hook that breaks session start is worse than no hook.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FACTS = path.join(os.tmpdir(), 'phoenix-needs-you.json');
const OUT = path.join(os.tmpdir(), 'phoenix-needs-you-status.json');

/**
 * How stale a reading may be before a background refresh is worth spending four GitHub reads on.
 *
 * Fifteen minutes, not one: the statusline prints the AGE, so a slightly old reading is honest
 * rather than wrong, and the owner opens sessions constantly — a short window would mean refreshing
 * on almost every one of them for a board that rarely changes between two of them.
 */
const REFRESH_AFTER_MS = 15 * 60_000;

/** Walk up from a starting directory looking for the repo's own board script. */
function findScript(start) {
  let dir = start;
  for (let i = 0; i < 8 && dir; i += 1) {
    const candidate = path.join(dir, 'scripts', 'needs-you.mjs');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

async function main() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
  } catch {
    // No cache at all means this laptop has not asked the board anything yet. That is NOT a failed
    // read and must not render as one — an UNKNOWN row on every session until somebody runs the CLI
    // is noise, and noise is how a real UNKNOWN later gets ignored.
    try { fs.rmSync(OUT, { force: true }); } catch {}
    return;
  }
  if (!raw || typeof raw.collectedAt !== 'number') {
    try { fs.rmSync(OUT, { force: true }); } catch {}
    return;
  }

  // The session's own directory, then the relay's, then cwd — whichever finds the repo first.
  let input = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) input = JSON.parse(stdin);
  } catch {}
  const starts = [process.env.CLAUDE_PROJECT_DIR, input?.cwd, process.cwd()].filter(Boolean);
  let script = null;
  for (const start of starts) {
    script = findScript(start);
    if (script) break;
  }
  if (!script) return; // Not a Phoenix session. Nothing to say.

  let board;
  try {
    const mod = await import(`file://${script.replace(/\\/g, '/')}`);
    if (typeof mod.buildBoard !== 'function') return;
    board = mod.buildBoard({
      prs: raw.prs,
      protection: raw.protection,
      production: raw.production,
      now: Date.now(),
    });
  } catch {
    return; // A board we cannot build is not a board we may guess at.
  }

  let line = null;
  if (Array.isArray(board?.unknown) && board.unknown.length > 0) {
    // 🔴 UNKNOWN OUTRANKS a waiting PR. Something could not be read, so the list of what is waiting
    // is itself unproven — leading with a confident "merge 4571" would present a partial board as
    // the whole one.
    const n = board.unknown.length;
    line = `UNKNOWN - ${n} thing${n === 1 ? '' : 's'} on the board could not be read`;
  } else if (Array.isArray(board?.yours) && board.yours.length > 0) {
    const first = board.yours[0];
    const more = board.yours.length - 1;
    const reason = String(first.reason ?? '').replace(/\s+/g, ' ').trim();
    line = `merge ${first.number} - ${reason}${more > 0 ? ` (+${more} more)` : ''}`;
  }

  try {
    if (!line) fs.rmSync(OUT, { force: true });
    else fs.writeFileSync(OUT, JSON.stringify({ collectedAt: raw.collectedAt, line, writtenAt: Date.now() }), 'utf8');
  } catch {}

  // 🔴 REFRESH A STALE READING IN THE BACKGROUND, DETACHED, AND NEVER WAIT FOR IT. The row above is
  // already written from whatever the cache held, so this run has nothing left to do; a cold board
  // is four network reads and about two and a half seconds, which session start must not pay.
  // `detached` + `unref` means this process can exit while the child keeps going, and the next
  // session (or the refresher's own re-render) picks up the newer reading.
  //
  // The child takes a LOCK. Without one, opening several sessions against a stale cache would fire
  // four GitHub reads EACH for one answer they would all share.
  //
  // PHX_NEEDS_YOU_NO_REFRESH is set by the refresher when it re-renders this line, which is what
  // stops the two spawning each other for ever.
  if (process.env.PHX_NEEDS_YOU_NO_REFRESH === '1' || process.env.PHX_NEEDS_YOU_REFRESH_OFF === '1') return;
  if (Date.now() - raw.collectedAt < REFRESH_AFTER_MS) return;
  try {
    const refresher = path.join(import.meta.dirname, 'needs-you-refresh.mjs');
    if (!fs.existsSync(refresher)) return;
    const child = spawn(process.execPath, [refresher, script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

main().catch(() => {});
