---
name: primary-checkout-branch-can-change-mid-merge-use-worktree-and-rerere
description: "Another session created+switched to a new branch in the shared primary checkout WHILE a `git merge` with unresolved conflicts was in progress, silently discarding the uncommitted resolution. Recovered by redoing the merge in an isolated worktree, where git rerere auto-reapplied ~85% of the original resolution from its cache - but rerere CUTS BOTH WAYS: on 2026-10-09 it replayed a two-block resolution of tests/run-tests.ts onto a THIRD block and silently merged two runTest() calls into one, which a line-presence check could not see and only the typecheck and the wiring assertion caught."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-10-09T15:25:00.000Z
---

**What happened (2026-08-09).** Resolving a 41-conflict-hunk merge (`origin/main` into
`codex/email-recipient-assurance-guard`, PR #1927) directly in the primary checkout. Conflicts
across 14 files were carefully resolved (not just marker-stripped — one hunk hid a silent
duplicate `export type` that would have been a TypeScript compile error with no conflict marker
to flag it). Mid-resolution, a `git status` check showed **the branch had changed to
`codex/wip-recovery-followup`** — a different session had run `git checkout -b` in this exact
directory while `MERGE_HEAD` was still set. The new branch happened to share the same base commit,
so the checkout succeeded without error and the uncommitted resolution briefly survived — but
minutes later that other session committed and pushed its OWN merge on that branch, and the
working tree went clean. **The entire uncommitted resolution was gone, never committed, on either
branch.** `codex/email-recipient-assurance-guard` (the actual PR #1927 branch) was untouched and
still conflicting the whole time — the other session's activity was completely unrelated to the
task, just sharing the same directory.

**Why this is a new variant, not a repeat of known hazards.** Existing memory
([[cannot-map-claude-sessions-to-worktrees]], the SessionStart lock warning) covers concurrent
*edits* and *checkouts of tracked files*. This was a `git checkout -b <new-branch>` while a merge
was IN PROGRESS (`MERGE_HEAD` set, real conflict markers in the working tree) — a state most
people assume git would refuse to leave. It doesn't refuse when the target branch shares HEAD's
exact commit, because there is no working-tree content to lose from git's point of view. The loss
here wasn't from git overwriting anything; it was from **a second, unrelated commit later landing
on the branch the working tree had drifted onto**, at which point the working tree resets to
clean and the never-committed resolution has nowhere to go.

**How to apply:**
1. **A merge conflict resolution is not safe left uncommitted in a shared primary checkout for any
   length of time**, even though `git status`/`git branch --show-current` looked fine moments
   before. If the resolution will take more than a couple of minutes, do it in an isolated worktree
   from the start: `git worktree add ../_wt-<task> <branch>` — this was always the documented
   remedy for concurrent-session risk, but it applies to in-progress merges just as much as to
   ordinary edits.
2. **`git rerere` (if enabled, check `git config rerere.enabled`) makes redoing a lost resolution
   fast, not from scratch.** Re-running the identical `git merge` in a fresh worktree auto-reapplied
   11 of 14 files' exact prior resolutions with "Resolved '<file>' using previous resolution." Only
   3 files needed fresh attention, and that was because `origin/main` had genuinely moved further in
   the interim (more PRs merged elsewhere), not because rerere failed — it correctly recognized the
   hunks had changed shape. This turned a second full 41-hunk pass into ~10 minutes of work.
   🔴 **It cuts both ways, and the failure is SILENT (2026-10-09, PR #5683).** rerere replayed an
   earlier two-block resolution of `tests/run-tests.ts` onto a merge where #5675 had added a THIRD
   registration block, and produced one `await runTest(` call carrying FOUR arguments - two titles
   and two test functions - with the first call's `);` gone. Both required checks went red
   (`error TS2554: Expected 2 arguments, but got 4` and `FAIL test wiring is complete`), because the
   second function was now an ARGUMENT rather than an invocation. **After any rerere-assisted merge,
   verify the call STRUCTURE, not merely that both sides' content survived.**
3. **Never trust "no remaining conflict markers" as proof a resolution is correct on its own,
   whether yours or found already-done.** The duplicate-`export type` bug (two declarations of
   `DirectOrderPossibleDistributorMatch`, one stale) had zero conflict markers and would only have
   surfaced as a TypeScript error — caught here only because typecheck ran before commit. Run an
   explicit scan for duplicate top-level exports across every touched file as part of any multi-file
   conflict resolution: `grep -oE "^export (type|function|const|interface) [A-Za-z0-9_]+" <file> |
   sort | uniq -d`.
   🔴 **A line-presence check is blind to this whole class.** Comparing bullet and registration
   LINES against `main` found nothing missing while the call itself was broken - both titles and
   both function names were present, just inside one call. The check that sees it:
   `grep -c "await runTest(" tests/run-tests.ts` against `main` (expect exactly +1 per added test),
   plus a scan for any `run*Tests,` line followed directly by a quoted line (expect 0). Measured at
   the fixed head 7180d1aa2: 2345 against main's 2344, imports 2273 against 2272, collapsed pairs 0.
4. When a merge conflict spans many files, most individual hunks tend to be genuinely additive (one
   side changed nothing in that span) rather than truly contradictory — but always verify by reading
   surrounding context (does the unconflicted code below already reference the field one side is
   adding?), never assume "HEAD is empty" means "safe to blindly take the other side" without that
   check.

Related: [[git-worktree-remove-can-timeout-and-partially-delete]] (a different way this exact
kind of multi-session checkout causes real damage), [[merged-pr-does-not-make-a-worktree-retirable]].
