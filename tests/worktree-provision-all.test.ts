import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { provisionDir, sweepWorktrees, wasChanged } from "../scripts/lib/provision-worktree.mjs";

// The machine-wide sweep behind `sync-worktree-env.mjs --all` and the SessionStart
// hook (owner rule, 2026-09-30: "nodes and pnpm/npm auto installed in all working
// trees"). sync-worktree-env used to provision only the ONE worktree a session was
// in; worktrees created any other way — the app's native `.claude/worktrees/`, the
// dependabot/cloud `agent-*` folders, a bare `git worktree add`, a detached checkout
// — stayed NOT RUNNABLE (no node_modules, no env) until someone ran `--repair` by
// hand. This pins the four properties that keep the sweep safe to run automatically,
// on every session, across another live session's worktree:
//   1. it makes a fresh worktree runnable (junction + missing env),
//   2. it NEVER overwrites an env file already there (a worktree's env may differ),
//   3. it NEVER touches .claude/settings.local.json in a swept worktree (that
//      primary-wins refresh belongs only to the worktree a session is actually in),
//   4. it is idempotent — a second sweep changes nothing.

function mkTmp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A primary clone with a real node_modules and two gitignored env files — the copy
// and junction source for every worktree.
function makePrimary() {
  const primary = mkTmp("prov-primary-");
  fs.mkdirSync(path.join(primary, "node_modules", "some-dep"), { recursive: true });
  fs.writeFileSync(path.join(primary, "node_modules", "some-dep", "index.js"), "module.exports = 7;\n");
  fs.writeFileSync(path.join(primary, ".env.local"), "PHOENIX_AUTH_SECRET=from-primary\n");
  fs.writeFileSync(path.join(primary, ".env.production.rls.local"), "RLS=from-primary\n");
  return primary;
}
const CANDIDATES = [".env.local", ".env.production.rls.local"];

