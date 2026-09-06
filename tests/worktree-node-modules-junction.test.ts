import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { linkNodeModules } from "../scripts/lib/link-node-modules.mjs";

// The junction step both new-session.mjs and sync-worktree-env.mjs rely on to give
// a worktree its dependencies without ever running `pnpm install` there.
//
// WHY THIS EXISTS. Measured 2026-09-06: 12 of 20 worktrees on this machine had no
// node_modules at all — 11 of them the `.claude/worktrees/<name>` kind that Claude
// Code's native worktree feature creates WITHOUT running new-session.mjs, so its
// junction step never ran. In every one, `tsc`, `eslint`, `next dev` and
// `node scripts/…` failed with MODULE_NOT_FOUND, which reads as a path/permissions
// fault rather than a missing junction. sync-worktree-env.mjs runs at every
// SessionStart, so routing it through this shared helper self-heals such a
// worktree the moment a session opens in it. This test pins the four decisions and
// proves a real link is created and resolves — including on the Linux CI runner,
// where the Windows-only "junction" type degrades to a directory symlink.

function mkTmp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runWorktreeNodeModulesJunctionTests() {
  // ── A real link is created and resolves through to the primary's tree ──
  //
  // The headline: a fresh worktree with no node_modules gets a working link to the
  // primary's, so a file under the primary's node_modules is readable through the
  // worktree's. This is the exact MODULE_NOT_FOUND the 12 broken worktrees hit.
  const primary = mkTmp("wnmj-primary-");
  const worktree = mkTmp("wnmj-worktree-");
  try {
    fs.mkdirSync(path.join(primary, "node_modules", "some-dep"), { recursive: true });
    fs.writeFileSync(path.join(primary, "node_modules", "some-dep", "index.js"), "module.exports = 42;\n");

    assert.equal(fs.existsSync(path.join(worktree, "node_modules")), false, "precondition: worktree starts with no node_modules");

    const status = linkNodeModules(worktree, primary);
    assert.equal(status, "junctioned", "a fresh worktree with a healthy primary must be junctioned");

    // The link resolves: reading THROUGH the worktree's node_modules reaches the
    // primary's file. This is what makes require/import work, and the actual thing
    // that was broken.
    const throughLink = fs.readFileSync(
      path.join(worktree, "node_modules", "some-dep", "index.js"),
      "utf8",
    );
    assert.equal(throughLink, "module.exports = 42;\n", "the junction must resolve through to the primary's node_modules");

    // ── Idempotent: a second call is a no-op, not a re-link or a throw ──
    const again = linkNodeModules(worktree, primary);
    assert.equal(again, "already present", "an existing node_modules must never be re-linked");
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(primary, { recursive: true, force: true });
  }

  // ── Never clobbers a node_modules that is already there ──
  //
  // If a session left a stray real `pnpm install` in a worktree, this helper must
  // leave it exactly alone — replacing it is repo-doctor's call to REPORT, never
  // this script's to silently do. Proven by putting a real directory in place and
  // asserting its marker survives.
  const primary2 = mkTmp("wnmj-primary2-");
  const worktree2 = mkTmp("wnmj-worktree2-");
  try {
    fs.mkdirSync(path.join(primary2, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(worktree2, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(worktree2, "node_modules", "STRAY.txt"), "left by another session\n");

    const status = linkNodeModules(worktree2, primary2);
    assert.equal(status, "already present", "an existing node_modules wins the dest-first check");
    assert.equal(
      fs.existsSync(path.join(worktree2, "node_modules", "STRAY.txt")),
      true,
      "the pre-existing node_modules must be left untouched, never replaced",
    );
  } finally {
    fs.rmSync(worktree2, { recursive: true, force: true });
    fs.rmSync(primary2, { recursive: true, force: true });
  }

  // ── Refuses when the primary has no node_modules, rather than linking a hole ──
  //
  // A junction to a non-existent target would resolve to nothing and reproduce the
  // very MODULE_NOT_FOUND we are fixing, so this returns a clear message and
  // creates nothing.
  const primary3 = mkTmp("wnmj-primary3-");
  const worktree3 = mkTmp("wnmj-worktree3-");
  try {
    const status = linkNodeModules(worktree3, primary3);
    assert.equal(
      status,
      "the primary has no node_modules — run pnpm install THERE first",
      "with no primary node_modules the helper must refuse, not link a dangling junction",
    );
    assert.equal(
      fs.existsSync(path.join(worktree3, "node_modules")),
      false,
      "nothing must be created when the primary has no node_modules",
    );
  } finally {
    fs.rmSync(worktree3, { recursive: true, force: true });
    fs.rmSync(primary3, { recursive: true, force: true });
  }

  // ── --dry-run reports the intent and changes nothing ──
  const primary4 = mkTmp("wnmj-primary4-");
  const worktree4 = mkTmp("wnmj-worktree4-");
  try {
    fs.mkdirSync(path.join(primary4, "node_modules"), { recursive: true });

    const status = linkNodeModules(worktree4, primary4, { dryRun: true });
    assert.equal(status, "would-link", "dryRun with a link needed must report would-link");
    assert.equal(
      fs.existsSync(path.join(worktree4, "node_modules")),
      false,
      "dryRun must not create the junction",
    );
  } finally {
    fs.rmSync(worktree4, { recursive: true, force: true });
    fs.rmSync(primary4, { recursive: true, force: true });
  }
}
