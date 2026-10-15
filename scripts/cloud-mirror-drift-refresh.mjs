#!/usr/bin/env node
// Takes the cloud mirror's drift reading OFF the session-start path, and leaves it where the
// SessionStart guard can print it.
//
// WHY (2026-10-09, hook speed fixes). `.claude/hooks/memory-index-guard.mjs` used to take this reading
// itself, blocking: every live memory note read in full (1,225 files, about 12 MB on this laptop), one
// `git ls-tree -r origin/main` and one `git cat-file --batch` over ~1,222 blobs, then the comparison.
// It was measured at 299 ms for 1,066 files on 2026-10-02 on a quiet machine; the whole guard was then
// recorded at p50 2.0 s and worst 11.1 s across real session starts, and every session waited for it.
// This script does the same reading — the SAME `readMd`, `readCloudMirror` and `cloudMirrorDrift` calls
// the guard made — from an ASYNC SessionStart entry nobody waits for, and writes the answer to
// `<os.tmpdir()>/phx-cloud-mirror-drift-<slug of the memory directory>.json`
// (`scripts/lib/memory-dir.mjs`). The guard prints that reading, word for word as before, while it
// is under 24 hours old.
//
// THE TRADE, stated so nobody mistakes it for a live reading: the guard shows the reading taken at an
// earlier session start (this one's lands for the next). The mirror only moves when a refresh merges,
// and repo-doctor still measures it live for anyone who asks.
//
// It skips the work when the reading is under 30 minutes old — sessions start in bursts — prints
// nothing, and always exits 0. It reads NO stdin: the project directory comes from argv, then
// CLAUDE_PROJECT_DIR, then the working directory, exactly as the guard resolves it, so running it by
// hand with nothing piped in cannot hang.
import fs from "node:fs";
import path from "node:path";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "cloud-mirror-drift-refresh",
  entry: import.meta.url,
  known: [],
});

// FAIL OPEN, ALWAYS — a background drift reading must never surface as a hook error.
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

let memoryDirLib;
let cloudMirrorDrift;
let readCloudMirror;
try {
  memoryDirLib = await import("./lib/memory-dir.mjs");
  ({ cloudMirrorDrift } = await import("./cloud-mirror-drift.mjs"));
  ({ readCloudMirror } = await import("./cloud-mirror-source.mjs"));
} catch {
  process.exit(0); // a partial checkout — nothing to measure with
}
const { DRIFT_CACHE_REFRESH_MS, readDriftCache, resolveMemoryDir, writeDriftCache } = memoryDirLib;

// The guard's own rule for the project directory, character for character: argv, then
// CLAUDE_PROJECT_DIR, then the working directory.
const projectDir = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// No memory directory means this checkout has no live memory (CI, a fresh clone, a cloud session):
// there is nothing to compare, and the guard will not look for a reading either.
const memoryDir = resolveMemoryDir(projectDir);
if (memoryDir === null) process.exit(0);

if (readDriftCache(memoryDir, { maxAgeMs: DRIFT_CACHE_REFRESH_MS }) !== null) process.exit(0);

// Stamped BEFORE the reading, so the age a reader computes is never younger than the facts in it.
const at = Date.now();

// `drift: null` is "no reading" — the mirror could not be read at all, or anything below threw — and
// the guard says nothing for it, exactly as it said nothing when its own reading failed. It is still
// written, so a burst of session starts does not repeat a failing reading every time.
let drift = null;
let source = null;
try {
  const mirrorDir = path.join(projectDir, ".claude", "cloud-context", "memory-mirror");
  const readMd = (dir) => {
    const out = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".md") || name.includes(".bak")) continue;
      out.set(name, fs.readFileSync(path.join(dir, name), "utf8"));
    }
    return out;
  };
  // A mirror that cannot be read AT ALL is NOT drift — a checkout can legitimately not carry one —
  // and it is not "current" either. `repo-doctor` is where an unreadable mirror is reported out loud.
  const mirror = readCloudMirror({ root: projectDir, diskDir: mirrorDir });
  if (mirror !== null) {
    drift = cloudMirrorDrift({ live: readMd(memoryDir), mirror: mirror.files });
    source = mirror.source;
  }
} catch {
  drift = null;
  source = null;
}

writeDriftCache(memoryDir, { at, memoryDir, projectDir, source, drift });
process.exit(0);
