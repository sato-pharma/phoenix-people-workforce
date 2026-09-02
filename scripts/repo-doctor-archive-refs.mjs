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

// THE RULE IS NOW INVERTED (2026-09-02), because the allowlist was wrong a THIRD time. Scanning
// only `refs/deleted-branches`, `refs/heads/rescue` and `refs/backups` left 84 refs unexamined
// across FIVE more namespaces — `refs/tags/archive` (52), `refs/remotes/backups` (15),
// `refs/archive/v1` (9), `refs/rescue`, `refs/safety`, and `refs/tags/{rescue,backup,abandoned}`.
// Six of those commits existed on this laptop only, and two were accounted for by no merged PR:
// `tags/archive/wt-pr1843` (its PR closed unmerged) and `tags/archive/wt-pr1864-ci`.
//
// A list of places to LOOK goes stale every time someone invents a convention, and it goes stale
// SILENTLY, in the direction that reads as clean — three times now, each caught by hand. A list of
// places to SKIP goes stale in the direction that reads as noisy. So the default is inverted:
// every ref is an archive unless named below as something git or a tool owns. A namespace nobody
// has classified gets AUDITED. Being wrong now costs a push, which is this file's design goal.
//
// Do NOT answer a noisy report by adding a namespace to the skip list without reading what is in
// it. That is the old bug wearing the new rule's clothes.

import { execFileSync } from "node:child_process";

/**
 * Ref prefixes that are NOT archives. Everything else under `refs/` is.
 *
 * This is a SKIP list rather than a LOOK list on purpose — see the header. A missing entry here
 * produces a false ALARM; a missing entry in the old look-list produced a false CLEAN, three times
 * over. Every entry names something git or a tool owns, never something a person chose to keep.
 *
 * An entry ending in `/` matches a namespace; one that does not must match the ref EXACTLY, so
 * `refs/stash` cannot silently swallow a future `refs/stashed-experiments/`.
 */
export const NON_ARCHIVE_REF_PREFIXES = Object.freeze([
  "refs/heads/", // live branches — the UNPUSHED COMMITS section already measures these
  "refs/remotes/", // a cache of a ref that lives somewhere else; never a local original
  "refs/stash", // transient by design, and pushable nowhere
  "refs/notes/", // metadata about commits, not work
  "refs/bisect/", // git's own transient refs, below here
  "refs/rewritten/",
  "refs/worktree/",
  "refs/prefetch/",
  "refs/replace/",
  "refs/copilot/", // per-turn tool scratch, regenerated constantly
  "refs/codex/",
  "refs/sessions/",
]);

/**
 * Branch namespaces that ARE archives despite living under `refs/heads/`.
 *
 * `rescue/<name>` is this repo's convention for a tip pulled out of a worktree before retiring it
 * — a keepsake wearing a branch's clothes, which is why it outranks the `refs/heads/` skip above.
 */
export const ARCHIVE_BRANCH_PREFIXES = Object.freeze(["refs/heads/rescue/"]);

/**
 * Whether a ref is an archive: something a person kept, whose loss would be a loss.
 *
 * @param {string} ref full local ref name
 * @returns {boolean}
 */
export function isArchiveRef(ref) {
  if (ARCHIVE_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix))) return true;
  return !NON_ARCHIVE_REF_PREFIXES.some((entry) =>
    entry.endsWith("/") ? ref.startsWith(entry) : ref === entry,
  );
}

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
  // Only the two namespaces whose name is pure bookkeeping are stripped. A namespace that says
  // something — `tags/archive/wt-pr1843`, `rescue/<task>`, `safety/pre-session-close` — KEEPS it,
  // because a backup ref is read months later by someone asking what this commit was.
  const leaf = ref
    .replace(/^refs\//, "")
    .replace(/^deleted-branches\//, "")
    .replace(/^heads\//, "");
  return `refs/backups/${leaf}`;
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
    out = execFileSync("git", ["for-each-ref", "--format=%(objectname) %(*objectname) %(refname)"], {
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
      // Three space-separated fields, and a ref name cannot contain a space. `*objectname` is
      // empty for everything but an ANNOTATED tag, whose own object is NOT a commit — hand that
      // object to `--contains` and git rejects it, so the tag reads as stranded however safe.
      const [objectName, dereferenced, ref] = line.split(" ");
      return { sha: dereferenced || objectName, ref };
    })
    .filter((entry) => isArchiveRef(entry.ref));
}
