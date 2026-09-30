// Give EVERY worktree the two gitignored things `git worktree add` never copies —
// node_modules (as a junction to the primary's) and the local .env files — so that
// node / pnpm / npm commands run in all working trees, not only in the one worktree
// a Claude session happens to have open.
//
// WHY THIS EXISTS
// ---------------
// sync-worktree-env.mjs already provisions a worktree at SessionStart, but only the
// ONE the session is in (it resolves the CURRENT worktree and stops). Worktrees
// created any other way are never touched: the app's native `.claude/worktrees/<name>`
// ones before a session opens in them, dependabot / cloud `agent-*` folders, a bare
// `git worktree add`, a detached checkout. In every one, `node scripts/…`, `tsc`,
// `eslint` and `next dev` fail with MODULE_NOT_FOUND, which reads as a path or
// permissions fault rather than a missing junction — a confused detour every time,
// and the reason sessions pile back into the primary and collide there. Measured
// 2026-09-30: 9 of 17 worktrees on this machine were NOT RUNNABLE for exactly this.
//
// `sweepWorktrees` provisions ALL of them, so a single session start heals the whole
// machine (owner rule, 2026-09-30: "nodes and pnpm/npm auto installed in all working
// trees").
//
// SAFE TO RUN ACROSS ANOTHER SESSION'S WORKTREE
// ---------------------------------------------
// It writes only gitignored, non-tracked files — the node_modules junction and the
// .env* files — never edits a tracked file, never runs a git command against the
// target folder, and never overwrites an env file that is already there (a worktree's
// env may legitimately differ; that is why the copy is skip-if-exists unless force).
// `linkNodeModules` is idempotent and never touches a REAL node_modules a session
// installed into. It deliberately does NOT touch `.claude/settings.local.json` in the
// swept worktrees: that primary-wins permission refresh stays the job of the sync run
// for the worktree a session is actually IN, so this sweep never rewrites a permission
// file underneath a running session. This is the one reason the sweep is a lighter
// touch than `new-session.mjs --repair`, which spawns a full per-worktree sync and so
// deliberately leaves `.claude/worktrees/` alone.
import fs from "node:fs";
import path from "node:path";

import { linkNodeModules } from "./link-node-modules.mjs";

/**
 * Provision ONE worktree directory: copy any MISSING env file from the primary, and
 * junction its node_modules to the primary's. Never overwrites an env file that is
 * already there unless `force`; never touches a real node_modules.
 *
 * @param {string} dir          absolute path to the worktree to provision
 * @param {string} primaryRoot  absolute path to the primary clone (the copy/junction source)
 * @param {string[]} candidates env filenames found gitignored in the primary root
 * @param {{ force?: boolean, dryRun?: boolean }} [options]
 * @returns {{ dir: string, present: boolean, copied: string[], skipped: string[], modulesStatus: string }}
 *   `present` is false when the registered worktree's folder is gone (a husk) — nothing done.
 *   In dryRun, `copied` lists what WOULD be copied and modulesStatus is the would-* form.
 */
export function provisionDir(dir, primaryRoot, candidates, { force = false, dryRun = false } = {}) {
  const result = { dir, present: true, copied: [], skipped: [], modulesStatus: "skipped" };

  // A registered worktree whose folder is gone (a husk), or a path that is not a
  // directory — nothing to provision. Copying into it would throw.
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    result.present = false;
    return result;
  }

  for (const name of candidates) {
    const src = path.join(primaryRoot, name);
    const dest = path.join(dir, name);
    if (!fs.existsSync(src)) continue; // the primary no longer has it
    const exists = fs.existsSync(dest);
    if (exists && !force) {
      result.skipped.push(name);
      continue;
    }
    if (dryRun) {
      result.copied.push(name); // intent only — nothing written
      continue;
    }
    fs.copyFileSync(src, dest);
    result.copied.push(name);
  }

  result.modulesStatus = linkNodeModules(dir, primaryRoot, { dryRun });
  return result;
}

/**
 * Provision every worktree in `worktreeDirs` except the primary and any path in
 * `skip` (typically the CURRENT worktree, which the caller has already fully synced,
 * settings and all). Returns one result per dir considered, so a caller can print a
 * summary and stay silent for worktrees that needed nothing.
 *
 * @param {string} primaryRoot   absolute path to the primary clone
 * @param {string[]} worktreeDirs absolute worktree paths (e.g. from `git worktree list`)
 * @param {string[]} candidates  env filenames found gitignored in the primary root
 * @param {{ force?: boolean, dryRun?: boolean, skip?: string[] }} [options]
 * @returns {ReturnType<typeof provisionDir>[]}
 */
export function sweepWorktrees(
  primaryRoot,
  worktreeDirs,
  candidates,
  { force = false, dryRun = false, skip = [] } = {},
) {
  const skipSet = new Set([primaryRoot, ...skip].map((d) => path.resolve(d)));
  const results = [];
  for (const dir of worktreeDirs) {
    if (skipSet.has(path.resolve(dir))) continue;
    results.push(provisionDir(dir, primaryRoot, candidates, { force, dryRun }));
  }
  return results;
}

// A junction was (or would be) created — matches both the applied forms
// ("junctioned", "relinked (stale junction removed)") and the dry-run forms
// ("would-link", "would-relink (stale junction)"), so a dry-run previews junction
// work accurately and does not under-report a worktree that needs only the junction.
export function linkedNodeModules(modulesStatus) {
  return /junctioned|relinked|would-link|would-relink/.test(modulesStatus);
}

/** A result counts as "changed" (worth a summary line) when it copied an env file
 *  or created/relinked a junction; an already-provisioned worktree stays quiet. */
export function wasChanged(result) {
  return result.present && (result.copied.length > 0 || linkedNodeModules(result.modulesStatus));
}
