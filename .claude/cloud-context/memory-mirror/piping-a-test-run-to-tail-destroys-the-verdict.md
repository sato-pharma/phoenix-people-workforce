---
name: piping-a-test-run-to-tail-destroys-the-verdict
description: `node tests/run-tests.ts 2>&1 | tail -20` reports TAIL's exit code (always 0) and keeps only the last 20 lines, so a suite the memory watchdog reaped reads as a clean pass with zero FAIL lines.
metadata:
  type: project
---

Running the unit suite as `node … tests/run-tests.ts 2>&1 | tail -20` came back **exit code 0 with
0 `FAIL` lines** — and had actually been **killed mid-run**. Two separate lies in one command:

- **The exit code is `tail`'s, not node's.** A pipeline's status is its LAST command, so a reaped or
  failing suite still reports 0. Same family as the standing `; echo $?` ban, different shape.
- **`tail -20` discards the evidence.** The 19 `PASS` lines it kept were the last 19 suites, which
  reads exactly like a short clean run.

**The tell:** `run-tests.ts` prints `PHX_SHARD_RESULT shard=… seen=… ran=…` from a `process.on("exit")`
handler and then an `N test files passed` summary. **Neither line present = the process never exited
normally**, whatever the status says. `mem-watchdog.ps1` reaps a test run under 1,800 MB free and
prints nothing at all.

**Why:** a full local suite is forbidden here anyway — CI's `validate` job is the gate — so the real
fix was to stop running it, not to re-run it with a bigger `tail`.

**How to apply:** never pipe a run whose verdict matters. Redirect to a file
(`node … > out.txt 2>&1`) and read it, or let the background task capture the whole stream and grep
it for the runner's own completion marker. Judge the run by that marker, never by the exit status of
a pipeline. See [[a-green-test-run-carries-no-type-signal-at-all]] for the other half: a green suite
says nothing about types.
