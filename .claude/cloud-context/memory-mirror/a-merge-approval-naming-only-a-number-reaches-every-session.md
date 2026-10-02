---
name: a-merge-approval-naming-only-a-number-reaches-every-session
description: "A terse merge approval that names only a PR number reaches EVERY live session at once, and on 2026-10-02 two of them acted on the same words — #5174 was merged ten seconds after the roll-up that already carried it, shipping an empty squash; the owner ruled merge approvals go to ONE session, so ASK for a merge by naming the session as well as the number"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 607aee7b-3f41-436f-be20-fbe122b720bf
  modified: 2026-10-02T19:57:29.708Z
---

**Owner rule, 2026-10-02: "send merge approvals to this session only."** He said it after watching
two sessions act on one approval inside ten seconds.

**What happened, measured.** This session built a roll-up (#5175: #5173 + #5170 + #5172) and put it
to him. He replied `merge 5174 when green` — **5174 was a number this session had guessed in the
previous reply, before either roll-up PR existed**, and by the time he sent it both #5174 (2 members)
and #5175 (3 members, a strict superset) were open. This session merged **#5175 at 19:51:41**.
Another live session read the same `merge 5174` and merged **#5174 at 19:51:51** — ten seconds later.
`git show --stat` on its merge commit prints **no files at all**: an empty squash, a full `main` CI
run for nothing. Separately #5170 was merged by its own session at 19:49, out from under both
roll-ups — the ~3-minute window the roll-up rule warns about, happening live.

**Why the existing hook was not enough.** `AGENTS.md` §2 already says a terse approval can reach
several sessions and to confirm it was meant for this one. That puts the duty on the session
RECEIVING it, and the session that merged #5174 had no way to know the number came from a different
session's guess. The missing half is on the ASKING side:

- 🔴 **When asking for a merge, name the session as well as the PR** — "merge 5175 (this session, the
  cloud-mirror roll-up)" — so a peer reading the reply can tell it is not theirs.
- 🔴 **Never put a PR number in a `Next step:` line before the PR exists.** This session quoted
  `merge 5174 when green` as ghost text for a PR it had not opened yet; he sent it verbatim, which is
  exactly what the box does. Quote the number only after reading it back from `gh pr create`.
- 🔴 **Before merging on a bare number, check whether a better PR supersedes it.** #5175 contained
  every file of #5174; merging the smaller one would have left two merges where one would do.

**How to apply.** Ask for one merge at a time, name the session and what the PR is, and read the
number from the opened PR rather than predicting it. If a peer's merge lands on your approval anyway,
report it plainly — it is waste, not a code fault — and check the superseded PR for a *stale* file
before closing it: #5172 also carried a pre-reorder `scripts/module-memory/assignments.json`, so
merging it would have reverted another session's reordering.

Related: [[the-small-pr-merge-guard-and-the-classifier-deadlock]] ·
[[hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces]] ·
[[a-background-poller-dies-with-the-worktree-it-runs-in]]
