// Which folders the PRIMARY checkout's module resolution runs THROUGH.
//
// WHY THIS EXISTS. On 2026-10-09 `repo-doctor --fix` deleted `F:\Phoenix Workforce\_wt-reconcile-deductions`
// three separate times, in three separate sessions, and each deletion broke every Claude session on
// the machine: the first command run afterwards died with ERR_MODULE_NOT_FOUND on
// `@supabase/supabase-js`. The folder was a textbook husk by every test the report had — not
// registered as a worktree, no `.git` entry, ZERO files in a full recursive walk — and it was also
// the only thing holding the primary's dependencies together, because a stray `pnpm run` inside
// that worktree had rewritten all 68 of the primary's top-level `node_modules/<pkg>` links to
// absolute paths routed through `_wt-reconcile-deductions\node_modules\.pnpm\…`. A zero-file folder
// can be load-bearing: the junction that carries the chain is a LINK, and links are not files.
//
// WHY IT IS ITS OWN FILE. `repo-doctor.mjs` runs its whole report at import time, so nothing can
// import a function out of it to test.
//
// WHY IT READS LINK TARGETS AND NOT NAMES. The tempting fix is an exception list naming
// `_wt-reconcile-deductions`. That protects one folder and nothing else: the next worktree retired
// after a stray `pnpm run` is load-bearing under a different name, and the list would make the
// report look careful while the machine broke again. The property that matters is not what a folder
// is called but whether the primary's own package links resolve through it, and that is readable
// from the links themselves — `fs.readlinkSync` answers for a Windows junction exactly as it does
// for a POSIX symlink.
//
// WHY ANCESTORS COUNT. A link's target is deep inside the folder
// (`<folder>\node_modules\.pnpm\@supabase+supabase-js@2.x\node_modules\@supabase\supabase-js`), and
// deleting ANY directory on that path breaks it. So every ancestor of every target is marked, which
// is also what makes the primary itself appear in the set — harmless, since the primary is never a
// deletion candidate.
//
// WHY IT NEVER THROWS. This runs on every invocation of the report, including on a laptop with no
// network and a half-installed tree. A read that fails must leave the folder UNCLASSIFIED (not
// load-bearing) rather than take the report down — and the caller's rule is that only a folder
// proven load-bearing is diverted, so the failure mode of this file is the report's previous
// behaviour, never a worse one.

import fs from "node:fs";
import path from "node:path";

/** Windows paths differ in slash and case between git and node — compare canonically. */
export const canonPath = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");

/**
 * Every directory that one of `primaryRoot`'s own top-level package links resolves through,
 * canonicalised, including every ancestor of each target.
 *
 * Scoped packages sit one level deeper (`node_modules/@scope/pkg`), so a real `@scope` directory is
 * opened rather than read as a package. One directory listing plus one `lstat`/`readlink` per entry:
 * ~1,400 syscalls on this repo, measured well under the walk the report already does.
 *
 * @param {string} primaryRoot absolute path to the primary checkout
 * @returns {Set<string>} canonical paths; empty when nothing could be read
 */
export function directoriesLinkedThrough(primaryRoot) {
  const roots = new Set();
  const modulesDir = path.join(primaryRoot, "node_modules");
  let entries;
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return roots;
  }

  const consider = (linkPath) => {
    let target;
    try {
      if (!fs.lstatSync(linkPath).isSymbolicLink()) return;
      target = fs.readlinkSync(linkPath);
    } catch {
      return;
    }
    if (!target) return;
    // A junction's target is absolute; a POSIX symlink's is usually relative to its own directory.
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
    let current = path.resolve(resolved);
    for (;;) {
      roots.add(canonPath(current));
      const parent = path.dirname(current);
      if (parent === current) break; // drive or filesystem root
      current = parent;
    }
  };

  for (const entry of entries) {
    const full = path.join(modulesDir, entry.name);
    // `.bin`, `.pnpm` and friends are the primary's own; a link inside them still counts, but they
    // are directories, not scopes, so only `@scope` is descended into.
    if (entry.name.startsWith("@") && entry.isDirectory() && !entry.isSymbolicLink()) {
      let scoped;
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) consider(path.join(full, inner.name));
      continue;
    }
    consider(full);
  }
  return roots;
}

/**
 * Is deleting `dir` going to dangle one of the primary's package links?
 *
 * The primary itself is in `linkedThrough` (every target's ancestors are), which is why the caller
 * only ever asks this of a deletion CANDIDATE — never of the primary.
 *
 * @param {string} dir candidate folder
 * @param {Set<string>} linkedThrough from {@link directoriesLinkedThrough}
 */
export function isLoadBearing(dir, linkedThrough) {
  return linkedThrough.has(canonPath(dir));
}

/**
 * What a load-bearing folder is holding up, for the report line: how many of the primary's
 * top-level package links travel through it, and one example target.
 *
 * Counted from the links again rather than carried through the set, because the set has lost which
 * folder each target belonged to by design (it holds ancestors). Cheap: this runs only for the
 * folders already proven load-bearing, normally none.
 *
 * @param {string} primaryRoot absolute path to the primary checkout
 * @param {string} dir the load-bearing folder
 * @returns {{count: number, example: string | null}}
 */
export function linksThroughFolder(primaryRoot, dir) {
  const needle = canonPath(dir) + "/";
  const modulesDir = path.join(primaryRoot, "node_modules");
  let count = 0;
  let example = null;
  let entries;
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return { count, example };
  }
  const consider = (linkPath, name) => {
    let target;
    try {
      if (!fs.lstatSync(linkPath).isSymbolicLink()) return;
      target = fs.readlinkSync(linkPath);
    } catch {
      return;
    }
    if (!target) return;
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
    if (!canonPath(resolved).startsWith(needle)) return;
    count++;
    if (example === null) example = name;
  };
  for (const entry of entries) {
    const full = path.join(modulesDir, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory() && !entry.isSymbolicLink()) {
      let scoped;
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) consider(path.join(full, inner.name), `${entry.name}/${inner.name}`);
      continue;
    }
    consider(full, entry.name);
  }
  return { count, example };
}
