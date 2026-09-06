// The ONE implementation of "point this worktree's node_modules at the primary's".
//
// A worktree NEVER installs its own dependencies. `pnpm install` (or any `pnpm
// run`/`pnpm exec`) inside a worktree runs its deps-status check first, sees the
// lockfile has moved, and PURGES node_modules — destroying the junction, and
// with it the primary's copy that every session on this machine shares (AGENTS.md
// §5). So the only safe way to give a worktree its dependencies is a Windows
// junction to the primary's already-installed tree.
//
// `git worktree add` never copies node_modules (it is gitignored), and Claude
// Code's native `.claude/worktrees/<name>` worktrees are created WITHOUT running
// new-session.mjs's four-step ritual — so a nested worktree starts with no
// node_modules at all, and every local `tsc`, `eslint`, `next dev` and
// `node scripts/…` there fails with MODULE_NOT_FOUND. That reads as a path or
// permissions fault rather than a missing junction, so it costs a confused
// detour every time. Measured 2026-09-06: 12 of 20 worktrees had no node_modules,
// 11 of them the nested kind that new-session.mjs never touches.
//
// This lived as a private `linkModules` in new-session.mjs. sync-worktree-env.mjs
// needed the identical behaviour to self-heal a worktree at every SessionStart,
// and a second byte-identical copy is exactly the drift trap that let a title
// caser stay "fixed in one of two places" (AGENTS.md §2.1). One module now,
// imported by both.
//
// IDEMPOTENT AND NON-DESTRUCTIVE. It never touches an existing node_modules —
// junction or real directory — so it cannot clobber a stray `pnpm install` a
// session left behind (that is repo-doctor's job to report, not this script's to
// silently replace). The dest-exists check runs FIRST, so "already present" wins
// even in the impossible case where the primary's own node_modules has vanished.
import fs from "node:fs";
import path from "node:path";

/**
 * Link `<worktreeRoot>/node_modules` to `<primaryRoot>/node_modules` as a
 * Windows junction, unless the worktree already has one.
 *
 * Returns a short human-readable status string (for the caller to print):
 *   "already present"  — the worktree already has a node_modules; untouched.
 *   "would-link"       — dryRun only; nothing was created.
 *   "junctioned"       — a new junction was created and now exists.
 *   "the primary has no node_modules — run pnpm install THERE first"
 *   "could not link: <error>"
 *
 * @param {string} worktreeRoot absolute path to the worktree whose node_modules to create
 * @param {string} primaryRoot  absolute path to the primary clone (the junction target)
 * @param {{ dryRun?: boolean }} [options]
 */
export function linkNodeModules(worktreeRoot, primaryRoot, { dryRun = false } = {}) {
  const dest = path.join(worktreeRoot, "node_modules");
  const src = path.join(primaryRoot, "node_modules");

  // Dest first: if the worktree already has node_modules we are done, regardless
  // of the primary's state. Never overwrite it.
  if (fs.existsSync(dest)) {
    return "already present";
  }
  if (!fs.existsSync(src)) {
    return "the primary has no node_modules — run pnpm install THERE first";
  }
  if (dryRun) {
    return "would-link";
  }
  try {
    // "junction" is Windows-only and ignored elsewhere (Node falls back to a
    // directory symlink), so this works on the Linux CI runner too.
    fs.symlinkSync(src, dest, "junction");
    return "junctioned";
  } catch (err) {
    return "could not link: " + err.message;
  }
}
