// git-layout.mjs — where a folder sits in this repository's layout, read straight off disk.
//
// WHY THIS EXISTS (2026-10-09, hook speed fixes). Hooks that only needed to know "primary checkout
// or linked worktree, and where is the primary" asked git: `git rev-parse --git-dir
// --git-common-dir --show-toplevel`. primary-write-guard did it on EVERY Write/Edit/NotebookEdit
// (about 75 ms of its own, more inside a busy session), memory-index-guard and sync-worktree-env on
// every session start. On this laptop a process start is the expensive part of a hook, so the
// answer is now read from the same files git itself reads:
//
//   <top>/.git is a FOLDER        → the primary checkout: git dir = common dir = <top>/.git
//   <top>/.git is a FILE          → a linked worktree: "gitdir: <path>" names its git dir, and that
//                                   folder's `commondir` file names the shared one (usually ../..)
//
// It walks up from the starting folder exactly as git does, so a subfolder answers like its root.
// It returns null — and the caller falls back to git — whenever the layout cannot be read, or when
// GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR are set, because git would honour those and a disk read
// would not. Paths come back with forward slashes, the shape `--path-format=absolute` prints.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const slash = (p) => p.replace(/\\/g, '/');

/**
 * @param {string} start  any folder inside a checkout (a file's folder is fine)
 * @returns {{ toplevel: string, gitDir: string, commonDir: string, linked: boolean } | null}
 */
export function gitLayout(start) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return null;
  let dir;
  try {
    dir = path.resolve(start);
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = statSync(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) {
      return { toplevel: slash(dir), gitDir: slash(dotGit), commonDir: slash(dotGit), linked: false };
    }
    if (st?.isFile()) {
      let text;
      try {
        text = readFileSync(dotGit, 'utf8');
      } catch {
        return null;
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return null;
      const gitDir = path.resolve(dir, m[1]);
      let commonDir = gitDir;
      try {
        const pointer = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (pointer) commonDir = path.resolve(gitDir, pointer);
      } catch {
        // no commondir file: a submodule or a plain gitfile — its git dir is its own common dir
      }
      try {
        if (!statSync(commonDir).isDirectory()) return null;
      } catch {
        return null; // a dangling pointer (worktree pruned underneath us): let git decide
      }
      const same = slash(path.resolve(gitDir)).toLowerCase() === slash(path.resolve(commonDir)).toLowerCase();
      return { toplevel: slash(dir), gitDir: slash(gitDir), commonDir: slash(commonDir), linked: !same };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The primary checkout's root for any folder of the repo, or null when the layout is unreadable. */
export function primaryRootOf(start) {
  const l = gitLayout(start);
  return l ? slash(path.dirname(l.commonDir)) : null;
}
