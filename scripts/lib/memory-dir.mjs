// memory-dir.mjs — WHICH session-memory directory a Phoenix checkout reads, and where the cloud
// mirror's drift reading for that directory is kept between sessions.
//
// WHY THIS EXISTS (2026-10-09, hook speed fixes). The SessionStart guard
// (`.claude/hooks/memory-index-guard.mjs`) used to compare every live memory note against the cloud
// mirror on `origin/main` itself: 1,225 notes read in full (about 12 MB on this laptop) plus a
// `git ls-tree` and a `git cat-file --batch` over ~1,222 blobs, on every session start, with every
// session waiting for it. The whole hook was recorded at p50 2.0 s and worst 11.1 s. The comparison
// now runs in `scripts/cloud-mirror-drift-refresh.mjs`, an ASYNC SessionStart entry no session waits
// for, which leaves its answer in a cache file; the guard only reads that file.
//
// The two scripts must agree on the memory directory to the byte, or the guard looks for a cache the
// refresher never wrote and the alarm goes quiet with nothing anywhere saying so. The guard cannot be
// imported by the refresher (it reads its environment and exits at the top level), so the resolution
// lives here, ONE copy, and both import it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { primaryRootOf } from "./git-layout.mjs";

/**
 * The primary checkout's root, or null when neither the disk nor git can answer.
 *
 * Memory belongs to the PROJECT, not to the worktree a session happens to be sitting in, and
 * `repo-doctor.mjs` resolves it exactly this way. Without it a worktree session would look up a
 * slug of its own `_wt-*` path, find no directory, and stay silent — muting the warning for the
 * sessions that do most of the appending.
 *
 * 2026-10-09 (hook speed fixes): read off disk first (`git-layout.mjs` reads the same `.git` files
 * git does), because a process start is the expensive part of a hook on this laptop. Git is asked
 * only when the layout cannot be read — a folder outside any checkout, GIT_DIR set, a dangling
 * worktree pointer — and then exactly as before.
 */
export function primaryRootFor(dir) {
  try {
    const fromDisk = primaryRootOf(dir);
    if (fromDisk) return path.resolve(fromDisk);
  } catch {
    // fall through to git
  }
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return commonDir ? path.resolve(path.dirname(commonDir)) : null;
  } catch {
    return null;
  }
}

/**
 * `<config>/projects/<slug>/memory` for a checkout, or null when it does not exist. The slug is the
 * absolute path with every non-alphanumeric character replaced by a hyphen, so
 * `F:\Phoenix Workforce\phoenix-workforce` becomes `F--Phoenix-Workforce-phoenix-workforce` — the
 * doubled hyphen is the drive colon plus the separator, not a typo. `CLAUDE_CONFIG_DIR` relocates
 * the config root when set.
 */
export function memoryDirFor(root) {
  const configRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const slug = path.resolve(root).replace(/[^A-Za-z0-9]/g, "-");
  const dir = path.join(configRoot, "projects", slug, "memory");
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** The memory directory a session in `projectDir` reads: the primary checkout's first, then its own. */
export function resolveMemoryDir(projectDir) {
  const roots = [primaryRootFor(projectDir), projectDir].filter(Boolean);
  return roots.map(memoryDirFor).find(Boolean) ?? null;
}

/**
 * How old a drift reading may be before the refresher takes a new one. Sessions start in bursts —
 * several parallel ones, plus a resume and a clear each — and the mirror only moves when a refresh
 * MERGES, so a reading taken half an hour ago answers the question as well as a new one.
 */
export const DRIFT_CACHE_REFRESH_MS = 30 * 60 * 1000;

/**
 * How old a drift reading may be and still be PRINTED. Past a day it may describe a mirror that has
 * since been refreshed and merged, and a false "CLOUD MIRROR IS STALE" is the alarm sessions learn
 * to skip — so an old reading says nothing, the same under-claiming direction the guard takes when
 * the mirror cannot be read at all.
 */
export const DRIFT_CACHE_SHOW_MS = 24 * 60 * 60 * 1000;

/**
 * `<os.tmpdir()>/phx-cloud-mirror-drift-<slug of the memory directory>.json`. Named from the MEMORY
 * directory rather than the checkout, so the primary and every worktree of one project share one
 * reading (they share one memory), while a second config root (another account, a test's
 * CLAUDE_CONFIG_DIR) never reads another's.
 */
export function driftCacheFile(memoryDir) {
  const slug = path.resolve(memoryDir).replace(/[^A-Za-z0-9]/g, "-");
  return path.join(os.tmpdir(), `phx-cloud-mirror-drift-${slug}.json`);
}

const isNameList = (value) => Array.isArray(value) && value.every((name) => typeof name === "string");

/** A drift reading as `cloudMirrorDrift` returns it, or null for "no reading" (mirror unreadable). */
function isDriftOrNull(drift) {
  if (drift === null) return true;
  return (
    typeof drift === "object"
    && Number.isFinite(drift.compared)
    && Number.isFinite(drift.drifted)
    && isNameList(drift.stale)
    && isNameList(drift.missing)
    && isNameList(drift.extra)
    && drift.drifted === drift.stale.length + drift.missing.length + drift.extra.length
  );
}

/**
 * The cached reading for `memoryDir` when it is younger than `maxAgeMs`, else null.
 *
 * Anything doubtful reads as NO reading — a missing or half-written file, a reading for another
 * memory directory, a timestamp from the future, a drift object of the wrong shape. Null makes the
 * guard say nothing and the refresher take a new reading, which is the safe answer for both.
 *
 * @returns {{ at: number, memoryDir: string, drift: object | null } | null}
 */
export function readDriftCache(memoryDir, { maxAgeMs, now = Date.now() } = {}) {
  try {
    const cache = JSON.parse(fs.readFileSync(driftCacheFile(memoryDir), "utf8"));
    if (!cache || typeof cache !== "object") return null;
    if (typeof cache.memoryDir !== "string" || path.resolve(cache.memoryDir) !== path.resolve(memoryDir)) return null;
    const age = now - cache.at;
    if (!Number.isFinite(age) || age < 0 || !(age < maxAgeMs)) return null;
    return isDriftOrNull(cache.drift) ? cache : null;
  } catch {
    return null;
  }
}

/**
 * Write the reading for `memoryDir` ATOMICALLY: a temp file beside it, then a rename. A guard
 * reading at the same moment sees the old reading or the new one, never half of one — and a
 * half-written file would read as no reading at all, silencing a real alarm.
 */
export function writeDriftCache(memoryDir, payload) {
  const file = driftCacheFile(memoryDir);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(payload));
    fs.renameSync(temp, file);
    return true;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // nothing more to do — the next refresh writes again
    }
    return false;
  }
}
