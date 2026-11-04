#!/usr/bin/env node
/**
 * Refresh the tier-1 board cache in the background, so the status bar reflects something recent
 * rather than whatever was last read by hand.
 *
 * 🔴 IT RUNS DETACHED, NOT ON THE SESSION-START PATH. `needs-you-status.mjs` spawns this and returns
 * immediately; nothing waits for it. A cold board is four network reads and about two and a half
 * seconds, which is not a cost session start may pay — the whole point of the status row is that it
 * costs nothing to look at.
 *
 * 🔴 AND IT TAKES A LOCK, BECAUSE THE OWNER RUNS A DOZEN SESSIONS. Without one, opening several
 * sessions while the cache is stale would fire four GitHub reads EACH — a thundering herd against
 * the API for one answer they would all share. The lock is an atomic `wx` create; whoever wins
 * refreshes, everyone else does nothing at all. A lock older than LOCK_STALE_MS is ignored, so a
 * refresher killed mid-run (the memory watchdog reaps node jobs under pressure) cannot wedge this
 * off for ever.
 *
 * 🔴 IT NEVER REPORTS FAILURE ANYWHERE. There is no screen for it and no alarm: a refresh that did
 * not happen shows up honestly as an OLDER reading on the status row, because that row always prints
 * the age. That is the whole reason the age is printed — a silent staleness would need an alarm, a
 * visible one does not.
 *
 * `PHX_NEEDS_YOU_REFRESH_OFF=1` disables it, matching `PHX_DEV_REAPER_OFF` and
 * `PHX_PRIMARY_GUARD_OFF`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.join(os.tmpdir(), 'phoenix-needs-you-refresh.lock');
const LOCK_STALE_MS = 5 * 60_000;
/**
 * A cache younger than this is not worth four GitHub reads, whoever asked. Kept a little under the
 * caller's own 15-minute threshold so a refresh triggered right at the boundary is not refused by a
 * rounding difference between the two clocks.
 */
const FRESH_ENOUGH_MS = 14 * 60_000;
/** The board is four network reads; give it room but never let it hang around. */
const REFRESH_TIMEOUT_MS = 90_000;

function takeLock() {
  try {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age > LOCK_STALE_MS) fs.rmSync(LOCK, { force: true });
    else return false; // Somebody newer is already on it.
  } catch {
    // No lock file at all — fall through and try to create one.
  }
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false; // Lost the race. Exactly the outcome the lock exists for.
  }
}

function main() {
  if (process.env.PHX_NEEDS_YOU_REFRESH_OFF === '1') return;

  const script = process.argv[2];
  if (!script || !fs.existsSync(script)) return;
  const repo = path.dirname(path.dirname(script));

  // 🔴 AN AGE GUARD OF ITS OWN, NOT ONLY THE CALLER'S. The lock stops CONCURRENT refreshers; it does
  // nothing about sequential ones, because each releases before the next looks. Measured: six runs
  // back to back all did the full four network reads, 24.6s in total, because the only age check
  // lived upstream in needs-you-status.mjs. This makes the refresher safe whoever calls it and
  // however often — the lock and this guard cover the two different ways it would otherwise be
  // wasteful.
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'phoenix-needs-you.json'), 'utf8'));
    if (typeof cached?.collectedAt === 'number' && Date.now() - cached.collectedAt < FRESH_ENOUGH_MS) return;
  } catch {
    // No cache, or an unreadable one — that IS a reason to refresh. Fall through.
  }

  if (!takeLock()) return;

  try {
    // `--fresh` ignores the 60-second cache; `--quiet` keeps it to one line we discard. The CLI
    // writes the cache itself, which is the only thing this run is for.
    const result = spawnSync(process.execPath, [script, '--fresh', '--quiet'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: REFRESH_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) return; // gh missing, not authed, offline — all the same answer: leave the row older.

    // Re-render the status line from the cache we just refreshed. The guard env var stops that run
    // spawning another refresh and recursing.
    // `import.meta.dirname`, never a hand-decoded file URL: on Windows that pathname arrives as
    // `/C:/Users/...` with %20 for every space, and stripping the leading slash still leaves the
    // escapes — a path under "Phoenix Workforce" would silently never be found.
    const status = path.join(import.meta.dirname, 'needs-you-status.mjs');
    if (fs.existsSync(status)) {
      spawnSync(process.execPath, [status], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo, PHX_NEEDS_YOU_NO_REFRESH: '1' },
        input: '',
        timeout: 20_000,
        windowsHide: true,
      });
    }
  } finally {
    try {
      fs.rmSync(LOCK, { force: true });
    } catch {}
  }
}

try {
  main();
} catch {
  // Never let a background refresh become a visible failure.
}
