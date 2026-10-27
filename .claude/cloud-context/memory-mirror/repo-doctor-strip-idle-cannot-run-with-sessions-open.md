---
name: repo-doctor-strip-idle-cannot-run-with-sessions-open
description: "repo:doctor --fix and --strip-idle refuse above ONE live Claude Code session; --force clears that guard but NOT the OS lock, and its idle check reads source mtimes, not processes — so --strip-idle --force can delete node_modules out from under a running job. The 'N reclaimable' headline is an unfiltered ceiling. And repo-doctor's LIVE list is NOT the worktree inventory — an out-of-tree Copilot/Codex worktree is invisible to every safety check."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bdd6297-a7c0-4136-9263-d285c7524d07
  modified: 2026-10-08T00:14:31.683Z
---

Both mutating modes of `repo:doctor` (`--fix`, `--strip-idle`) refuse above ONE live Claude Code session
(the guard fails closed — it also refuses when it cannot count sessions). `--force` clears the session GUARD,
never the OS LOCK. **Count sessions first with the guard's OWN expression** so you don't burn a full walk:

```powershell
@(Get-Process claude -EA SilentlyContinue | Where-Object { $_.Path -like '*claude-code*' }).Count
```

🔴 **Do NOT count by `node.exe` command line** — that matches the `openai-bridge/server.mjs` helper each
session spawns (its PATH contains `.claude`), and bare `Get-Process claude` also catches the desktop app's
`claude.exe`. Three different numbers for one question; only the `*claude-code*` path filter is what the
guard enforces. The helpers are CHILDREN of the session PIDs, so when telling the owner which to close, report
the PARENT `claude.exe` PID (`Win32_Process.ParentProcessId`) — killing a helper does not close a session,
and helper count ≠ session count.

## 🔴 idleMinutes() is not a liveness check — the one way this tool can destroy something

`idleMinutes()` takes the newest SOURCE mtime (counting gitignored files, skipping node_modules/.next/.git)
and **never looks at processes**. A long-running job that writes nothing into the worktree reads as fully
idle, and `--strip-idle=1 --force` will then delete node_modules out from under a live `node` process — on
Windows `fs.rmSync` hits the open files, EPERMs partway, and leaves a HALF-DELETED node_modules that
`pnpm install` cannot reliably repair. **Pre-flight with process CWDs, not mtimes:** enumerate each process's
PEB (`NtQueryInformationProcess` → `ProcessParameters.CurrentDirectory` — `Get-Process` alone cannot),
match the path; "NO process has that directory as its cwd" is the only green light (script at
`scratchpad/find-cwd.ps1`). Also 🔴 **a "live" worktree is not always a session's root** — `list_sessions` can
show no session rooted there while one merely `cd`'d in to run a script, so a worktree can be a shared scratch
area; the tell is the Bash tool's cwd temp file (`…/Temp/claude-<id>-cwd`). And any COMMIT in a worktree
resets its idle clock to zero (excluding it for the 120-min default) — if rescuing files AND stripping,
strip first.

## 🔴 The "N path entries reclaimable" headline is an unfiltered CEILING

It is a raw sum of every live worktree's cache with **no clean/pushed/idle test** (a code fact:
`reclaimable = live.reduce(... cacheEntries ...)`; the eligibility checks run only in the `if (stripIdle)`
block at strip time). So quote it as a ceiling, never a promise. **Predict the outcome before running:** for
each cache-holding worktree read its idle minutes and compare to the **120-min** default threshold — a
two-second check replacing a multi-minute walk. On a busy machine a forced run often reclaims 0 (every heavy
worktree refused for uncommitted files or a recent touch — those refusals are the feature, re-run at deletion
not read from the printed inventory); when exactly ONE heavy worktree is genuinely free it reclaims the full
ceiling.

## Husks and per-worktree guards

- `--force` on `--fix` is very often a guaranteed no-op: a husk that is a live session's cwd EPERMs. **A NEW
  husk is MORE likely held, not less** — it appears when a live session's worktree is deregistered while the
  session keeps running ([[worktree-remove-permission-denied-still-deregisters]]), so "showed up since the
  last run" is evidence its holder is alive. The OLDEST husks are the better candidates.
