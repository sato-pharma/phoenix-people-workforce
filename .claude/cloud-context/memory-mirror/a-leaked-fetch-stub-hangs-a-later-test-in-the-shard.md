---
name: a-leaked-fetch-stub-hangs-a-later-test-in-the-shard
description: "tests/nav-badge-store.test.ts leaves a stub globalThis.fetch (and window/document) for the rest of its process; a test that talks to a real local server through fetch then waits for ever, and a new runTest entry elsewhere decides which tests share that process"
metadata:
  node_type: memory
  type: project
  originSessionId: bd4997f0-537f-4b99-8af8-b9b349d2a257
  modified: 2026-10-31T03:04:05.479Z
---

On 2026-10-31 PR 6698 (a rep-planner colour change) froze the `unit (2)` CI job until its timeout, twice: shard 4 of 4
stopped right after "CRM vacation backfill marker" and the next test, `runDevServerGracefulRestartTests`, never
finished. Cause: `tests/nav-badge-store.test.ts` replaces `globalThis.fetch` with a stub (15 times) and never puts the
real one back; it also sets `globalThis.window`/`document` when imported. The graceful-restart test sent `fetch('/slow')`
to its own `http.createServer`, the stub answered instead, `inFlight` stayed 0, and `while (inFlight < 1)` spun.
The PR's only test change was one new `runTest` entry — `createShardDeal` (`tests/shard-deal.ts`, least-load fill)
then dealt the two tests into the same shard, so a change in an unrelated module "caused" it.

Fixed in commit 8c148b56c on that branch: the test uses `http.get` (`agent: false`) and `node:timers/promises`, and the
wait has a 10 s deadline. Proven in one process: nav-badge-store then the test passes in 0.4 s; the old version hung
until killed (exit 124). The leaker itself was left alone: restoring the real `fetch` could let later tests in the
shard reach the network for real.

**Why:** a hung shard shows no failing test — the sharded runner hides PASS lines, so the job just times out.

**How to apply:** a test that reaches a real server uses node's own `http` client and `node:timers/promises`, never
the globals, and every wait loop has a deadline. A shard that freezes: find its last output line, run that shard offline
(`env -i … CI=true PHX_TEST_SHARD=n/4`, no `--env-file`), and preload a setter on `globalThis.fetch`/timers to name who
replaced them.
