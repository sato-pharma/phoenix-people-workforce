---
name: a-background-poller-dies-with-the-worktree-it-runs-in
description: "A background poller started with cwd inside a worktree dies the moment you remove that worktree, and a loop that settles on \"exit code is not the waiting code\" reads the crash as a settled answer — so retiring a worktree can silently convert \"still deploying\" into a reported success"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 26cfc13e-aebe-40fd-807a-79ce571d8a5c
  modified: 2026-10-02T19:34:25.113Z
---

Measured 2026-10-02 shipping #5168. A `verify-shipped.mjs` poller was backgrounded with its cwd in
`_wt-crm-ui-gaps`, written as `if [ "$code" != "2" ]; then settle; fi` — exit 2 being the verifier's
QUEUED code. The owner then approved retiring the worktree, `new-session.mjs --remove` deleted it,
and the next poll iteration died with `MODULE_NOT_FOUND` (exit 1) because the script's own path had
just been deleted underneath it. **Exit 1 is not 2, so the loop reported SETTLED** and printed the
node stack trace where a verdict belonged.

**Why it is dangerous rather than merely untidy:** the thing being waited on was *production serving
the merge*. A loop keyed on "not the waiting code" turns every crash — a deleted script, a killed
node job, a network failure, an OOM — into the success branch. On this laptop the memory watchdog
reaps node jobs under 1,800 MB and they print nothing, so the crash-as-success path is reachable
without anyone deleting anything.

**How to apply:**
- Start a long poller with its cwd in a folder that will **outlive the job** — this session's own
  worktree or the scratchpad — never in the worktree the task is about to retire.
- Before removing a worktree, account for background jobs running inside it; a `--remove` is also a
  kill of anything whose cwd is there.
- Settle a wait on the **presence of the expected answer**, not the absence of the waiting code:
  grep for the real `VERDICT:` line and treat "no verdict produced" as UNREAD, loudly. The same
  shape as the standing rule that `; echo $?` turns every background failure into a success.

Related: [[verify-the-emitted-artifact-never-the-source]], [[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]].
