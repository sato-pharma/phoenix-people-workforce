---
name: feedback-parallel-session-pr-collision
description: "Doing everything right (isolated worktree, committed, pushed, PR opened) doesn't prevent collision when another parallel session fixes the same live incident first — check before merging"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3ffe51a6-2564-428f-b029-999f5c7f47e3
---

On 2026-07-16 I investigated a production cron timeout (see [[notifications-cron-timeout-chain-2026-07-16]]), correctly isolated in my own worktree, committed, pushed, and opened PR #1069 — following every mitigation in [[parallel-session-swarm-hazard]] (isolated worktree, commit+push fast). CI passed. When I went to merge (per explicit user approval), the PR was `mergeable: CONFLICTING` — a **different parallel session** had independently diagnosed and fixed the *exact same root cause* in the *exact same 3 files*, and its PR (#1068) merged 15 minutes before mine finished CI.

**Why:** working in an isolated worktree and committing/pushing fast prevents *lost-edit* races (the failure mode the existing memory covers), but does nothing to prevent *duplicate-work* races — two sessions can each do everything correctly in isolation and still collide at the PR-merge step when they're independently responding to the same incident/log signal.

**How to apply:** Before merging any PR — especially one opened in response to a live incident or an alert/log signal another session could plausibly also be watching — re-check `gh pr view <n> --json mergeable,mergeStateStatus` (not just CI status) immediately before merging, even if it was clean when opened. If `CONFLICTING`, don't force-resolve or rebase-and-merge blindly: diff the conflicting commit on `main` against your own branch first (`git diff <merge-base> <main-tip> -- <files>`) to see whether someone already shipped an equivalent fix. If so, close your PR as superseded rather than merging a duplicate/conflicting change — don't treat the user's earlier "merge once CI passes" approval as still applying once the situation has materially changed (a stop condition per AGENTS.md, not something the original approval covers).

**Owner feedback, relayed via cross-session message from the #1068 session (2026-07-16):** the collision cost a full independent investigation cycle that didn't need to happen — check *before starting*, not only before merging. Specifically: when the problem you're about to investigate was already named as a known follow-up in another recent PR/incident's own description or logs (here, #1067's merge notes explicitly called out `probation-feedback-sla`/`probation-milestones` as "the target for any deeper follow-up," which is exactly what led me to independently chase it via `getEmployeeDirectoryRows()`), run a quick `gh pr list` and/or `git log origin/main --oneline -20` first to check whether a PR or recent commit already addresses it. Several sessions are routinely active on this repo concurrently — treat a named follow-up target as a signal someone else may already be on it, not just a TODO for you.


## 2026-08-27 — the collision that NO git check could see

Third instance, and the first where every recommended detection step returned clean. Two sessions
independently wrote the same `AGENTS.md` entry (the `APP_ENV`-unset-on-staging finding). The checks
this file already prescribes all said "nobody else is on it":

- `gh pr list` — no PR. The other session never opened one.
- `git log origin/main --oneline` — nothing. It never committed.
- `git worktree list` — nothing. It worked **in the primary checkout**, not a worktree.

**What actually surfaced it was the SessionStart hook's one-line working-tree summary** —
`0 staged, 1 modified, 0 untracked / Changed: M AGENTS.md`. That, plus the fact that the reported
session PID was **not a running process** (a stale lock — they self-expire after 2 hours), was the
whole signal.

**The half that lives outside git is the dangerous half.** The other session's job had two parts:
edit `AGENTS.md` (in the repo, uncommitted) and trim the relocated hooks out of `MEMORY.md` (under
`~/.claude/`, **not version-controlled at all**). It finished the `MEMORY.md` half and not the git
half. Net effect on `main`: two memory files — `local-run-against-prod-db-silently-skips-every-email`
and `staging-cannot-rehearse-shapes-only-prod-surgery-made` — had their index lines deleted while
nothing on `main` carried their content, so they were reachable from **neither** auto-loaded file.
An orphan created by a half-finished relocation looks exactly like an orphan created by neglect, and
no repo-level check can see it, because one side of the move is not in the repo.

**How to apply:**

1. **Read the SessionStart working-tree line as a collision signal, not as noise.** A modified file
   in the shared primary checkout that you did not modify is another session's live work. `git status`
   in the primary costs nothing and is the one check that catches an uncommitted collision.
2. **Merge, do not duplicate, and do not delete.** Both drafts here started from the identical blob
   (`git rev-parse HEAD:<path>` matched on both sides), so folding the other session's unique content
   into your branch was clean. Never discard their working copy to resolve it — take their content,
   leave their file alone, and say in the PR that their copy is now redundant so the owner can decide.
3. **When a relocation spans git and `~/.claude/`, finish both halves or neither.** Before claiming
   "relocated from `MEMORY.md`" in a committed file, verify the index actually no longer holds it —
   and conversely, before trimming the index, verify the destination is **merged**, not merely
   written. Between those two moments the fact exists nowhere.

See also [[two-sessions-fixed-one-bug-main-was-never-ci-validated]] and
[[parallel-session-swarm-hazard]].


