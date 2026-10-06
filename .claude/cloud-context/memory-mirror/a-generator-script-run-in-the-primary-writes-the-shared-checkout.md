---
name: a-generator-script-run-in-the-primary-writes-the-shared-checkout
description: "`primary-write-guard.mjs` only catches Write/Edit/NotebookEdit — a SCRIPT's own writes sail straight through, so `node scripts/sync-cloud-context.mjs` run from the primary silently dirtied 10 tracked files and created 8 untracked ones in the checkout another live session owns (2026-10-05). `cd` to your own worktree before running ANY generator, and if it already happened, prove the edits are yours by mtime before reverting — never blanket `git checkout --` in the shared primary."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0a4c50b5-ae9b-4511-844d-b5ab0c82da8b
  modified: 2026-10-05T16:53:49.879Z
---

🔴 **THE PRIMARY-WRITE GUARD DOES NOT COVER SCRIPTS.** `.claude/hooks/primary-write-guard.mjs` is a
PreToolUse hook on **Write / Edit / NotebookEdit** only. A generator invoked through Bash writes with
its own `fs.writeFileSync`, which the hook never sees — so the one thing the guard exists to prevent
happens anyway, silently, and `git status` is the only place it shows.

**Measured 2026-10-05.** `node scripts/sync-cloud-context.mjs` run from
`F:\Phoenix Workforce\phoenix-workforce` (the shared primary, held by a live session) modified **10
tracked files** — `.claude/cloud-context/README.md`, the mirror's `MEMORY.md`, six `.claude/rules/*.md`
and `scripts/module-memory/assignments.json` — and created **8 untracked** mirror notes. None of it was
intended; the command was meant as a read-only drift check, and `--check` is not a flag it honours.

**Worse in a stale primary.** That checkout was 5+ commits behind `main`, so the regeneration was
against an old tree: the diff would have been wrong even if it had been wanted. Same family as
[[cronjob-sync-from-a-stale-primary-runs-the-old-jobs-map]] — a repo script runs from the WORKING
TREE, not from `origin/main`.

**Two rules.**

1. **`cd` to your own worktree before running ANY generator**, not just before an edit. If the work has
   no worktree, make one — a read you thought was a read is exactly how this lands.
2. **If it already happened, prove the edits are yours before reverting.** `stat -c '%y'` on each file:
   mine were all stamped within the same two seconds, which settles it. A blanket
   `git checkout -- .claude/` in the shared primary would discard whatever another session had in
   flight there, which is the damage this rule is meant to avoid, inflicted while cleaning up.

**Also leaves rubbish on the preview box.** A killed `remote-check` run leaves its tree under
`/home/phx/remote-check/runs/` *and* a `refs/remote-check/<runId>` in the bare repo. `STALE_RUN_MINUTES`
(360) reaps the directories on a later run, the refs accumulate: 25 of them and 6 orphaned registered
worktrees were sitting there. Clean only the runs whose sha prefix is your own commit and that have no
live process — never a blanket sweep, which would take another session's live run with it.
See [[the-preview-boxs-next-build-ooms-after-compiling-successfully]].