export function runWorktreeProvisionAllTests() {
  // ── 1. A fresh worktree is made runnable: junction + both env files ──
  {
    const primary = makePrimary();
    const worktree = mkTmp("prov-fresh-");
    try {
      const r = provisionDir(worktree, primary, CANDIDATES);
      assert.equal(r.present, true, "a real directory must be marked present");
      assert.equal(r.modulesStatus, "junctioned", "a fresh worktree must get a node_modules junction");
      assert.deepEqual(r.copied.sort(), [...CANDIDATES].sort(), "both missing env files must be copied");
      assert.equal(wasChanged(r), true, "a fresh provision counts as changed");

      // The junction resolves through to the primary's dependency, and the env file
      // holds the primary's value — the worktree can now actually run.
      assert.equal(
        fs.readFileSync(path.join(worktree, "node_modules", "some-dep", "index.js"), "utf8"),
        "module.exports = 7;\n",
        "the junction must resolve through to the primary's node_modules",
      );
      assert.equal(
        fs.readFileSync(path.join(worktree, ".env.local"), "utf8"),
        "PHOENIX_AUTH_SECRET=from-primary\n",
        "the env file must be copied from the primary",
      );
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 2. An env file already in the worktree is NEVER overwritten (no --force) ──
  //
  // A worktree may deliberately point at a different environment. The sweep copies
  // only what is MISSING, so a session's own env is never clobbered underneath it.
  {
    const primary = makePrimary();
    const worktree = mkTmp("prov-keepenv-");
    try {
      fs.writeFileSync(path.join(worktree, ".env.local"), "PHOENIX_AUTH_SECRET=worktree-own\n");
      const r = provisionDir(worktree, primary, CANDIDATES);
      assert.deepEqual(r.skipped, [".env.local"], ".env.local already present must be skipped");
      assert.deepEqual(r.copied, [".env.production.rls.local"], "only the missing env file is copied");
      assert.equal(
        fs.readFileSync(path.join(worktree, ".env.local"), "utf8"),
        "PHOENIX_AUTH_SECRET=worktree-own\n",
        "the worktree's own env must survive untouched — never overwritten without --force",
      );

      // ...but --force does overwrite, for the explicit repair case.
      const forced = provisionDir(worktree, primary, CANDIDATES, { force: true });
      assert.ok(forced.copied.includes(".env.local"), "--force overwrites the existing env file");
      assert.equal(
        fs.readFileSync(path.join(worktree, ".env.local"), "utf8"),
        "PHOENIX_AUTH_SECRET=from-primary\n",
        "--force replaces the worktree's env with the primary's",
      );
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 3. The sweep NEVER writes .claude/settings.local.json into a swept worktree ──
  //
  // This is the one thing that makes it safe to sweep a folder another session is
  // running in: it writes only gitignored env + the node_modules junction, never the
  // permission file. That refresh stays the job of the sync run for the worktree a
  // session is actually IN.
  {
    const primary = makePrimary();
    // Give the primary a settings.local.json, to prove the sweep does NOT propagate it.
    fs.mkdirSync(path.join(primary, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(primary, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(ls)"]}}\n');
    const worktree = mkTmp("prov-nosettings-");
    try {
      provisionDir(worktree, primary, CANDIDATES);
      assert.equal(
        fs.existsSync(path.join(worktree, ".claude", "settings.local.json")),
        false,
        "the sweep must NEVER create a settings.local.json in a swept worktree",
      );
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 4. A registered worktree whose folder is gone (a husk) is skipped, not thrown on ──
  {
    const primary = makePrimary();
    const gone = path.join(os.tmpdir(), "prov-husk-does-not-exist-" + Date.now());
    try {
      const r = provisionDir(gone, primary, CANDIDATES);
      assert.equal(r.present, false, "a missing worktree folder must be marked not-present");
      assert.equal(wasChanged(r), false, "a husk is never counted as changed");
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 5. sweepWorktrees provisions all OTHERS, skips primary + skip list, is idempotent ──
  {
    const primary = makePrimary();
    const wtA = mkTmp("prov-A-");
    const wtB = mkTmp("prov-B-");
    const current = mkTmp("prov-current-");
    try {
      const dirs = [primary, wtA, wtB, current];
      // `current` stands for the worktree the session is in — already synced, so skipped.
      const results = sweepWorktrees(primary, dirs, CANDIDATES, { skip: [current] });
      const touched = results.map((r) => path.basename(r.dir)).sort();
      assert.deepEqual(
        touched,
        [path.basename(wtA), path.basename(wtB)].sort(),
        "sweep must touch every worktree except the primary and the skipped current one",
      );
      for (const r of results) assert.equal(wasChanged(r), true, "each fresh worktree is provisioned");

      // Neither the primary nor the current worktree was written into.
      assert.equal(fs.existsSync(path.join(current, ".env.local")), false, "the skipped current worktree is untouched");
      assert.equal(fs.existsSync(path.join(wtA, ".env.local")), true, "worktree A got its env");
      assert.equal(fs.existsSync(path.join(wtB, "node_modules")), true, "worktree B got its junction");

      // A second sweep changes nothing — the property that keeps the SessionStart
      // hook quiet on a healthy machine.
      const again = sweepWorktrees(primary, dirs, CANDIDATES, { skip: [current] });
      for (const r of again) {
        assert.equal(wasChanged(r), false, "a second sweep of an already-provisioned worktree changes nothing");
      }
    } finally {
      for (const d of [wtA, wtB, current]) fs.rmSync(d, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 6. --dry-run reports intent and writes nothing ──
  {
    const primary = makePrimary();
    const worktree = mkTmp("prov-dry-");
    try {
      const r = provisionDir(worktree, primary, CANDIDATES, { dryRun: true });
      assert.equal(r.modulesStatus, "would-link", "dry-run reports the would-link intent");
      assert.deepEqual(r.copied.sort(), [...CANDIDATES].sort(), "dry-run lists what WOULD be copied");
      assert.equal(fs.existsSync(path.join(worktree, ".env.local")), false, "dry-run copies nothing");
      assert.equal(fs.existsSync(path.join(worktree, "node_modules")), false, "dry-run junctions nothing");
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }
}
