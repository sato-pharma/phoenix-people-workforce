---
name: pr-89-run-skill-rides-the-next-code-pr
description: "PR 89 (run skill on the spare laptop, branch codex/run-skill-spare) is parked — the next session opening a code PR merges that branch into its own and closes 89 after its merge"
metadata:
  node_type: memory
  type: project
  originSessionId: 931aca9f-b23a-456e-9009-f5d22098671b
  modified: 2026-11-07T01:15:31.274Z
---

PR 89 (`codex/run-skill-spare`, worktree `_wt-run-skill-spare`) changes only `.claude/` — the run skill
now drives the spare laptop's dev server through `on-spare.ps1`, and `driver.mjs` gained `--timeout`.
CI green on c309de2b7268175ad2d5ed76d86abd73f0c696e0; head now 7d46b5ab6 (login screenshot verified) (2026-11-07). Owner, 2026-11-07: "fold PR 89 into
the next code PR".

**Why:** a PR touching only `docs/`/`.claude/` is never put to him on its own (AGENTS.md §6, small is
measured in paths).

**How to apply:** the next session that opens a CODE PR runs `git fetch origin codex/run-skill-spare`
then `git merge FETCH_HEAD` on its branch (a `.claude/cloud-context` conflict: take main's side and
re-run `node scripts/sync-cloud-context.mjs`), names PR 89 in its body, and closes 89 once that PR
merges; then delete this note. Related: [[hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces]].
