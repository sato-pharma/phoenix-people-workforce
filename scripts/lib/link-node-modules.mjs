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
// IDEMPOTENT AND NON-DESTRUCTIVE. It never touches an existing REAL node_modules
// — a directory a session actually installed into is left exactly alone (that
// is repo-doctor's job to report, not this script's to silently replace). The
// one thing it will remove is a junction/symlink whose TARGET is gone — a
// "dangling" link — because that is exactly what a `pnpm install` purge run
// through the junction leaves behind (AGENTS.md §5: `pnpm` inside a worktree
// sees the moved lockfile and purges the PRIMARY's node_modules THROUGH the
// junction, so every other worktree's link now points at nothing).
//
// That case does not exist-check as "missing": `fs.existsSync(dest)` FOLLOWS a
// symlink/junction and reports false when the target is gone, so it reads
// identically to "nothing here at all" — and `fs.symlinkSync` over that same
// path then fails EEXIST, because the link ENTRY is still there even though
// its target is not. Verified empirically on this repo's Windows/Node build:
//   fs.existsSync(dest)   -> false   (reads as "missing")
//   fs.lstatSync(dest)    -> succeeds (something IS there — the dead link itself)
//   fs.symlinkSync(...)   -> throws EEXIST ("could not link: ...")
// `fs.lstatSync` never follows a link, so it is the only way to tell "a link
// entry sits here" apart from "nothing sits here" — and from that, whether the
// entry is a symlink/junction at all separates "a real directory is already
// here, never touch it" from "a link is here, and might be dangling".
//
// Removing a dangling link is done with `fs.unlinkSync` (falling back to
// `fs.rmdirSync` for the Windows builds that reject unlink on a directory-type
// reparse point) — NEVER `fs.rmSync(dest, { recursive: true })`. Both of the
// first two act on the reparse point / link entry itself and do not descend
// into whatever it used to point at, which is the Node equivalent of cmd's
// non-recursive `rmdir` that AGENTS.md requires for dropping a junction. A
// recursive remove would instead FOLLOW the link into the primary's real
// node_modules and delete it — the exact incident (breaking every worktree on
// the machine) this file exists to prevent. Verified empirically: creating a
// junction, then removing it with `fs.unlinkSync`, leaves the target directory
// and its contents completely intact.
import fs from "node:fs";
import path from "node:path";

/**
 * Link `<worktreeRoot>/node_modules` to `<primaryRoot>/node_modules` as a
 * Windows junction. Heals two states: nothing at `dest` at all, and a
 * junction/symlink at `dest` whose target no longer exists (a "dangling"
 * link). Never touches a real directory already at `dest`, and never touches
 * a link at `dest` that still resolves to something.
 *
 * Returns a short human-readable status string (for the caller to print):
 *   "already present"                   — a real node_modules (or a link that
 *                                          still resolves) is already there;
 *                                          untouched.
 *   "would-link"                        — dryRun only; dest was empty; nothing created.
 *   "would-relink (stale junction)"     — dryRun only; dest was a dangling
 *                                          link; nothing removed or created.
 *   "junctioned"                        — dest was empty; a new junction now exists.
 *   "relinked (stale junction removed)" — dest was a dangling link; it was
 *                                          removed (link entry only, target
 *                                          untouched — there was none) and a
 *                                          fresh junction now exists.
 *   "the primary has no node_modules — run pnpm install THERE first"
 *   "stale junction — remove it by hand: <error>"  — the dangling link could
 *                                                     not be removed.
 *   "could not link: <error>"           — the junction itself could not be created.
 *
 * @param {string} worktreeRoot absolute path to the worktree whose node_modules to create
 * @param {string} primaryRoot  absolute path to the primary clone (the junction target)
 * @param {{ dryRun?: boolean }} [options]
 */
export function linkNodeModules(worktreeRoot, primaryRoot, { dryRun = false } = {}) {
  const dest = path.join(worktreeRoot, "node_modules");
  const src = path.join(primaryRoot, "node_modules");

  // lstat, not existsSync: existsSync FOLLOWS a link and reports false for a
  // dangling one, which is indistinguishable from "nothing here" — exactly the
  // gap that let a dangling junction go unhealed. lstat sees the link entry
  // itself regardless of whether its target exists.
  let destLstat = null;
  try {
    destLstat = fs.lstatSync(dest);
  } catch {
    destLstat = null; // truly nothing at dest
  }

  if (destLstat) {
    if (!destLstat.isSymbolicLink()) {
      // A real directory (or file) is already there. Never touch it, no
      // matter what state the primary is in.
      return "already present";
    }
    // A junction/symlink is there. existsSync follows it, so it tells us
    // whether the target it points to still exists.
    if (fs.existsSync(dest)) {
      return "already present"; // still resolves — leave it exactly alone
    }
    // Dangling: the link entry is there but resolves to nothing.
    if (dryRun) {
      return "would-relink (stale junction)";
    }
    try {
      try {
        fs.unlinkSync(dest);
      } catch (err) {
        // Some Windows/Node combinations reject unlink on a directory-type
        // reparse point (EPERM/EISDIR); rmdir is the non-recursive fallback —
        // it too removes only the link entry, never the (already-gone) target.
        if (err && (err.code === "EPERM" || err.code === "EISDIR")) {
          fs.rmdirSync(dest);
        } else {
          throw err;
        }
      }
    } catch (err) {
      return "stale junction — remove it by hand: " + err.message;
    }
    if (!fs.existsSync(src)) {
      return "the primary has no node_modules — run pnpm install THERE first";
    }
    try {
      fs.symlinkSync(src, dest, "junction");
      return "relinked (stale junction removed)";
    } catch (err) {
      return "could not link: " + err.message;
    }
  }

  // Nothing at dest at all — the original "missing junction" case.
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
