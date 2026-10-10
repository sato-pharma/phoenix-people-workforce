---
name: a-sharded-test-jobs-log-tail-is-the-other-shard
description: "`run-tests-sharded` interleaves two shards into one job log, so the tail is usually the shard that PASSED — read the `[shard N/2]` lines of the failing shard, and the crash sits just before its `PHX_SHARD_RESULT` line."
metadata:
  node_type: memory
  type: project
  originSessionId: 5566e73c-38c0-4e93-b3c8-7857c2ef20ff
  modified: 2026-10-09T21:06:09.139Z
---

`validate` runs the unit suite through `scripts/run-tests-sharded.mjs`, two shards in parallel, both
writing into the SAME job log with a `[shard 1/2]` / `[shard 2/2]` prefix. The shards finish at
different times, so **the tail of the log belongs to whichever shard finished last — usually the one
that passed.**

On PR 5716 (run 37990191466, job 114022059368) the footer said `shard 1 exited 1`, and the log tail
read `[shard 2/2] … 1176 files, 268s` with every assertion green. A whole turn went into reporting
"the failing test is unidentified" from a log that contained it.

**How to find the real failure:**

1. `gh run view --job <id> --log > <file>` — save it; it is ~10k lines.
2. `grep -n "shard 1 exited"` for which shard failed, then
   `grep -n "\[shard 1/2\]" <file> | tail -3` for where that shard STOPPED.
3. The `AssertionError` sits in the ~30 lines before that shard's `PHX_SHARD_RESULT shard=1/2` line.

🔴 **Do not grep the whole log for `Error:` or `FAILED`** — the suite deliberately exercises failure
paths, so hundreds of `severity":"ERROR"` log lines from passing tests drown the one real assertion.
The headline to grep for is `FAIL ` followed by the test's own name.

Related: [[a-green-test-run-carries-no-type-signal-at-all]].
