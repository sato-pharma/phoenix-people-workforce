/**
 * One read of the source tree, shared by every sweep in the suite.
 *
 * WHY THIS EXISTS — measured, not assumed (2026-09-24). Thirty-three test files walk `app/` and
 * `src/` themselves, each with its own copy of the same recursive `readdirSync` + `statSync` +
 * `readFileSync` walk, and each one pays the whole cost again:
 *
 *   walk with statSync        ~260ms   (4,033 files under app/ + src/)
 *   walk with withFileTypes   ~129ms   the same answer, one syscall per DIRECTORY instead of per ENTRY
 *   readFileSync all          ~510ms   46.8M characters — this is V8 decoding, so a warm OS cache
 *                                      does not make it cheaper: the second run measured 569ms
 *
 * So a single sweep spends ~770ms before it looks at a single character, and the suite pays that
 * ~33 times. The analysis each test then does is its own (comment stripping, its own patterns) and
 * is left exactly where it is — this module caches only the two things every sweep shares.
 *
 * WHAT IS SAFE TO CACHE. The tree does not change while the suite runs: these sweeps read committed
 * source, and the tests that write files write into temp directories and read them straight back
 * with `readFileSync`, never through here. If a test ever does need to re-read a file it has just
 * written, it must keep using `node:fs` directly — or call `clearSourceCorpusCache()` — rather than
 * reaching for these helpers, which will hand back what the file said the first time it was asked.
 *
 * WHY THE DIRENT WALK IS BUG-COMPATIBLE. The hand-written walks call `statSync(full).isDirectory()`,
 * which FOLLOWS a symlink, while a dirent's `isDirectory()` does not. Nothing under `app/` or `src/`
 * is a symlink today, but a wrong answer here would silently shrink a sweep's file list — and a
 * sweep that reads less than it should reports a clean tree. So a symlinked entry falls back to the
 * real `statSync`, and the two walks return identical lists.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type DirectoryListing = {
  /** Entry names, in `readdirSync` order — what a caller iterating a directory expects. */
  readonly names: readonly string[];
  /** The subset of those names that are directories, resolved with `statSync` semantics. */
  readonly directories: ReadonlySet<string>;
};

const listings = new Map<string, DirectoryListing>();
const contents = new Map<string, string>();

function listingFor(directory: string): DirectoryListing {
  const key = path.resolve(directory);
  const cached = listings.get(key);
  if (cached) return cached;

  const names: string[] = [];
  const directories = new Set<string>();
  for (const entry of readdirSync(key, { withFileTypes: true })) {
    names.push(entry.name);
    if (entry.isDirectory()) {
      directories.add(entry.name);
    } else if (entry.isSymbolicLink() && statSync(path.join(key, entry.name)).isDirectory()) {
      // `statSync` follows the link and the hand-written walks did too — see the header.
      directories.add(entry.name);
    }
  }

  const listing: DirectoryListing = { names, directories };
  listings.set(key, listing);
  return listing;
}

/** `readdirSync(directory)`, answered once per directory for the whole suite. */
export function cachedReaddir(directory: string): readonly string[] {
  return listingFor(directory).names;
}

/**
 * `statSync(entryPath).isDirectory()`, answered from the parent's single `withFileTypes` listing
 * rather than one `statSync` per entry — which is where half the walk time went.
 */
export function cachedIsDirectory(entryPath: string): boolean {
  const resolved = path.resolve(entryPath);
  const parent = path.dirname(resolved);
  // A path that is its own parent is a drive root: nothing walks up to one, but answering it
  // through `statSync` keeps this total rather than throwing on an edge nobody meant to hit.
  if (parent === resolved) return statSync(resolved).isDirectory();
  return listingFor(parent).directories.has(path.basename(resolved));
}

/**
 * `readFileSync(file, "utf8")` for a file that belongs to the source tree, decoded once.
 *
 * Only for files a sweep found by walking — never for something the test itself just wrote.
 */
export function cachedReadFile(file: string): string {
  const key = path.resolve(file);
  const cached = contents.get(key);
  if (cached !== undefined) return cached;
  const source = readFileSync(key, "utf8");
  contents.set(key, source);
  return source;
}

/** Drops everything remembered. For a test that deliberately mutates a file it then re-reads. */
export function clearSourceCorpusCache(): void {
  listings.clear();
  contents.clear();
}
