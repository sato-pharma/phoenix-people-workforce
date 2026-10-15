---
name: a-piped-run-watch-exit-code-is-tails-not-ghs
description: "A backgrounded `gh run watch --exit-status | tail` or `gh pr checks --watch | tail` reports exit 0 on a FAILED run, because a pipeline's status is the LAST command's — so the task notification says success about a red run; read the conclusion live, never the exit code."
metadata:
  type: feedback
---

🔴 **A BACKGROUNDED WATCH THAT ENDS IN A PIPE CANNOT REPORT FAILURE.** `gh run watch <id>
--exit-status | tail -6` exits **0** when the run concluded `failure`, because a shell pipeline's
exit status is the last command's (`tail`), not `gh`'s — and `xargs` in front of it hides it twice
over. The background-task notification therefore reads `completed (exit code 0)`, which is the one
thing a session acts on without re-checking.

Measured 2026-10-15: `main`'s CI run on `b21edd950` concluded **failure** (the stale
`AGENTS.md` module directory) and the watch notified exit 0. It was caught only because the same
step also read `/api/healthz` `revision` and saw production still on the previous green `main`.

**Why:** the standing rule is already *"a background task's notification reports the shell's exit
status"* — this is the same hazard one layer down, where the shell is a pipeline and the status
belongs to a formatting command that always succeeds.

**How to apply:** run the watch bare, with no `| tail`, `| head` or `xargs`, so `--exit-status`
survives — or treat the notification as *"the watch finished"* only and read the verdict live
(`gh run list --branch main --workflow CI --limit 1 --json conclusion`, or `gh pr view <n> --json
mergeStateStatus`). For a deploy, the verdict is `/api/healthz` `revision`, never the run at all.
Same for `gh pr checks <n> --required --watch | tail`. Related: [[verify-the-emitted-artifact-never-the-source]].
