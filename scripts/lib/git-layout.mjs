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

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A ref's commit id from its loose file, else packed-refs, as git looks it up; null if neither has it. */
function refCommit(commonDir, name) {
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const loose = read(path.join(commonDir, name));
  if (loose !== null) return COMMIT_ID.test(loose) ? loose : null; // a symbolic loose ref: let git answer
  const packed = read(path.join(commonDir, 'packed-refs'));
  if (packed === null) return null;
  for (const line of packed.split(/\r?\n/)) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space > 0 && line.slice(space + 1) === name) return COMMIT_ID.test(line.slice(0, space)) ? line.slice(0, space) : null;
  }
  return null;
}

/**
 * The commit ids of HEAD and `origin/main` for a checkout, read off disk (2026-10-09, memory-check
 * speed). memory-index-guard asked git for them at every session start, three processes that cost
 * ~110 ms alone and most of a second inside a real start, when about ten hooks launch at once.
 *
 * HEAD lives in the checkout's own git dir; branches and remotes in the common dir, loose file first,
 * then packed-refs. Null — and the caller asks git — for anything this does not read the way git
 * would: an unreadable layout, a symbolic or missing ref, the reftable format (its HEAD names
 * `refs/heads/.invalid`, which is never found here), or a shallow clone, whose cut-off history makes
 * a count of commits between two ids depend on the clone rather than on the ids.
 *
 * @param {string} start  any folder inside a checkout
 * @returns {{ head: string, main: string } | null}
 */
export function headAndOriginMain(start) {
  const l = gitLayout(start);
  if (!l) return null;
  try {
    statSync(path.join(l.commonDir, 'shallow'));
    return null;
  } catch {
    // not shallow
  }
  let head;
  try {
    head = readFileSync(path.join(l.gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const symbolic = /^ref:\s*(refs\/\S+)$/.exec(head);
  const headId = symbolic ? refCommit(l.commonDir, symbolic[1]) : COMMIT_ID.test(head) ? head : null;
  const mainId = refCommit(l.commonDir, 'refs/remotes/origin/main');
  return headId && mainId ? { head: headId, main: mainId } : null;
}
