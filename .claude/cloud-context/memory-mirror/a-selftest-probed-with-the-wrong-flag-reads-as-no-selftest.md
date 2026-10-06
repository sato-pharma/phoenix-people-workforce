---
name: a-selftest-probed-with-the-wrong-flag-reads-as-no-selftest
description: "Probing a script's selftest with the wrong flag prints NOTHING and exits 0, which reads exactly like \"this file has no selftest\" — `risky-allow-guard.mjs` takes `--selftest`, the other pinned hooks take a bare `selftest`, and a sweep for the bare word declared a working 12-case suite absent."
metadata:
  node_type: memory
  type: feedback
  originSessionId: ee1a6b46-7eb8-453b-b069-c3cc0cb7d10f
  modified: 2026-10-06T09:04:01.681Z
---

A sweep for "which global hooks have a selftest" ran `node <hook> selftest` against each one and read
an empty output plus exit 0 as **no selftest here**. `~/.claude/hooks/risky-allow-guard.mjs` dispatches
on `--selftest` (`process.argv.includes('--selftest')`), so the bare word fell through to the hook's
normal path, which with no tool payload on stdin does nothing and exits 0. A working 12-case suite was
reported as absent on 2026-10-06, and would have stayed absent if the same file had not been opened for
another reason minutes later.

**Why:** an absent feature and a mis-invoked one produce the *same* evidence — silence and success.
Exit 0 is the shape of both, so the probe cannot distinguish them, and the conclusion a sweep writes
down ("no coverage here") is the opposite of the truth. It is the same failure as a reaped typecheck
printing nothing: a session reads a null result as an answer rather than as a question.

**How to apply:** never conclude "no selftest / no mode / no flag" from a silent exit 0 — **grep the
file for the dispatch** (`argv`, `--selftest`, `selftest`, `process.argv[2]`) before saying it has
none, and `--help` is not an answer either. When a mode exists, pin its exact spelling in the test that
depends on it, because the hourly runner naming the wrong flag exercises nothing, silently and for ever
(`tests/risky-allow-guard-pin.test.ts` asserts `--selftest` for exactly that reason). The three pinned
global hooks are deliberately not uniform: `scratchpad-guard.mjs` and `next-step-capture.mjs` take a
bare `selftest`, `risky-allow-guard.mjs` takes `--selftest`.

Related: [[verify-the-emitted-artifact-never-the-source]],
[[a-background-tasks-notification-reports-the-shells-exit-status]]
