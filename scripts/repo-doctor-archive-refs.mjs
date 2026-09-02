// Which local archive refs exist, so the doctor can ask origin whether each tip survives off-laptop.
//
// WHY THIS IS ITS OWN FILE. `repo-doctor.mjs` runs its whole report at import time, so nothing can
// import a function out of it to test — the same reason `repo-doctor-unpushed.mjs` exists. The
// property that matters here is a runtime one: what real `git for-each-ref` does with a real ref
// name, not what a regex does with a string.
//
// THE BUG THIS FIXES. The patterns were `refs/deleted-branches/*` and `refs/heads/rescue/*`, with a
// single star. `git for-each-ref` globs do NOT cross a slash, so those matched only ref names with
// no `/` in them — while this repository names almost every branch `codex/<task>` or
// `claude/<task>`. Measured 2026-09-01: 137 of 306 archives matched, and the section printed
//
//     137 local archive ref(s), 0 with no copy on origin
//     -> none. Every archived tip also exists on origin.
//
// Of the 169 it could not see, 23 existed nowhere but this laptop — including `codex/agents-md-trim`
// and four `claude/*` tips. AGENTS.md section 2.1 states that `refs/backups/*` on ORIGIN is the only
// copy that survives losing this machine, and this section is the only thing that measures it.
//
// THE DANGEROUS DIRECTION IS ONE-WAY, as everywhere else in the doctor. A missed archive reads as
// "safely backed up" — a clean bill of health over refs the check never examined, which is strictly
// worse than having no check, because it stops anyone looking. A false alarm only costs a push.
//
// So the patterns are recursive and they live here, exported, where a test can drive them against a
// throwaway repo holding both a flat and a nested archive ref.
//
// THE CHECK HAS TWO HALVES, and each has been wrong once. WHICH REFS are archives (the globs below)
// and WHAT COUNTS AS BEING ON ORIGIN (strandedArchives). Both failed the same way — quietly, in the
// direction that reads as safe.
//
// THE SAME BUG, A SECOND TIME (2026-09-02). The patterns still omitted `refs/backups/**` — the one
// namespace this file's own header names as the convention that matters. This checkout held 21 local
// `refs/backups/*` refs that the section never examined, and it printed "none. Every archived tip
// also exists on origin." A hand audit of those 21 found one whose SHA was on no origin ref. So the
// lesson generalises: the set of namespaces is itself the thing that goes stale. Add the namespace
// here, never a second scan somewhere else.

import { execFileSync } from "node:child_process";

/**
 * Ref globs covering every local archive namespace.
 *
 * `**` is load-bearing: `*` stops at a slash, and `codex/<task>` is this repo's dominant branch
 * name. Do not "simplify" these back to a single star — see the header for what that cost.
 */
export const ARCHIVE_REF_PATTERNS = Object.freeze([
  "refs/deleted-branches/**",
  "refs/heads/rescue/**",
  "refs/backups/**",
]);

/**
 * Where a given archive ref should be pushed so the tip survives off this laptop.
 *
 * A ref already under `refs/backups/` is pushed to ITSELF. Without this the printed command read
 * `refs/backups/refs/backups/<name>` — a recovery line that creates a ref nobody will ever look
 * for, offered at exactly the moment someone is trying to rescue work.
 *
 * @param {string} ref full local ref name
 * @returns {string} the ref to push to on origin
 */
export function archivePushTarget(ref) {
  if (ref.startsWith("refs/backups/")) return ref;
  return `refs/backups/${ref.replace("refs/deleted-branches/", "").replace("refs/heads/", "")}`;
}

/**
 * The archive refs whose COMMIT exists on this disk only.
 *
 * WHY THIS IS NOT `!advertised.has(sha)`. That was the original test, and it asks the wrong
 * question: "is this SHA the TIP of some ref on origin right now?" An archived tip is normally an
 * ORDINARY ANCESTOR of `main` — merged, pushed, entirely safe — and tips it is not. Measured on
 * this checkout 2026-09-02: 5 refs reported as laptop-only, and 4 were direct ancestors of
 * `origin/main`. The count also MOVES on its own as merged branches are deleted from origin,
 * which is how a section people are meant to act on trains them to ignore it.
 *
 * WHY ANCESTRY ALONE IS NOT ENOUGH EITHER, and this is the part that must not be simplified away.
 * A remote-tracking ref is a CACHE. `refs/remotes/origin/x` says what origin advertised at the
 * last fetch, not what it holds now. Trusting one blindly means a rewound or deleted branch reads
 * as proof — a FALSE CLEAN, the one direction this whole file exists to prevent. So an anchor is
 * only usable when origin advertises that exact SHA in the ls-remote the caller just took. Then
 * the reasoning is airtight: origin has the anchor, the anchor has this commit in its history, so
 * origin has this commit.
 *
 * Failure of any git call falls through to STRANDED. A false alarm costs a push; a false clean
 * costs the commit.
 *
 * @param {{ sha: string, ref: string }[]} archiveRefs from listArchiveRefs
 * @param {Set<string>} advertised every SHA origin advertises right now (from `git ls-remote`)
 * @param {string} [dir] working directory to run git in
 * @returns {{ sha: string, ref: string }[]} the subset that exists nowhere but this disk
 */
export function strandedArchives(archiveRefs, advertised, dir = process.cwd()) {
  return archiveRefs.filter((entry) => {
    if (advertised.has(entry.sha)) return false;
    return !reachableFromVerifiedOrigin(entry.sha, advertised, dir);
  });
}

/**
 * Whether `sha` is contained by a remote-tracking ref that origin STILL advertises at that SHA.
 *
 * One `for-each-ref --contains` per candidate rather than a merge-base per (candidate, anchor):
 * git walks the graph once and names every containing ref, and the intersection with `advertised`
 * is what turns a cached ref into a verified one.
 */
function reachableFromVerifiedOrigin(sha, advertised, dir) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(objectname)", "--contains", sha, "refs/remotes/origin/"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return false;
  }

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((tip) => advertised.has(tip));
}

/**
 * Every local archive ref as `{ sha, ref }`, or `null` when git itself failed.
 *
 * `null` and `[]` mean different things and the caller must keep them apart: `[]` is "there are no
 * archives", `null` is "this could not be determined". Collapsing them is how an unreadable repo
 * renders as a clean backup report.
 *
 * @param {string} [dir] working directory to run git in; defaults to the current one.
 * @returns {{ sha: string, ref: string }[] | null}
 */
export function listArchiveRefs(dir = process.cwd()) {
  let out;
  try {
    out = execFileSync("git", ["for-each-ref", "--format=%(objectname) %(refname)", ...ARCHIVE_REF_PATTERNS], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const gap = line.indexOf(" ");
      return { sha: line.slice(0, gap), ref: line.slice(gap + 1) };
    });
}
