---
name: self-removing-a-worktree-mutes-its-own-session-end-guard
description: "A session that removes its own worktree before ending silently disables its own SessionEnd unpushed-commit guard — the hook is still registered and still runs, but bails to zero output because its path no longer resolves"
metadata: 
  node_type: memory
  type: project
  originSessionId: b65bce27-57ba-4248-849d-4afb97efa168
  modified: 2026-08-23T15:21:11.694Z
---

Proven live 2026-08-23 while retiring three worktrees.

`.claude/hooks/worktree-exit-guard.mjs` is the repo's **only** mechanism for noticing, at the moment
a session ends, that commits exist **only on this laptop**. It was written after a 2026-08-01 sweep
found **82 such commits across 12 branches** — no remote, no PR, no CI. It is report-only by design.

**The failure.** It is invoked as
`DIR="$(git rev-parse --show-toplevel || pwd)"; node .../worktree-exit-guard.mjs "$DIR"`.
When the worktree directory is already gone, `git rev-parse` resolves nothing, `pwd` is a deleted
path, and the guard **bails producing zero stdout and appending zero bytes to the log**. Verified by
direct invocation against a removed path: log stayed at exactly 10,815 bytes, stdout empty.

**What it looks like in the wild — silence, not an error:**

| Evidence | Value |
| --- | --- |
| `.claude/worktree-exit.log` entries dated 2026-08-23 | **0** |
| Worktree sessions that ended that day | **3** |
| Log last modified | 2026-08-22 02:37 — frozen a full day |
| Hook registration in `.claude/settings.json` | **still present**, `SessionEnd`, timeout 45 |
| `worktree-exit-guard.mjs` on disk | **still there**, unmodified since Aug 1 |

So every check for "is it disabled?" answers *no, it is fine* — the config is intact and the file
exists. Only the log's silence shows it.

**The bitter part: it is bypassed precisely on the tidy path.** A session that merges its PR and
cleans up after itself is doing exactly what AGENTS.md §5 asks — and that is the case where the
safety net never fires. A session that leaves a mess keeps its guard. Related but distinct:
[[cannot-remove-the-worktree-you-are-running-in]] is about the removal half-succeeding;
[[strip-worktree-payload-before-removing-it]] and [[worktree-payload-is-the-repo-slowness]] are the
why-remove-at-all. See also [[another-session-can-remove-a-worktree-under-you]] — another way the
guard never sees a worktree it was supposed to check.

**Why:** the guard's value is entirely in *when* it runs. Firing on session end is the one moment
"this branch is done for now" is actually known. A guard that is silent in the common case provides
false assurance — worse than no guard, because the log's existence reads as coverage.

**How to apply.** Never infer "nothing was unpushed" from an empty `worktree-exit.log`. Before
removing any worktree — yours or another session's — run the check yourself and show the number:

```
git -C <primary> log --branches --not --remotes --oneline | wc -l
```

Repo-wide, `0` is the only safe answer; it covers every local branch at once, so one command clears
all worktrees. Do this *before* the removal, because afterwards the guard cannot. Deleted tips are
recoverable from `refs/deleted-branches/…` / `refs/deleted-stashes/…`
([[deleted-branch-tips-live-in-refs-deleted-branches]]) but only if something captured them.

**FIXED 2026-08-23 — PR #2337, merged and live on `origin/main` at `bd87f8c3`.** `bash-guard.mjs`
(already registered as `PreToolUse(Bash)`, so no settings change) now hands any removal-shaped
command to
`worktree-exit-guard.mjs --pre-removal`, which runs the same check against the TARGET worktree and
logs it before the directory goes. It never denies. The clean case is logged too, on purpose: a log
that only speaks up on failure cannot be told apart from a broken one.

Two further holes closed by the same PR — both worth knowing on their own:

- **`origin/main..branch` renders an unmeasurable branch as CLEAN.** That was the no-upstream
  fallback. `git rev-list --count origin/main..<branch>` returns 0 when `origin/main` itself cannot
  be resolved — no remote, never fetched, remote renamed — so a fully laptop-only branch reported
  "clean, safe to remove". Count `rev-list --count <branch> --not --remotes` instead: it is what
  `scripts/check-unbacked-branches.ts` uses, and it is right for that script's own documented
  reason — a branch pushed under a DIFFERENT name is backed up, and flagging it is a false alarm.
- **A count that cannot be measured must not be zero.** The guard now returns null and says
  `UNVERIFIED`, and the retirable branch requires an explicit `0`. Same shape as
  [[a-narrowed-select-disarms-every-gate-downstream-of-it]].

Still true after the fix: the SessionEnd leg remains blind when its own directory is gone, because
node cannot load a script that was deleted with the worktree. The pre-removal entry is what covers
that window now.

**The fix only protects a session whose OWN checkout contains it.** Hooks run from
`$DIR/.claude/hooks/`, i.e. the removing session's working tree — so a worktree branched before
`bd87f8c3` still runs the old, silent guard, and a session whose root is already a deleted husk runs
no hook at all. Both were true in the very session that shipped this. So an empty
`worktree-exit.log` is still not proof; the repo-wide command above remains the thing to actually
run.
