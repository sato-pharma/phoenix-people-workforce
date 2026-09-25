---
name: cannot-remove-the-worktree-you-are-running-in
description: "git worktree remove on your OWN worktree half-succeeds: registry entry and every file go, but the directory itself survives as a zero-file husk because the harness pins the session cwd back to it on every tool call"
metadata: 
  node_type: memory
  type: project
  originSessionId: 02c71e47-935f-4697-b5b8-8eabc82249b3
  modified: 2026-08-12T14:22:25.855Z
---

Hit live 2026-08-12 cleaning up `.claude/worktrees/ecstatic-mclaren-31e9fe` from the session that
was running inside it.

`git -C <primary> worktree remove <that path>` returns **exit 255**:

```
error: failed to delete '...': Permission denied
```

but it is **not** a no-op — it half-succeeds, and the halves are the confusing part:

| | Result |
| --- | --- |
| Registry entry | **removed** (`git worktree list` no longer shows it) |
| All tracked files | **deleted** (4,558 → 0) |
| The directory itself | **survives**, empty, no `.git` file |

So one `rmdir`-able empty folder is left, and because it has no `.git` file and no registry entry it
is **exactly the husk class `git worktree prune` and the SessionEnd guard cannot see** — see
[[strip-worktree-payload-before-removing-it]] and the same partial-deletion shape in
[[git-worktree-remove-can-timeout-and-partially-delete]].

**Why `cd` away does not help.** The holder is this session's own `claude.exe`, whose working
directory that folder is. The harness **re-pins the shell cwd back to the worktree after every tool
call** — the Bash/PowerShell result literally reports *"Shell cwd was reset to …"* — so
`Set-Location` elsewhere then `Remove-Item` still fails with *"being used by another process."*
There is no in-session workaround.

**How to apply.** When asked to clean up the worktree you are running in:
1. Do every safety gate first — they all still apply and all still work: xlsx/pdf rescue scan on the
   filesystem (not `git status`, see [[gitignored-xlsx-invisible-to-worktree-safety-checks]]),
   clean tree, squash-aware merged check (`gh pr list --head <branch> --state merged`), and confirm
   no *live* session lock ([[cannot-map-claude-sessions-to-worktrees]]).
2. Run the removal anyway — it does 99% of the work, and stripping the payload first
   (`node_modules`/`.next`) keeps it fast and avoids the timeout variant.
3. **Say plainly that one empty directory remains and why.** Do not report the cleanup as complete.
4. The empty folder is deletable the moment the session ends. `pnpm run repo:doctor --fix` is the
   designed sweeper and explicitly only deletes husks proven to hold zero files — which this is —
   but it refuses while more than one Claude session is live, so it is a later step, not this one.

**Do NOT hand the job to a detached watcher and call it done.** Tried 2026-08-24 from the session
inside `.claude/worktrees/priceless-lichterman-cdce98`: a background process (PID 27088) outside the
session's own process tree, polling every 15s for two hours, set to delete the folder the moment the
handle dropped. The session then reported *"nothing is pending — close this session and the watcher
will remove the husk on its own within 15 seconds."*

**It did not.** Checked 35 minutes later from another session: that session was gone from
`ListAgents`, PID 27088 was **not running**, and the husk was still on disk. Which half failed — the
watcher dying, or exiting before the handle dropped — is unknowable after the fact, and that is the
point: **a detached watcher reports to nobody.** Its failure mode is silence, indistinguishable from
success, and the only thing that ever notices is a later `repo:doctor` run. One `Remove-Item
-LiteralPath -Recurse -Force` from a different session cleared it in under a second once the handle
was actually gone.

So step 4 above is the whole answer: leave the empty folder, name it plainly as outstanding, and let
the next session sweep it. **Never close by asserting a future cleanup you cannot observe** — that is
a claim, not proof, and it is the one thing this repository's rules ask you hardest not to do.

**Do NOT run `pnpm` from the dying session to finish the job.** With cwd pinned to a deleted
worktree, package-manager commands resolve upward unpredictably, and
[[pnpm-run-in-worktree-tries-to-purge-junctioned-node-modules]] is what that costs. Run
`repo:doctor` from the primary checkout in a different session.
