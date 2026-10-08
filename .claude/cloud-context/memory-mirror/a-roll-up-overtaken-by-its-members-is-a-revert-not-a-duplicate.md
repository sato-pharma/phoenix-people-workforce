---
name: a-roll-up-overtaken-by-its-members-is-a-revert-not-a-duplicate
description: "A roll-up whose members merge during `--apply`'s own checks wait comes out as a REVERT of them, not a redundant copy — #5520 was 16 insertions and 65 deletions against `main`, and merging it would have deleted a memory note, its `assignments.json` entry and the rebuilt module block. So decide close-vs-merge from a live `git diff origin/main <pr head>`, never from the documented `carried` assumption that an overtaken roll-up is merely empty."
metadata:
  node_type: memory
  type: project
  originSessionId: 1a3cd876-01ab-4e2e-8e4b-19584b3d6e94
  modified: 2026-10-08T13:26:58.295Z
---

Measured 2026-10-08. `node scripts/rollup-prs.mjs --apply` named #5516 + #5517 + #5518, cut its
branch from `main` at `100307571`, and waited on the three members' required checks — which is its
designed behaviour. During that wait all three merged on their own: #5516, then #5517 (`a51a3a69f`,
16:21:56 Cairo) and #5518 (`456e48a16`, 16:22:33). The roll-up opened as #5520 anyway, at 16:22.

**The documented expectation is that such a roll-up is `carried`** — byte-identical to `main`,
replacing no merges, so close it rather than pay an empty squash (`AGENTS.md` §6, and
`docs/ci-self-hosted-runner.md`, "A roll-up must be merged before its members"). **That expectation
was wrong here in the dangerous direction.** `git diff --stat origin/main refs/remotes/pr/5520`:

```
7 files changed, 16 insertions(+), 65 deletions(-)
```

Merging it would have **deleted** work already on `main` — the whole of
`.claude/cloud-context/memory-mirror/a-production-update-is-refused-in-every-tool-form.md`, its
`assignments.json` entry, the rebuilt `.claude/rules/database.md` (78 notes back to 77), and the
newer `the-hetzner-previews-run-on-staging-not-production.md` and mirrored `MEMORY.md`. The branch
carried each member by its ORIGINAL head commit from a base three commits behind, so against the
current `main` it reads as a revert of the very PRs it was built to consolidate.

**So the close-vs-merge decision is a measurement, not a category.** Fetch the head
(`git fetch origin pull/<n>/head:refs/remotes/pr/<n>`) and diff it against `origin/main`:
no diff means `carried`, so close it; a diff full of deletions means close it *urgently*, because
merging is a silent revert that CI cannot fail — every deleted file leaves the tree consistent, and
a note removed together with its `assignments.json` entry does not even orphan.

The owner had already approved "merge the roll-up when it opens" on the premise it replaced two
merges. The premise died while the branch was building; doing what he said would have undone the
work. Report the measurement and close it — the approval was for consolidation, not for that branch.

Two shell traps that hid the evidence at first, both MSYS path mangling: `git rev-parse "<sha>:<path>"`
and `git cat-file -e "<ref>:<path>"` turn the colon form into a backslash path and fail or mis-answer,
so a per-file "is it identical on main?" loop reported all six mirror files as DIFFERING when
`git diff <sha> origin/main -- <paths>` showed them identical. Use `git diff` with `--` paths, or
`git ls-tree`, never a quoted `ref:path` here. Related: [[tz-africa-cairo-silently-returns-utc-in-msys]].
