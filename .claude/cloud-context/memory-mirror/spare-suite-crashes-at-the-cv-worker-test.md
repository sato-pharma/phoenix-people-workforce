---
name: spare-suite-crashes-at-the-cv-worker-test
description: "On the spare laptop node crashes (0xC0000005) at the CV worker test in most suite runs, on Node 24.22.1 and 24.15.0 alike"
metadata:
  node_type: memory
  type: project
  originSessionId: 38b195bf-e702-4c96-b875-98710799ea13
  modified: 2026-11-07T04:23:06.953Z
---

2026-11-07, measured: on the spare laptop (Windows), the unit suite reaches test #2815, "CV files from strangers are
parsed in a worker thread…" (`tests/cv-text-isolation.test.ts`), and node dies with an access violation (exit
-1073741819 = 0xC0000005) and no summary line. Five tries: whole suite on 24.22.1 twice (2,814 PASS both, crash),
4 shards on 24.22.1 (shard 4 crash), 4 shards on a pinned 24.15.0 once clean (706+709+709+746 = 2,870 = seen) and
once crashed. Run alone it passed twice. So it is intermittent and NOT the Node patch version; the pin was taken
back out. CI (Linux) never sees it.

A retry of a crashed shard was added the same night and crashed again on BOTH attempts (05:07 Cairo), so it is
frequent, not a one-off. NOT memory: a sampler at 05:21 Cairo caught the crash 0.6 s after the test started with
824 MB physical and 9.6 GB commit free (the dev server was down, so the box was emptier than usual). Cause unknown.
`~/.claude/scripts/spare-test.ps1` now runs CI's 4-shard split by default and prints "4 shards ran X of 2870" —
a crash shows as "NOT a full run", never as a short green.

Owner, 2026-11-07 ~05:40 Cairo: "skip the CV worker test on the spare only". PR 104 adds
`PHX_SPARE_SKIP_CV_WORKER_TEST=1` (tests/spare-skip.ts): one test, refused when CI/GITHUB_ACTIONS is set, never
counted as ran, prints `PHX_SHARD_SKIPPED`; spare-test.ps1 arms it and reports "ran X + N skipped on purpose".
Until PR 104 is on main the switch does nothing on a main-based run, so the CV crash can still appear there.

Two other spare-only reds, causes found:
- bash-guard C10 test: the env var is spelled `Path` on Windows; seven test sites copy `process.env` into a plain
  object and read `env.PATH` (undefined), so the fake `gh` dir became the WHOLE PATH and `findstr` vanished.
  The script now re-creates the variable as `PATH`; the C10 test then passed on the spare.
- the "type gate is the NATIVE compiler" test spawns `node_modules\.bin\tsc`, the Unix shim name (ENOENT on Windows).
  PR 107 runs `tsc.CMD` through a shell on win32. PR 104 merged 05:54 Cairo; the first run with it gave
  "2874 of 2875 + 1 skipped on purpose", with this test as the only red — no crash.

**Why:** a red or missing summary from a spare run is not a code verdict until these are ruled out.
**How to apply:** read where a spare run stopped before calling it a failure; the PR's CI stays the verdict.
Same day the script's file check was fixed: it counted STAGED files (`git status`), so every run carrying a patch
was refused as "N files off" ([[the-spare-laptop-runs-the-dev-server-and-the-tests]]).
