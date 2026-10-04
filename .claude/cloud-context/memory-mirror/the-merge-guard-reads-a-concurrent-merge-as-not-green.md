---
name: the-merge-guard-reads-a-concurrent-merge-as-not-green
description: "bash-guard C10 judges \"green\" by `mergeStateStatus === CLEAN`, and that field flips to UNKNOWN the moment a merge starts — so a PR somebody else is merging right now reads as NOT green and the merge is refused on size, with a message insisting the PR is not green when its required checks are both `completed/success`"
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-04T13:30:09.508Z
---

Measured 2026-10-04 on #5319 (the roll-up). I read the gate live and got
`validate=completed/success checks=completed/success mergeStateStatus=CLEAN`, then ran
`gh pr merge 5319 --squash --match-head-commit`. **C10 refused**, with its own headline:
`🔴 THIS PR IS NOT GREEN YET — that is the only reason you are reading this`. The PR was in fact
MERGED about that second, by the owner's own click; my command never ran. Re-reading showed
`state=MERGED mergeState=UNKNOWN mergeable=UNKNOWN` — and `UNKNOWN` is not `CLEAN`, which is the
only thing C10's greenness test looks at (`bash-guard.mjs`, ~line 1072: "`CLEAN` alone counts as
green"). So the refusal was arithmetically correct about a field that had already moved on, and
completely wrong about the PR.

**Why:** the refusal's wording is unusually confident and names a cause ("not green") that the
check-runs API flatly contradicts, so the tempting reads are both wrong — that the gate list rotted
again, or that `PHX_MERGE_OK=1` is now required. Neither. GitHub blanks `mergeStateStatus` to
`UNKNOWN` while it recomputes mergeability, which includes the window in which a merge is landing.
Reaching for the stand-down here would have been a bypass of a guard that was not actually blocking
anything, and that flag is the one the auto-mode classifier refuses (it deadlocked #4988 until the
owner pressed Squash and merge himself).

**How to apply:** when C10 says "not green" and `gh api .../check-runs` says every required context
is `completed/success`, **read `gh pr view --json state` before anything else.** `MERGED` means it is
already done — say so and verify production, never retry and never stand the guard down. This is
[[a-declined-tool-call-is-not-proof-the-change-did-not-land]] in a second shape: on 2026-10-04 two
merges (#5315 and #5319) landed while this session's own command was refused or self-aborted, which
is ordinary when the owner runs many sessions. The same `UNKNOWN` also makes
`mergeStateStatus` useless as a pre-merge gate for a few seconds after any push — prefer the
required contexts' own conclusions, read by sha, which is what [[a-closed-pr-still-takes-a-push-and-reports-a-stale-head]]
also lands on.
