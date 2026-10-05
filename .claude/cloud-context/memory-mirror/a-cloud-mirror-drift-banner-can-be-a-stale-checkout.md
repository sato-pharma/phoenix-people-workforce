---
name: a-cloud-mirror-drift-banner-can-be-a-stale-checkout
description: "SessionStart's \"N mirrored memory files no longer match this laptop\" is measured in the PRIMARY checkout, so a primary one commit behind origin/main reports drift another session already fixed and merged. Re-run `node scripts/sync-cloud-context.mjs` in an up-to-date worktree FIRST: if it changes nothing but README.md's generated-at line, there is no drift and nothing to ship. `cloud-mirror-drift.mjs` already normalises CRLF, so a byte difference between a CRLF live note and its LF mirror is NOT what it flagged - do not go hunting a line-ending bug."
metadata:
  node_type: memory
  type: reference
---

Measured 2026-10-05. The banner named three files. In a worktree based on current
`origin/main`, a fresh `sync-cloud-context.mjs` produced **one** change — the
`## What is here (generated …)` timestamp in `.claude/cloud-context/README.md` — and two of the
three named files were already byte-identical. The third differed only by CRLF, which
`cloud-mirror-drift.mjs` normalises away (`norm()`, and its own comment says that is load-bearing
rather than tidiness).

So the banner was the **primary checkout** at `0091dec47`, one commit behind `origin/main`, where
another session's mirror refresh had not yet arrived. Same class as the memory-index budget figures,
which AGENTS.md already warns are the checkout's and not `main`'s.

**The cheap test, in order:** `git fetch`, then run the sync in an up-to-date tree and read
`git status --porcelain`. A README-only diff means revert it and move on — committing that timestamp
bump adds a file to an unrelated PR and proves nothing.

Related: [[verify-the-emitted-artifact-never-the-source]].
