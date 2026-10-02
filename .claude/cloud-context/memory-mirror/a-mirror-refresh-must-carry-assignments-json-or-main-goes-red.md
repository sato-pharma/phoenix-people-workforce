---
name: a-mirror-refresh-must-carry-assignments-json-or-main-goes-red
description: "A cloud-mirror refresh PR must stage `scripts/module-memory/assignments.json` together with `.claude/cloud-context/**` — a new mirror note that no module claims is an ORPHAN, and `build.mjs --check` fails the required `validate` job, which turned main RED on three consecutive commits and made Railway WITHHOLD three production deploys (2026-10-02). `sync-cloud-context.mjs` already files the notes for you; the failure is staging only the cloud-context paths and leaving its assignments.json edit behind."
metadata:
  node_type: memory
  type: project
  originSessionId: 60e0f2be-a803-444e-bf13-8a9f6b62c24c
  modified: 2026-10-02T20:38:04.942Z
---

**Staging a mirror refresh by path is what breaks it.** `node scripts/sync-cloud-context.mjs` mirrors
the laptop notes AND runs `build.mjs --file-new`, which files every new note in
`scripts/module-memory/assignments.json`. A commit that stages `.claude/cloud-context` alone ships the
new note files without their assignments entry — and `build.mjs --check`, inside the required
`validate` job, refuses an orphan note.

**Measured 2026-10-02.** PR #5182's mirror refresh carried four new notes and no assignments change.
`main` then failed CI on three commits in a row (`8b2921549`, `3c83db4e9`, `be32d06dc`), and because
Railway's "Wait for CI" holds a deploy while the pushed commit's suite is red, all three merges were
WITHHELD — `verify-shipped.mjs` printed `WITHHELD … never succeeded and NOT in the serving code`. The
cure was one commit filing the four slugs (`a-merge-approval-naming-only-a-number-reaches-every-session`
→ sessions; `choosing-test-suites-by-grepping-your-symbols-misses-the-source-pinning-ones`,
`remote-check-background-exit-code-is-not-the-check-verdict`,
`heredoc-eats-backslashes-and-makes-a-test-that-only-passes` → engineering), after which the next green
merge carried the withheld ones forward. **Never `railway redeploy` or re-merge to recover a withheld
deploy** — that rule held here exactly as written.

**How to apply:** when a PR touches `.claude/cloud-context/memory-mirror/`, stage
`scripts/module-memory/assignments.json` in the same commit, and prove it with
`node scripts/module-memory/build.mjs --check` (it must print `module memory: healthy`) before pushing.
🔴 **A local `--check` can pass while CI fails if your checkout is behind** — the orphan test reads the
repo mirror, so re-run it on a worktree cut from current `origin/main`. Related:
[[a-red-main-ci-makes-railway-skip-the-deploy-for-good]].
