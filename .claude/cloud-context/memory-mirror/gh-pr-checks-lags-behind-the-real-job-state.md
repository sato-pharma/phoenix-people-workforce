---
name: gh-pr-checks-lags-behind-the-real-job-state
description: "A reported check state lies in BOTH directions: `gh pr checks` says \"pending\" for minutes after a job finished, and statusCheckRollup returns conclusion \"\" (empty string, never null) while a job is still RUNNING - so jq's `// \"PENDING\"` default never fires and a poller reads a running check as settled"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e57e90b1-6df8-4f5f-b57e-e8bd26ebf3a5
  modified: 2026-08-19T13:44:51.974Z
---

`gh pr checks <PR>` reads the commit-status API, which can lag the real job state. Observed
2026-08-19 on PR #2206: `gh pr checks` reported `validate  pending  0` while
`gh run view <run-id> --job <job-id>` showed `✓ validate in 4m47s` with every step already green.
The lag was several minutes, and `gh pr view --json mergeStateStatus` said `BLOCKED` the whole time
(consistent with [[merge-blocked-says-checks-but-means-behind]] — BLOCKED is not evidence of a red
check).

**Why it costs something here:** merging is the production deploy, so "wait for green" is a real
gate. A stale `pending` reads as "CI is still running", which stalls a merge the owner has already
approved — and in the other direction, polling `gh pr checks` in a loop can burn ten minutes waiting
for a job that finished before the loop started.

**How to apply:** treat `gh pr checks` as a summary, not as truth. Before concluding a job is still
running, confirm with:

```bash
gh run view <run-id> --job <job-id>
```

which prints the per-step ✓/✗ list and the real duration. Job **logs** are a separate matter — the
`actions/jobs/<id>/logs` API 404s until the job completes, so a 404 there genuinely does mean
"not finished yet". Once it returns, grep it for the specific test name rather than trusting the
suite's overall green (see [[prove-it-fails-verify-which-assertion-fired]] for the same principle
applied to assertions).

## The inverse, and the more dangerous one: a RUNNING check reads as settled

Measured 2026-09-03 on PR #3006, twice in one session with two different watchers. In
`gh pr view --json statusCheckRollup`, a job that has not finished carries **`conclusion: ""` - an
empty string, not `null`**. jq's `//` operator only substitutes for `null` and `false`, so the
obvious guard is silently inert:

```bash
# WRONG - "" is neither null nor false, so PENDING is never substituted
.conclusion // "PENDING"          # yields ""  ->  "validate=" reads as a settled check

# RIGHT - test the empty string explicitly
if ((.conclusion // "") == "") then "PENDING" else (.conclusion|ascii_upcase) end
```

The first watcher printed `validate= secret-scan= lint= typecheck=` and then declared
**"ALL FOUR REQUIRED CHECKS SETTLED"** while three jobs were still `IN_PROGRESS`. A `case` arm that
did not match an empty conclusion fell through to the exit branch. Nothing errored, and the output
looked exactly like a green result.

**Why it costs something here:** merging is the production deploy. This failure mode reports green
BEFORE the gate has answered, which is the direction that can ship unvalidated work - the opposite
of the lag above, which merely wastes time. It is also self-concealing: the watcher exits 0 and its
last line reads like success.

**How to apply:** never count a check as settled by the absence of a pending marker. Require the
positive form - N explicit `SUCCESS` values, with the empty string mapped to PENDING first - and
make the failure states (`FAILURE`, `CANCELLED`, `TIMED_OUT`, `STARTUP_FAILURE`) their own exit.
Then confirm the one that matters actually ran: on this repo a docs-only `validate` finishes in
about 10s by skipping the suite, so a duration near the full ~5m is what proves the tests executed
(see [[a-docs-only-pr-skips-the-whole-suite]]). Same principle as
[[prove-it-fails-verify-which-assertion-fired]]: a green summary is not evidence the specific thing
you care about happened.
