import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `repo-doctor --strip-idle` must count a worktree's `node_modules` junction as ONE path entry.
 *
 * Every worktree's `node_modules` is a junction to the primary's (scripts/new-session.mjs), and
 * `walk` follows the root it is handed. `cacheEntries` walked that root, so each worktree was
 * credited with the PRIMARY's whole tree: on 2026-10-12 three worktrees printed `-70,720 paths`
 * each and `Stripped 3 worktree(s), 212,160 path entries reclaimed`, a constant that was the
 * primary's size three times, while the strip had removed three links and the worktrees' own file
 * counts did not move. The read-only offer called the same function, so it advertised the same
 * fiction before the run.
 *
 * Behavioural, not a source pin: `repo-doctor.mjs` runs its inventory at import time, so the two
 * functions are cut out of the file and evaluated against a real temp tree.
 */

const DOCTOR = path.join("scripts", "repo-doctor.mjs");

function loadCacheEntries(): (dir: string) => number {
  const src = fs.readFileSync(DOCTOR, "utf8");
  const start = src.indexOf("function walk(dir)");
  const cacheAt = src.indexOf("function cacheEntries(dir)");
  assert.ok(start >= 0 && cacheAt > start, "repo-doctor.mjs must still define walk and cacheEntries");
  const end = src.indexOf("\n}\n", cacheAt) + 3;
  const body = src.slice(start, end);
  return new Function("fs", "path", `${body}\nreturn cacheEntries;`)(fs, path) as (dir: string) => number;
}

export function runRepoDoctorCacheEntriesLinkTests() {
  const cacheEntries = loadCacheEntries();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phx-cache-entries-"));
  try {
    const primaryModules = path.join(root, "primary", "node_modules");
    for (let i = 0; i < 40; i++) {
      fs.mkdirSync(path.join(primaryModules, `pkg-${i}`), { recursive: true });
      fs.writeFileSync(path.join(primaryModules, `pkg-${i}`, "index.js"), "x");
    }

    const linked = path.join(root, "wt-linked");
    fs.mkdirSync(linked);
    fs.symlinkSync(primaryModules, path.join(linked, "node_modules"), "junction");
    assert.equal(
      cacheEntries(linked),
      1,
      "a node_modules junction is ONE path entry; counting the primary's 80 behind it is what reported 212,160 reclaimed for three links",
    );

    const real = path.join(root, "wt-real");
    fs.mkdirSync(path.join(real, ".next", "cache"), { recursive: true });
    fs.writeFileSync(path.join(real, ".next", "a.js"), "x");
    fs.writeFileSync(path.join(real, ".next", "cache", "b.js"), "x");
    assert.equal(cacheEntries(real), 3, "a real .next directory is still walked: 2 files + 1 directory");

    const mixed = path.join(root, "wt-mixed");
    fs.mkdirSync(path.join(mixed, ".next"), { recursive: true });
    fs.writeFileSync(path.join(mixed, ".next", "a.js"), "x");
    fs.symlinkSync(primaryModules, path.join(mixed, "node_modules"), "junction");
    assert.equal(cacheEntries(mixed), 2, "a link plus a real cache adds one for the link and the walk for the rest");

    const stripped = path.join(root, "wt-stripped");
    fs.mkdirSync(stripped);
    assert.equal(cacheEntries(stripped), 0, "an already-stripped worktree holds nothing to reclaim");

    const dangling = path.join(root, "wt-dangling");
    fs.mkdirSync(dangling);
    fs.symlinkSync(path.join(root, "gone"), path.join(dangling, "node_modules"), "junction");
    assert.equal(cacheEntries(dangling), 1, "a dangling link is still a path entry the strip removes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
