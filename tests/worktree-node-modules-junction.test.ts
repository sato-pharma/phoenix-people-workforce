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

  // ── A DANGLING junction — the link entry exists, its target is gone — gets
  //    healed, not misdiagnosed as EEXIST ──
  //
  // This is the actual failure mode PR #3398 shipped without covering
  // (AGENTS.md §5): running `pnpm` inside a worktree purges the PRIMARY's
  // node_modules THROUGH the junction, so every OTHER worktree's link is left
  // pointing at nothing. Before this fix, `fs.existsSync(dest)` reads that as
  // "missing" — it follows the dead link and finds nothing — so the healer
  // tried to create a fresh junction over the same path and got EEXIST (the
  // link ENTRY is still there even though its target is not), which surfaced
  // as "could not link: ..." — reading as a permissions or path fault rather
  // than a stale junction, the same misdiagnosis shape §2.1 records for
  // `pnpm exec` failing silently. Reproduced here exactly, then healed.
  const primary5 = mkTmp("wnmj-primary5-");
  const worktree5 = mkTmp("wnmj-worktree5-");
  const oldTarget5 = mkTmp("wnmj-oldtarget5-");
  try {
    // The worktree's node_modules starts as a junction to a real directory...
    fs.mkdirSync(path.join(oldTarget5, "some-dep"), { recursive: true });
    fs.symlinkSync(oldTarget5, path.join(worktree5, "node_modules"), "junction");

    // ...then that target is purged — simulating the pnpm-inside-a-worktree
    // incident — leaving the worktree's link dangling.
    fs.rmSync(oldTarget5, { recursive: true, force: true });

    // The exact three-line reproduction from the bug report, pinned so a
    // future Node/Windows change to this behaviour is caught here first.
    const dest5 = path.join(worktree5, "node_modules");
    assert.equal(
      fs.existsSync(dest5),
      false,
      "a dangling junction must read as not-existing via existsSync — this is the trap the old code fell into",
    );
    assert.doesNotThrow(() => fs.lstatSync(dest5), "lstatSync must still see the dead link entry itself");

    // The primary has a real, healthy node_modules to relink to.
    fs.mkdirSync(path.join(primary5, "node_modules", "some-dep"), { recursive: true });
    fs.writeFileSync(path.join(primary5, "node_modules", "some-dep", "index.js"), "module.exports = 43;\n");

    const status = linkNodeModules(worktree5, primary5);
    assert.equal(
      status,
      "relinked (stale junction removed)",
      "a dangling junction must be healed and reported with a status distinct from a fresh link or a real EEXIST failure",
    );

    // The new link resolves through to the PRIMARY's current tree, not the dead one.
    const throughLink = fs.readFileSync(path.join(dest5, "some-dep", "index.js"), "utf8");
    assert.equal(
      throughLink,
      "module.exports = 43;\n",
      "the relinked junction must resolve to the primary's CURRENT node_modules, not the purged target",
    );
  } finally {
    fs.rmSync(worktree5, { recursive: true, force: true });
    fs.rmSync(primary5, { recursive: true, force: true });
    fs.rmSync(oldTarget5, { recursive: true, force: true });
  }

  // ── dryRun on a dangling junction removes nothing and creates nothing ──
  const primary6 = mkTmp("wnmj-primary6-");
  const worktree6 = mkTmp("wnmj-worktree6-");
  const oldTarget6 = mkTmp("wnmj-oldtarget6-");
  try {
    fs.mkdirSync(oldTarget6, { recursive: true });
    fs.symlinkSync(oldTarget6, path.join(worktree6, "node_modules"), "junction");
    fs.rmSync(oldTarget6, { recursive: true, force: true });
    fs.mkdirSync(path.join(primary6, "node_modules"), { recursive: true });

    const status = linkNodeModules(worktree6, primary6, { dryRun: true });
    assert.equal(
      status,
      "would-relink (stale junction)",
      "dryRun on a dangling junction must report intent without acting, distinctly from would-link",
    );

    // The dangling link entry must still be there, untouched — dryRun removes nothing.
    let stillDangling = false;
    try {
      fs.lstatSync(path.join(worktree6, "node_modules"));
      stillDangling = true;
    } catch {
      stillDangling = false;
    }
    assert.equal(stillDangling, true, "dryRun must not remove the stale junction");
  } finally {
    fs.rmSync(worktree6, { recursive: true, force: true });
    fs.rmSync(primary6, { recursive: true, force: true });
  }

  // ── THE HARD CAUTION: removing a stale link entry must NEVER be recursive —
  //    it must never touch whatever the link still points at. ──
  //
  // Proven directly against the exact primitives link-node-modules.mjs uses to
  // remove a stale junction (fs.unlinkSync, falling back to fs.rmdirSync for
  // Windows builds that reject unlink on a directory-type reparse point), on a
  // link that is very much alive — the worst case if this code ever ran
  // against a link that turned out not to be dangling after all. A future
  // change to `fs.rmSync(dest, { recursive: true })` here would fail this test
  // by deleting `precious.txt` along with the link, instead of leaving it
  // untouched. This is the same property AGENTS.md requires of dropping a
  // junction with cmd's non-recursive `rmdir`, never `Remove-Item -Recurse`
  // (which can follow a junction into the primary and destroy real files).
  const liveTarget = mkTmp("wnmj-live-target-");
  const linkParent = mkTmp("wnmj-link-parent-");
  try {
    fs.writeFileSync(path.join(liveTarget, "precious.txt"), "do not delete me\n");
    const link = path.join(linkParent, "node_modules");
    fs.symlinkSync(liveTarget, link, "junction");

    try {
      fs.unlinkSync(link);
    } catch (err) {
      // `err` is `unknown` in TypeScript, so it must be narrowed before reading `.code`.
      // The .mjs module can write `err.code` directly because JavaScript is not typechecked
      // that way — which is why this pattern compiled there and not here.
      const code = (err as { code?: string }).code;
      if (code === "EPERM" || code === "EISDIR") {
        fs.rmdirSync(link);
      } else {
        throw err;
      }
    }

    assert.equal(
      fs.existsSync(path.join(liveTarget, "precious.txt")),
      true,
      "removing a link must NEVER remove the directory (or its contents) it points at — the non-recursive property this fix depends on",
    );
    let linkGone = true;
    try {
      fs.lstatSync(link);
      linkGone = false;
    } catch {
      linkGone = true;
    }
    assert.equal(linkGone, true, "the link entry itself must be gone after removal");
  } finally {
    fs.rmSync(liveTarget, { recursive: true, force: true });
    fs.rmSync(linkParent, { recursive: true, force: true });
  }
}
