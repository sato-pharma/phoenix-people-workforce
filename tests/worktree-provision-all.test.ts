import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isStaleEnvName } from "../scripts/lib/env-file-links.mjs";
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
//   2. it NEVER replaces an env file written AFTER the primary's (a worktree's env may differ),
//   3. it NEVER touches .claude/settings.local.json in a swept worktree (that
//      primary-wins refresh belongs only to the worktree a session is actually in),
//   4. it is idempotent — a second sweep changes nothing.
// And, since the credentials audit of 18 Nov 2026 (finding 3), one more:
//   5. an env file is a HARD LINK to the primary's, never a copy — one file on disk however many
//      worktrees there are, so a rotation in the primary leaves no stale production key behind.
//      An identical or older copy becomes a link, a link the primary has replaced is re-linked,
//      and a date-stamped, backup or retired env file is never handed out (env-file-links.mjs).

// The same file on disk under both names — what a hard link is, and what a copy is not.
function sameFile(a: string, b: string) {
  const x = fs.statSync(a, { bigint: true });
  const y = fs.statSync(b, { bigint: true });
  return x.ino !== BigInt(0) && x.ino === y.ino && x.dev === y.dev;
}

// Move a file's last-write time, so "older than the primary's" and "newer" are never a race.
function setAge(file: string, secondsFromNow: number) {
  const t = new Date(Date.now() + secondsFromNow * 1000);
  fs.utimesSync(file, t, t);
}

