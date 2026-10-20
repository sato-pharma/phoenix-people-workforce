---
name: a-closed-pr-still-takes-a-push-and-reports-a-stale-head
description: "a CLOSED PR's branch still accepts a push, and its headRefOid stays frozen at the sha it had when it closed — wait-pr.mjs used to answer GREEN on the OLD sha (fixed 2026-10-20, on main since roll-up #6202 at 11:40 Cairo: it now exits 5 CLOSED); still check state before building on any PR"
metadata:
  node_type: memory
  type: project
  originSessionId: 640c7c13-5a83-45ef-a78e-4e3e126c4e1f
  modified: 2026-10-20T08:41:18.655Z
---

**A closed PR keeps answering as though it were open.** Measured 2026-10-04 on roll-up #5305:

- `gh pr list --state open` named it at 06:0x, but it had been **closed unmerged at 05:42:16**. The
  listing I acted on was a snapshot from before the close.
- Its branch `codex/rollup-20261004-0536` **still accepted my push** (`12f73de35..d79b60555`), and the
  `push-typecheck-guard` happily ran the remote typecheck for it. Nothing anywhere said the PR was dead.
- `gh pr view --json headRefOid` kept reporting **`12f73de35`**, the sha it held when it closed, even
  after the remote ref had moved. I read that frozen head as *GitHub lagging* — it was *GitHub
  describing a closed PR*.
- 🔴 **`scripts/wait-pr.mjs 5305 --green` then returned `GREEN on 12f73de35: validate=pass
  checks=pass`.** It is correct about what it looked at and silent about the PR being closed, so the
  line reads exactly like a merge-ready verdict on work I had just pushed. Same shape as the false-green
  bugs that script exists to prevent — the gap is PR *state*, which it does not report.

**FIXED 2026-10-20 (owner asked for it):** `scripts/wait-pr.mjs` now reads `state` with `mergedAt` on every
poll and ends a CLOSED, unmerged PR at **exit 5** (`CLOSED without merging`) before grading any check; an
unreadable state keeps waiting; `--ship` was already safe. Pinned by case 11 of `tests/wait-pr.test.ts`;
account in `docs/testing.md`, "Waiting for the gate", fourth shape. The paragraph above is the history.

**The tell is the head sha, and the right reading is the opposite of the obvious one.** When
`headRefOid` disagrees with `git rev-parse origin/<branch>` after a successful push, ask
`gh pr view <n> --json state` before anything else. A closed PR is the common cause; GitHub lag is the
rare one. `gh api .../commits/<sha>/check-runs` returning `total_count: 0` for the sha you just pushed
is the confirming sign — no run was ever created, because closing the PR stopped the trigger.

**What it cost:** a `remote-check test` on the box (443s, plus a 600s run lost to an SSH reset), a
remote typecheck, and a merge I set up on a branch that could never merge. Nothing was lost — #5303
had merged on its own at 05:47:10 as `20137d4a0` and was already serving production — but the roll-up
I had carefully updated was a corpse for the whole exercise.

**So before updating, waiting on, or merging ANY pull request another session opened, read its
`state` first.** Related: [[a-closed-pr-may-already-have-shipped-via-a-rollup]] (the mirror image —
proving a closed PR's work *did* land), and [[a-pr-check-grades-the-merge-so-it-can-fail-on-a-commit-you-never-wrote]].
