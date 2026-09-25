---
name: background-task-notification-exit-code-is-the-wrappers
description: "A background Bash task's completion notification reports the SHELL's exit status — appending `; echo $?` after the real command silently turns every failure into 'exit code 0'"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6b107643-cd53-42d6-b2e1-91c2164d32d9
  modified: 2026-08-22T22:17:29.543Z
---

Hit twice in one session (2026-08-02, biometric-login work). Both times the notification said
**"completed (exit code 0)"** while the local validation gate had actually **failed**. (That gate
was `pnpm run check:harden`, retired 2026-08-18 — the wrapper trap below is about *any* long
backgrounded command and is completely unaffected by which one you run.)

## The mechanism — it is not a notification bug, it is the wrapper

```bash
# BOTH of these report exit 0 to the notification even when the command fails:
pnpm run ci > log.txt 2>&1 ; echo "EXIT=$?"
(pnpm run ci > log.txt 2>&1; echo "REAL_EXIT=$?" >> log.txt)
```

The shell exits with the status of the **last** command, which is the `echo` — always 0. The
notification faithfully reports that. The `$?` value written into the log is correct; the
notification is what lies. Anything appended after the command you care about (`echo`, `tee`,
a second command, a closing subshell) destroys the signal.

**How to apply:**
- Write the real code into the log (`echo "REAL_EXIT=$?" >> log`) and **grep the log for it**.
  Never accept the notification's number for a gate that decides whether work ships.
- Or append nothing, so the task's own status is the command's status.
- Same trap in the foreground: `cmd | head -40; echo $?` reports **head's** status, not `cmd`'s.
  Use `${PIPESTATUS[0]}`, or redirect to a file and check without a pipe.

## The same trap wearing a different hat: `gh pr checks --watch`

Hit twice again on 2026-08-05 (marketing Comparison tab, PR #1794). Launched in the background,
it reports **"completed (exit code 0)"** and its `.output` file is **empty until the moment it
finishes** — it buffers, so there is no interim progress to read mid-run. Neither the exit code
nor an empty file tells you whether the checks passed.

**How to apply:** when the watcher's notification lands, re-run a plain `gh pr checks <n>` and read
the verdict live before acting on it. For interim status mid-run, a plain `gh pr checks` is the only
thing that answers — reading the output file is a wasted call.

**Why it matters here:** [[railway-merge-is-the-production-deploy]] — a merge ships instantly at
full traffic. Branch protection's **4** required checks — `validate`, `lint`, `typecheck`,
`secret-scan` — do gate the merge itself, so a red PR cannot land. *(Corrected 2026-08-23: this said
**5**, adding `sast-scan`. Verified live against `gh api …/branches/main/protection` — there are four
and `sast-scan` is not one of them. `enforce_admins` is `true`, `strict` is `false`.)* A falsely-green
watcher still leads you to merge on a stale run, which is the failure this file exists to prevent.
Note `gh pr update-branch` MOVES the head, so CI re-runs and the previous
green no longer applies: re-check after any branch update. Both failures this session were real and mine
(a `react-hooks/set-state-in-effect` error, then a missing `accessRegistry` entry); neither
would have been noticed from the notification alone.

Related: [[ci-does-not-run-check-harden]], [[typecheck-incremental-false-green]],
[[dont-foreground-watch-long-pipelines]].