## 2026-08-27 (later) — the stale lock gave a FALSE all-clear

Fourth instance, same day as the third, and the sharpest lesson yet: **a stale session lock proves
the named PID is dead, not that the folder is unattended.**

SessionStart named PID 22284 as another session in the primary checkout. `Get-Process -Id 22284`
returned nothing, so I correctly called the lock stale and proceeded to work in the folder — which
was the right call about *that* PID and the wrong conclusion about the folder. A different, live
session was active in the same repo the entire time and appeared in **none** of the startup signals.

**What actually surfaced it, in the order it showed up:**

- A local branch `claude/xenodochial-clarke-920dba` appeared in `git for-each-ref refs/heads` that
  was demonstrably absent from the same command minutes earlier, with a worktree under
  `.claude/worktrees/` (those belong to other live sessions — never remove one).
- Sibling worktree `_wt-harden-cron-secret-routes` advanced across three checks minutes apart:
  `268ce85f` -> `cff720ff` -> `5269aa90`. A moving HEAD in a worktree you do not own is live work.
- `_wt-agents-app-env-trap`, then `_wt-constant-time-doc`, vanished from `git worktree list`
  between checks.
- Two untracked probes appeared in the **primary checkout** at 21:14 and 21:16 —
  `tests/_tmp-no-list-probe.ts` and `tests/_tmp-no-list-deepdive.ts` — importing
  `src/lib/crm/sfe-doctor-coverage.ts`, the exact module PR #2480 had just changed at 21:04.

**How to apply:**

1. **Never read a stale lock as "the folder is mine."** Re-run `git for-each-ref refs/heads` and
   `git worktree list` at intervals during a long session; a branch or worktree that appears,
   moves, or disappears between two runs is another session, and it is the only signal you get.
2. **Untracked `tests/_tmp-*` files you did not create are another session's live probe.** Do not
   delete them — the standing rule against discarding work you did not create applies, and these
   are exactly the throwaway scripts that also leak commit charge
   ([[commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb]]). Report them and let the owner
   decide.
3. **Before calling a worktree's `.xlsx` files strays, run `git ls-files`, not `check-ignore`.**
   I found eight spreadsheets in a session worktree, ran `git check-ignore` on the path *from the
   primary checkout*, got a hit on `.gitignore:36:.claude/worktrees/`, and concluded they were
   ignored strays at risk of deletion. Wrong: all eight were **tracked and unmodified** — present
   in every checkout, byte-identical to the primary, and absent from `git status` for the most
   ordinary reason there is. The `.claude/worktrees/` rule ignores that directory *as seen from the
   parent repo*; it says nothing about how files inside the worktree are tracked by the worktree.
   Ask `git ls-files '*.xlsx'` and `git -C <worktree> status --porcelain -- '*.xlsx'`, and hash-compare
   before moving anything. The never-delete-a-spreadsheet rule is real, but applying it to committed
   files turns a no-op into eight spurious deletions in another session's working tree.

## 2026-08-27 (later still) — the fifth instance, and I CAUSED it

The first four were two sessions independently finding the same thing. This one was manufactured:
I reviewed a peer's PR (#2479), sent the author my findings, and then **opened my own PR (#2481)
for one of the findings I had just handed them**. They fixed it in their branch; I fixed it in
mine; both rewrote the same doc comment in `src/lib/security/constant-time.ts`.

**Handing over a finding transfers ownership of it.** There is no race to detect here and no check
that would have helped — `gh pr list` was clean when I started, because the duplicate did not exist
until I created it. The only thing that prevents this is the rule.

Merging mine first would have conflicted their branch, and **a conflicted PR runs no CI at all
here** — so the duplicate doc fix would have stalled the security fix it came from. Their version
was also strictly better: it included a point from my own review that I had left out of my comment.

**How to apply:**

1. **If you report a finding to another session, it is theirs. Do not also fix it.** Offer the text
   in the message if you have it drafted; let them commit it. Reviewing and patching the same defect
   in parallel is a self-inflicted conflict, not a race.
2. **When a duplicate does exist, the tiebreak is not "mine is open first" — it is which PR has to
   merge anyway.** Close the standalone one; the fix rides along with the change that motivated it.
3. **Check `gh pr view <n> --json files` on the PR you reviewed before merging anything adjacent.**
   The author acts on review feedback, so the file list at review time is not the file list at merge
   time. #2479 gained two files (`constant-time.ts`, `contract-renewal-hardening.test.ts`) after my
   review, and both were things I had raised.
4. **A closed-not-merged branch defeats `new-session.mjs --remove`.** Its branch gate asks
   `gh pr list --head <branch> --state merged`, which is empty for deliberately abandoned work, so
   it removes the worktree and keeps the branch. That is correct for the merged case and wrong here.
   Archive the tip yourself first — `git update-ref refs/rescue/<name> <sha>` — because
   `git branch -D` archives nothing (see [[deleted-branch-tips-live-in-refs-deleted-branches]]),
   then delete local and remote.
