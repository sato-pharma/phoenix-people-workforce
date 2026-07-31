---
name: worktree-triage
description: Run the delete-on-merge worktree cleanup ritual safely — squash-aware merged checks, xlsx/pdf rescue, batch owner approval. Use after PRs merge, when `git worktree list` grows past ~6 entries, or when asked to "clean worktrees".
disable-model-invocation: true
---

# Worktree Triage

Implements AGENTS.md § Parallel Work Model → Delete-on-merge ritual. Destructive
steps ALWAYS get owner approval first; everything before the approval is read-only.

## 1. Inventory (read-only)

```bash
git worktree list
```

For every worktree except the primary checkout, collect:

```bash
git -C "<worktree-path>" status --porcelain     # uncommitted/untracked work?
git -C "<worktree-path>" branch --show-current  # its branch
gh pr list --head "<branch>" --state merged --json number,title,mergedAt
gh pr list --head "<branch>" --state open   --json number,title
```

**Squash-aware rule:** `gh pr list --head <branch> --state merged` is the ONLY
valid merged test. Never use `git branch --merged` / ancestry — squash merges make
it permanently false (this exact bug let 24 stale worktrees accumulate).

## 2. Classify

| Class | Criteria | Action |
| --- | --- | --- |
| REMOVE | clean tree AND merged PR (or detached HEAD with clean tree and no branch) | propose removal |
| KEEP — open work | open PR, or unpushed commits | keep, note why |
| KEEP — dirty | any uncommitted/untracked source changes | keep; NEVER remove |
| KEEP — locked | `.claude/worktrees/*` entries that are locked / belong to a live session | never touch |

## 3. Rescue scan (before any removal)

For each REMOVE candidate, scan for `*.xlsx` / `*.pdf` anywhere in the folder.
Any found file that is not byte-identical to a git-tracked copy moves to `xlsx/`
at the primary repo root (create it if missing) BEFORE the folder is removed.
This rule has no exceptions (AGENTS.md § Session And Worktree Safety).

## 4. One batch approval

Present the full table (worktree, branch, class, PR#, dirty-file count, rescued
files) and ask the owner once to approve the REMOVE list. Do not proceed on
silence.

## 5. Execute (only approved rows)

```bash
git worktree remove "<worktree-path>"        # never --force on first attempt
git branch -d "<branch>"                     # lowercase -d; if it refuses, STOP and report — do not -D
```

If `git worktree remove` refuses (dirty), re-classify as KEEP — dirty and report;
do not force. Finish with `git worktree list` + a summary of removed/kept/rescued.
