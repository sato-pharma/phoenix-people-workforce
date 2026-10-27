---
name: a-rescue-branchs-real-size-is-measured-after-merging-main-in
description: "A never-pushed rescue branch's own diff overstates it wildly — 49 files and 4,959 insertions became 12 files and 332 after merging origin/main in, because `main` had shipped the same work minutes earlier. Measure a rescue pile with `git diff --stat origin/main...HEAD` AFTER the merge, and compare line counts per file against the shipped module before arguing anything is unshipped."
metadata:
  node_type: memory
  type: project
  originSessionId: c6c5b9e1-3dc9-4ddb-bddb-2f58c01d2ce3
  modified: 2026-10-12T19:57:31.647Z
---

🔴 **A rescued WIP branch's own `--stat` is not its size. Merge `origin/main` in first, then
measure — the number usually collapses, and what survives can still be the discarded design.**

**Measured 2026-10-12, 19:5x Cairo**, on `rescue/phoenix-mcp-source-pipeline-wip` (PR
[#5807](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/5807)). Six commits that had
lived only on the laptop, never pushed, no PR. Its own diff read **49 files, 4,959 insertions** —
which sounds like a fortnight of lost work.

- `main`'s last commit touching the folder was **`f877aaacf` (#5748), 17:43:41** — **one minute
  before** the branch's final WIP commit at 17:44:36. Same work, two paths.
- Merging `origin/main` in, resolving all **17** conflicting paths to `main`'s copy, left
  `git diff --stat origin/main...HEAD` = **12 files, 332 insertions**. That is the honest size.
- The conflict itself was the signal, not an obstacle: a `CONFLICTING` rescue branch against a
  folder `main` touched the same hour means the branch is probably the **earlier draft**, not the
  newer work.

**Then check the survivors against the shipped module, file by file, by line count.** The 332
insertions were not new work either: `source/proof.mts` 31 lines against the shipped
`src/lib/mcp-source/source-proof.ts` 233, `source/authorization.mts` 41 against
`live-authorization.ts` 195. A separate Express host on a port, where `main` had shipped in-app
route modules — the **architecture that lost**. Two type errors against the shipped contracts and a
`new Worker('./source-worker.mjs')` whose filename **has never existed in any commit on any
branch** confirmed it rather than being bugs worth fixing.

**How to apply.** For any `rescue/*` or never-pushed WIP branch: push it (so it is off one disk),
archive its pre-merge tip as `refs/backups/<branch>-premerge-<date>`, merge `origin/main` in, and
report the post-merge `--stat` as the size. Do not patch a superseded draft to green — that is
re-doing the shipped PR on the design that was abandoned. Say what is superseded and let the owner
decide to close or keep the record.

Related: [[verify-the-emitted-artifact-never-the-source]],
[[a-reused-branch-name-finds-the-old-merged-pr]],
[[a-squash-merge-makes-a-stacked-branch-rebuild-not-merge]].