- **A clean `git worktree remove` STILL leaves a husk** (empty node_modules tree + dangling symlinks, 0
  files) — follow every retire with a `--fix`; that one deletes, because its session is gone.
- 🔴 **A stash count is NOT a per-worktree signal** — `refs/stash` lives in the COMMON ref store, so
  `git -C <wt> stash list` prints the whole repo's stack and `git worktree remove` cannot touch it; guarding a
  retire on stash count aborts EVERY retire forever. Guard on `git status --porcelain` PLUS
  `git log origin/main..HEAD --not --remotes=origin` (the second is what catches a commit on no remote).
- **Safe by construction:** the primary checkout is never a candidate (only `.claude/worktrees`,
  `.codex-worktrees`, `_wt-*` under repo root + parent; `primaryRoot` never added), and every candidate is
  re-verified immediately before deletion (clean tree, 0 commits off any origin ref, untouched 120+ min; only
  node_modules/.next go, `pnpm install` restores).

## 🔴 repo-doctor's LIVE list is NOT the worktree inventory

repo-doctor's candidate scan is scoped to the repo root and its parent, so **a Copilot/Codex worktree on a
DIFFERENT drive is invisible** to the LIVE inventory, the husk scan, `--strip-idle`, AND the AGENTS.md §5
xlsx/pdf rescue that every cleanup runs. `git worktree list` and repo-doctor's LIVE list genuinely disagree.
**Diff `git worktree list --porcelain` against the doctor's LIVE list before any cleanup**, and
`git -C <wt> status` anything only git knows about — especially under `.claude/`, where an uncommitted change
alters what future agents may do (a disabled-safety-guard `settings.json` once sat unreviewed 16 days in
exactly this blind spot). Copilot/Codex agents create out-of-tree worktrees, so this recurs. Sibling of
[[a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route]]: a scan that looks complete because its
own output is internally consistent.

## Operational notes

- **The classifier is per-COMMAND, not per-TOOL** — "Bash blocked, PowerShell works" is NOT a standing rule;
  switching tools is worth exactly ONE retry, then hand the command to the owner (a third route is working
  around the denial). **Deleting a remote ref is blocked on EVERY route** (`git push origin --delete` via Bash
  and PowerShell, `gh api --method DELETE .../git/refs/heads/<b>`); reads all work, so verify a branch is
  stale but hand the delete one-liner to the owner. (The repo is `it-gawish-hr/phoenix-people-workforce`, not
  `phoenix-workforce` — a hand-built `gh api` path 404s otherwise.)
- **The run takes MANY MINUTES with no incremental output** (even a bare flagless run ~70s) — measuring
  mid-run reads as "it did nothing"; check for the live `repo-doctor.mjs` node process before concluding
  ([[repo-doctor-strip-idle-runs-for-many-minutes]], which also notes the RETIRABLE list checks uncommitted
  files but NOT unpushed commits — check `git -C <wt> rev-list --count --not --remotes HEAD` yourself). **Never
  plan a mutating pass off an inventory printed earlier** — worktrees appear and vanish between runs minutes
  apart; act on an inventory read in the same invocation (which repo-doctor does internally).
- 🔴 **AND THIS IS NOT A SLOW DRIFT — MEASURED 2026-10-08: `_wt-crm-switchover` read `git status --porcelain`
  = 0 lines (clean, fully pushed, no open PR), and FIVE MINUTES LATER the same folder read **168** with 78
  source files touched inside ten minutes** (a session had started `sync-cloud-context.mjs` in it), while a
  worktree that did not exist at the first reading — `_wt-crm-own-contact-id-staging` — appeared in the second.
  So a clean/pushed reading of ANOTHER session's worktree is evidence for seconds, not for a conversation: it
  was used to recommend a strip to the owner, and only the tool's own re-read at deletion time refused it. Do
  not lower `--strip-idle`'s threshold or add `--force` to get past a refusal like that — the refusal IS the
  re-read, and the thing it protects is a live session's `node_modules` mid-task. The durable half of such a
  worktree is its BRANCH: pushing it (by refspec from the primary, never `cd`-ing in) removes the single-disk
  risk without touching the folder at all, and the cache can be reclaimed whenever that session finishes.

Related: [[repo-doctor-no-origin-ref-is-usually-squash-residue]].
