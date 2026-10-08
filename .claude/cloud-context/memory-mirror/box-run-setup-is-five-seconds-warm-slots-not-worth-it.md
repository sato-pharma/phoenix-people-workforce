---
name: box-run-setup-is-five-seconds-warm-slots-not-worth-it
description: "remote-check's per-run setup on the Hetzner box costs ~4.6s, not tens of seconds — fresh worktree 1.0s + `pnpm install --frozen-lockfile` 2.5s (pnpm hard-links 1.2 GB from the warm store) + teardown 1.1s; warm node_modules slots (perf plan P1-1) would save ~3s per 2–9 min run, so it was measured and NOT built (2026-10-08)."
metadata:
  node_type: memory
  type: project
  originSessionId: 6a8bf024-0835-4d85-b715-0e9995210381
  modified: 2026-10-08T13:29:01.588Z
---

Measured 2026-10-08 ~16:35 Cairo on the box as `phxci`, holding the box lock (`flock -n`, so nothing
ran beside a real run), at main `456e48a16`, 5.3 GB RAM free:

- `git worktree add --detach` of the bare repo: **1,008 ms**
- `corepack pnpm install --frozen-lockfile` into that fresh tree: **2,461 ms** (node_modules 1.2 GB — pnpm
  hard-links from its content store, it does not copy or download)
- the same install again with node_modules already present (what a warm slot would give): **575 ms**
- `git worktree remove --force`: **1,143 ms**

So a pool of warm slots saves about 3 seconds on a run whose stages take 2–9 minutes, and it would
trade the private-per-run tree (which is what makes `same_tree` and the stale-state guarantees hold)
for leftover state between runs. The performance investigation had guessed "tens of seconds"; that
guess was wrong.

**Why:** P1-1 ("warm node_modules per box slot") was ordered on 2026-10-08 and stopped after this
measurement, before any code was written.

**How to apply:** do not re-propose warm slots or a reused box tree for speed. If box runs feel slow,
the time is in the stages themselves (lint/test/build) or in waiting for the box lock — measure those.
A changed lockfile downloads new packages either way; slots would not help that case. Related:
[[slowness-audits-compare-before-and-after]].