function mkTmp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A primary clone with a real node_modules and two gitignored env files — the link
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
      assert.deepEqual(r.linked.sort(), [...CANDIDATES].sort(), "both missing env files must be linked");
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
        "the env file must hold the primary's value",
      );
      for (const name of CANDIDATES) {
        assert.ok(
          sameFile(path.join(primary, name), path.join(worktree, name)),
          `${name} must be a HARD LINK to the primary's file, never a copy (credentials audit, finding 3)`,
        );
      }
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 2. An env file written AFTER the primary's is NEVER replaced (no --force) ──
  //
  // A worktree may deliberately carry its own values. A file edited after the primary's last write
  // is that, so a session's own env is never clobbered underneath it.
  {
    const primary = makePrimary();
    const worktree = mkTmp("prov-keepenv-");
    try {
      fs.writeFileSync(path.join(worktree, ".env.local"), "PHOENIX_AUTH_SECRET=worktree-own\n");
      setAge(path.join(worktree, ".env.local"), 60);
      const r = provisionDir(worktree, primary, CANDIDATES);
      assert.deepEqual(r.skipped, [".env.local"], ".env.local written after the primary's must be skipped");
      assert.deepEqual(r.linked, [".env.production.rls.local"], "only the missing env file is linked");
      assert.equal(
        fs.readFileSync(path.join(worktree, ".env.local"), "utf8"),
        "PHOENIX_AUTH_SECRET=worktree-own\n",
        "the worktree's own env must survive untouched — never overwritten without --force",
      );

      // ...but --force does re-link it, for the explicit repair case.
      const forced = provisionDir(worktree, primary, CANDIDATES, { force: true });
      assert.ok(forced.linked.includes(".env.local"), "--force re-links the existing env file");
      assert.ok(sameFile(path.join(primary, ".env.local"), path.join(worktree, ".env.local")), "--force leaves a link");
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
      assert.deepEqual(r.linked.sort(), [...CANDIDATES].sort(), "dry-run lists what WOULD be linked");
      assert.equal(fs.existsSync(path.join(worktree, ".env.local")), false, "dry-run links nothing");
      assert.equal(fs.existsSync(path.join(worktree, "node_modules")), false, "dry-run junctions nothing");
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }
  // ── 7. A copy left by the old copying sweep becomes a link: identical bytes, or OLDER bytes ──
  //
  // Measured 18 Nov 2026: 6 of 19 worktrees held an identical copy of the primary's .env.local and
  // 13 an older one, none edited after the primary's last write. Both are snapshots, never a
  // worktree's own choice, so both become the primary's file.
  {
    const primary = makePrimary();
    const worktree = mkTmp("prov-oldcopy-");
    try {
      fs.copyFileSync(path.join(primary, ".env.production.rls.local"), path.join(worktree, ".env.production.rls.local"));
      fs.writeFileSync(path.join(worktree, ".env.local"), "PHOENIX_AUTH_SECRET=an-old-rotated-value\n");
      setAge(path.join(worktree, ".env.local"), -3600);
      const r = provisionDir(worktree, primary, CANDIDATES);
      assert.deepEqual(r.linked.sort(), [...CANDIDATES].sort(), "an identical copy and an older copy are both re-linked");
      for (const name of CANDIDATES) {
        assert.ok(sameFile(path.join(primary, name), path.join(worktree, name)), `${name}: the old copy is now a link`);
      }
      assert.equal(
        fs.readFileSync(path.join(worktree, ".env.local"), "utf8"),
        "PHOENIX_AUTH_SECRET=from-primary\n",
        "the older copy's stale value is gone — the worktree reads the primary's current one",
      );
      assert.equal(wasChanged(provisionDir(worktree, primary, CANDIDATES)), false, "a linked worktree changes nothing on the next run");
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 8. A link the primary has REPLACED is followed to the primary's new file ──
  //
  // scripts/refresh-local-env.mjs renames the old .env.local aside and writes a fresh one, which
  // leaves every worktree's link on the OLD bytes (now the backup's). The next run re-links.
  {
    const primary = makePrimary();
    const worktree = mkTmp("prov-orphan-");
    try {
      provisionDir(worktree, primary, CANDIDATES);
      fs.renameSync(path.join(primary, ".env.local"), path.join(primary, ".env.local.bak-20261118-0100"));
      fs.writeFileSync(path.join(primary, ".env.local"), "PHOENIX_AUTH_SECRET=rotated\n");
      setAge(path.join(worktree, ".env.local"), 3600); // even a link that reads as newer is followed
      const r = provisionDir(worktree, primary, CANDIDATES);
      assert.ok(r.linked.includes(".env.local"), "a link left on the replaced file is re-linked");
      assert.ok(sameFile(path.join(primary, ".env.local"), path.join(worktree, ".env.local")), "it is the primary's NEW file");
      assert.equal(fs.readFileSync(path.join(worktree, ".env.local"), "utf8"), "PHOENIX_AUTH_SECRET=rotated\n");
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }

  // ── 9. Stale env files: never handed out; a worktree's covered copy removed, the rest kept ──
  {
    for (const name of [".env.production", ".env.sentry-build-plugin", ".env.local.production-20260921",
      ".env.local.staging-20260921", ".env.local.bak-20261118-0100", ".env.local.bak-before-encoding-repair"]) {
      assert.equal(isStaleEnvName(name), true, `${name} is stale and must never be provisioned`);
    }
    for (const name of [".env.local", ".env.production.rls.local", ".env.staging.rls.local", ".env.analytics"]) {
      assert.equal(isStaleEnvName(name), false, `${name} is a live env file and must still be provisioned`);
    }
    const primary = makePrimary();
    const worktree = mkTmp("prov-stale-");
    try {
      fs.writeFileSync(path.join(primary, ".env.production"), "DEAD_PROJECT=1\n");
      fs.writeFileSync(path.join(primary, ".env.local.production-20260921"), "SNAPSHOT=new\n");
      fs.writeFileSync(path.join(primary, ".env.local.staging-20260921"), "SNAPSHOT=primary\n");
      fs.writeFileSync(path.join(worktree, ".env.production"), "DEAD_PROJECT=1\n"); // identical
      fs.writeFileSync(path.join(worktree, ".env.local.production-20260921"), "SNAPSHOT=old\n");
      setAge(path.join(worktree, ".env.local.production-20260921"), -3600); // older than the primary's
      fs.writeFileSync(path.join(worktree, ".env.local.staging-20260921"), "SNAPSHOT=edited-here\n");
      setAge(path.join(worktree, ".env.local.staging-20260921"), 3600); // written after the primary's
      fs.writeFileSync(path.join(worktree, ".env.sentry-build-plugin"), "TOKEN=retired\n"); // no original
      const r = provisionDir(worktree, primary, CANDIDATES);
      assert.deepEqual(
        r.removed.sort(),
        [".env.local.production-20260921", ".env.production"],
        "an identical or older copy of a stale file goes — the primary keeps its own",
      );
      assert.equal(fs.existsSync(path.join(worktree, ".env.local.staging-20260921")), true, "a copy written after the primary's stays");
      assert.equal(fs.existsSync(path.join(worktree, ".env.sentry-build-plugin")), true, "a copy with no original stays");
      for (const name of [".env.production", ".env.local.production-20260921", ".env.local.staging-20260921"]) {
        assert.equal(fs.existsSync(path.join(primary, name)), true, `the primary's ${name} is never touched`);
      }
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }
}
