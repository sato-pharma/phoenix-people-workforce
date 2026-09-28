---
name: feedback-parallel-session-pr-collision
description: "Doing everything right — isolated worktree, committed, pushed, PR opened, CI green — does NOT prevent a DUPLICATE-WORK collision: another parallel session independently fixing the same live incident. Isolation stops lost-edit races only. Check before STARTING (gh pr list + git log origin/main) and again before MERGING (mergeable, not just CI). Some collisions no git check can see — an uncommitted edit in the shared primary, or a half-done relocation into ~/.claude. And handing a finding to another session transfers ownership: do not also fix it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3ffe51a6-2564-428f-b029-999f5c7f47e3
  modified: 2026-09-26T00:14:05.515Z
---

**Fact.** Several sessions run on this repo at once. A session can isolate in a worktree, commit and
push fast, open a PR and pass CI — every mitigation in [[parallel-session-swarm-hazard]] — and still
collide, because a **different** session independently diagnosed the *same* incident and shipped the
*same* fix first. Learned five times (the first from a cron-timeout chase,
[[notifications-cron-timeout-chain-2026-07-16]]); the last one I manufactured myself.

**Why.** Isolation + fast commit prevents *lost-edit* races (two sessions clobbering one file). It does
NOTHING for *duplicate-work* races — two sessions each doing everything correctly in isolation, both
responding to the same alert/log/named-follow-up, colliding at merge. A conflicted PR runs **no CI at
all** here, so a duplicate can also STALL the real change it conflicts with.

## How to apply

**Check before you START, not only before you merge.** When about to investigate something another
session could also be watching — a live alert, or a follow-up another PR/incident's own notes named as
"the target for deeper follow-up" — first run `gh pr list` and `git log origin/main --oneline -20`.
Treat a named follow-up target as a signal someone may already be on it, not just a TODO for you.

**Before merging, re-check `gh pr view <n> --json mergeable,mergeStateStatus` — not just CI.** A PR
clean when opened can be `CONFLICTING` at merge time. If it is, diff the conflicting commit on `main`
against your branch (`git diff <merge-base> <main-tip> -- <files>`) before touching it: if someone
already shipped an equivalent fix, **close yours as superseded** rather than force-resolving a
duplicate. A materially changed situation is a stop condition (AGENTS.md §9); the owner's earlier
"merge once CI passes" does not still apply once someone else shipped the fix.

**Some collisions NO git check can see.**
- **An uncommitted edit in the shared primary checkout.** The other session may never open a PR, never
  commit, and work in the primary rather than a worktree — so `gh pr list`, `git log origin/main` and
  `git worktree list` all read clean. The one signal is the **SessionStart working-tree line**: a file
  modified in the primary that you did not modify is another session's live work. `git status` in the
  primary is the check that catches it.
- **A relocation that spans git and `~/.claude/`.** Moving a fact out of `MEMORY.md` (not
  version-controlled) into a committed `AGENTS.md` has two halves; between finishing one and the other,
  the fact is reachable from **neither** auto-loaded file and no repo check can see the orphan. **Finish
  both halves or neither** — before writing "relocated from MEMORY.md", verify the index no longer holds
  it; before trimming the index, verify the destination is *merged*, not merely written.

**A stale lock proves the named PID is dead, not that the folder is unattended.** A different live
session can be active in the same repo and appear in none of the startup signals. Re-run
`git for-each-ref refs/heads` and `git worktree list` at intervals during a long session — a branch or
worktree that **appears, moves (HEAD advances), or vanishes** between two runs is another session, and
often the only signal you get. (The live staleness test is now age-based and mostly resolves itself —
see the standing rules; this remains the durable habit for a long session.)

**When you find another session's work, MERGE it — never delete.** Untracked `tests/_tmp-*` files you
did not create are another session's live probe: report them, don't delete
([[commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb]]). When two drafts of the same file
started from the identical blob (`git rev-parse HEAD:<path>` matches both sides), fold their unique
content into your branch and leave their file alone; say in the PR their copy is now redundant so the
owner decides. **Before calling a worktree's `.xlsx` files strays, use `git ls-files`, not
`git check-ignore`** — `check-ignore` run from the *parent* hits `.claude/worktrees/` and falsely
reports tracked, byte-identical files as ignored strays. Ask `git ls-files '*.xlsx'` and
`git -C <worktree> status --porcelain -- '*.xlsx'`, and hash-compare before moving anything.

**Handing a finding to another session TRANSFERS ownership of it — do not also fix it.** Reviewing a
peer's PR and then opening your own PR for a finding you just handed them is a self-inflicted conflict,
not a race, and no check prevents it (the duplicate did not exist until you made it). Offer the drafted
text in the message; let them commit it. Their version is usually better — it can fold in a review point
you left out. When a duplicate does exist, the tiebreak is not "mine opened first" — it is **which PR
has to merge anyway**: close the standalone, let the fix ride with the change that motivated it. And
`gh pr view <n> --json files` on a PR you reviewed can grow after review, so re-check its file list
before merging anything adjacent.

**A closed-not-merged branch defeats `new-session.mjs --remove`** — its gate asks
`gh pr list --head <branch> --state merged`, empty for deliberately abandoned work, so it removes the
worktree and keeps the branch. Archive the tip first with `git update-ref refs/rescue/<name> <sha>`
(`git branch -D` archives nothing, [[deleted-branch-tips-live-in-refs-deleted-branches]]), then delete
local and remote.

See also [[two-sessions-fixed-one-bug-main-was-never-ci-validated]].
