---
name: a-merge-approval-naming-only-a-number-reaches-every-session
description: "A terse merge approval that names only a PR number reaches EVERY live session at once, and on 2026-10-02 two of them acted on the same words \u2014 #5174 was merged ten seconds after the roll-up that already carried it, shipping an empty squash; the owner ruled merge approvals go to ONE session, so ASK for a merge by naming the session as well as the number; and 2026-10-08 adds the half that makes it hard to see - A SESSION'S OWN Next step BOX IS NOT PROOF THE WORD WAS MEANT FOR IT, because two sessions waiting on the SAME PR quote the SAME words, so both read his reply as theirs (it happened twice in one night, #5482 one way and #5486 the other, each session reasoning correctly that the reply matched its own box). Check `ListAgents` before acting on a merge or a production apply; `--match-head-commit` makes the merge race safe - the loser gets `! Pull request #N was already merged`, exit 0, and must never retry - but a production WRITE has no such guard, so write the PR number and the reason INTO the SQL"
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

🔴 **AND HIS REPLY LANDING IN *YOUR* Next step BOX IS NOT EVIDENCE IT WAS MEANT FOR YOU — measured
twice on 2026-10-08.** Both sessions had the same PR as their next step, so both boxes quoted the same
words, and his one-line answer reached both. Each session then reasoned, correctly as far as it could
see, that the reply matched the words IT had put there.

- **#5482**, his `merge 5482 when its migration is applied`: this session applied the production ACL
  change and merged; the owning session was mid-`apply_migration` when it found the ACL already
  tightened, and had to reconstruct what had happened from `pg_stat_statements` before it would merge.
- **#5486**, his `merge 5486 when green`: the other way round. This session merged at 02:07:52Z; the
  peer ran its full gate, re-read the head, called `gh pr merge --match-head-commit`, and got
  `! Pull request #5486 was already merged`, exit 0.

**The merge race is safe and the production write is not.** `--match-head-commit` means the loser is
told plainly and nothing is damaged — never retry, never re-merge, settle it with the PR state. A
production apply has no equivalent, and `mergedBy` is the owner's one login for every session here (`it-gawish-hr` since the 27 Oct 2026 account move, `Gawish-1997` before) so it
attributes nothing. Two things make it recoverable: **`ListAgents` before the action**, and **the PR
number and reason written INTO the SQL statement**, which is what let the other session identify an
unexplained production ACL change as a known apply rather than an incident.
