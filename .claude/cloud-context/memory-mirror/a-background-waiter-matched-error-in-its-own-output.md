---
name: a-background-waiter-matched-error-in-its-own-output
description: "A background waiter that greps a task's output for a WORD (Error, error, failed, done) fires on the first line that happens to contain it — on 2026-10-19 01:22 Cairo one matched `new Error(` in a source line the same command had just printed, read 4 seconds into an 804 MB Drive upload, and the session started a SECOND upload that raced the first until it was killed. Do not write a waiter at all: a run_in_background task already notifies on exit and its output ends `[exited with code N]`. If one is unavoidable, match a unique sentinel the job prints only at its end. And before re-running a job that adds data, prove the first one is dead with Get-CimInstance Win32_Process on its command line — Git Bash `ps aux` cannot see native node.exe or railway.exe and printed 0 while the upload was alive."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e6a04225-ac71-4e9f-b85e-a9de1876a818
  modified: 2026-10-19T08:56:36.881Z
---

**What happened** (CV clean-up session, 19 Oct 2026, Cairo time). The 804 MB recruitment CV backup
zip was being copied to the company Drive with a background `railway run … node drive-upload.mjs`.
The same backgrounded command first ran a `grep -n` that printed two lines of the script, one of them
`throw new Error("usage: node drive-upload.mjs <zip path>")`. A second background task waited on it:

```
until grep -q '"identical"\|Error\|error' <the upload task's .output>; do sleep 15; done
```

It matched `Error` in that printed source line and fired at 01:22:57, four seconds in. The session
then read three signals as "the upload failed", and all three were wrong:

- **The waiter's match.** It matched the script's own text, not a failure.
- **Drive did not list the file yet.** A Drive upload is invisible until it completes, so "not in
  Drive" is what a running upload looks like.
- **`ps aux | grep -c drive-upload` printed 0.** Git Bash's `ps` lists only MSYS processes. The
  native `node.exe` and `railway.exe` doing the upload never appear in it.

So at 01:23 it started a second upload. The script's "refuse if a copy already exists" check could not
help, because neither run had finished. The first run completed at 01:43 with an identical MD5. The
second was found by command line and stopped at 01:44, and Drive was re-listed to prove it held
exactly one copy.

**Why:** a word is not a verdict. Any word a waiter looks for can appear in a source echo, a log
line, a usage string or a file name long before the job ends. A waiter that fires early is worse
than no waiter, because it produces a confident wrong conclusion. Re-running a job that ADDS data on
that conclusion creates a duplicate, and on production data a duplicate write.

**How to apply:**
- **Do not write a waiter for a `run_in_background` task.** The harness already notifies when it
  exits, and its output file ends with `[exited with code N]`. Act on that notification.
- **If a waiter is unavoidable**, for example for a job you did not start, match a unique sentinel
  the job prints only at its very end, such as `UPLOAD_RESULT:` or the harness's
  `[exited with code`. Never match `Error`, `error`, `failed`, `done` or `success`.
- **Before re-running anything that writes** (an upload, an insert, a send), prove the first run is
  dead. Use `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*<script>*' }`.
  Never use Git Bash `ps`, and never treat "the result is not there yet" as proof.
- **A job's own "already exists" guard does not protect two runs started at the same time.** Run the
  job once and wait for it.

Related: [[background-task-notification-exit-code-is-the-wrappers]], where a shell's exit status
hides a real failure. [[a-watchers-exit-code-is-a-verdict-about-the-watcher]] is the same family:
a watcher's error read as a verdict about the job. The `TaskStop` trap in
`docs/agents-session-traps-clusters.md` (it kills the wrapper and leaves the script running) is why
the stop here went by command line.
