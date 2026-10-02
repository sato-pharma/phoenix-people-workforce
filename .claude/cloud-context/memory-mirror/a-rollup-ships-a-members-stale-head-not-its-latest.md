---
name: a-rollup-ships-a-members-stale-head-not-its-latest
description: "A roll-up snapshots each member's head when `--apply` BUILDS the branch, so a member that pushes afterwards has its STALE commit shipped and then goes DIRTY — read each member's head sha against the roll-up body before merging."
metadata:
  node_type: memory
  type: project
  originSessionId: 1e66550a-0561-4d35-bf39-b2bff9fb5c9a
  modified: 2026-10-02T21:18:31.136Z
---

`scripts/rollup-prs.mjs --apply` resolves every member's head at **build** time and never re-reads it.
The documented protection — "a member pushed mid-wait is LEFT OUT" — covers the 25-minute checks wait,
not the gap between the branch being built and the roll-up being merged. In that gap a member can push,
and the roll-up still carries the older commit.

Measured 2026-10-02, on roll-up #5191 (members #5188, #5189, #5190):

- 20:54:51Z — `--apply` built the branch from #5188's head `4df18d572`.
- 20:58:41Z — #5188's own session pushed `f93c220e8`, *"my own fix made every click a no-op — pass
  functions, not strings"*, then `d8226fbf1` at 21:02:38Z.
- 21:12:41Z — the roll-up merged (sha `78e1f0486`), shipping **commit 1 alone**, 18 minutes stale and
  already superseded by its author.
- #5188 then read `mergeStateStatus: DIRTY / CONFLICTING`, because main held its first commit and the
  branch held that plus two more. A conflicted PR produces **no Actions run at all**, so its earlier
  green on `d8226fbf1` was the last verdict it had.
- `--settle` was right not to close it: its three files genuinely differed from main, so it reported
  `ROLL UP` rather than `CARRIED`. **That disagreement between the roll-up body and `--settle` is the
  tell** — a member the body lists but `--settle` will not call carried has moved on.

What shipped was therefore a fix that does nothing: `page.evaluate<void>(CLEAR_FIELD_EXPRESSION, handle)`
at `turbify-joiner.ts:164` passes a string, which puppeteer evaluates as an expression, so the body never
runs and the argument is never bound. It is wrapped in `.catch(() => {})`, so it fails silently. Not a
regression — `HIT_TEST_EXPRESSION` and `NODE_CLICK_EXPRESSION` were already on main in the same broken
form at lines 134 and 144 — but not the fix the roll-up's body claimed either.

**Why:** a roll-up exists to replace several merges with one, and its body reads like an inventory of what
is inside it. It is actually an inventory of what *was* inside it at build time. Merging it then both
ships a state nobody verified as current and strands the member in a conflict.

**How to apply:** immediately before merging a roll-up, re-read each member's `headRefOid` and compare it
against what the roll-up carries — `git rev-parse <rollup-sha>:<file>` against the member's head blob is
the byte-level test. A member whose head moved after the build is a reason to rebuild the roll-up, not to
merge it. After merging, run `--settle` and **read which members it declines to close**; tell that
member's session what landed, and never resolve its conflict yourself — a live session owns its branch
(see [[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]]).
