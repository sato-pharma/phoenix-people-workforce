---
name: gh-pr-list-timestamp-is-createdat-not-mergedat
description: "gh pr list's trailing timestamp column is createdAt, not mergedAt, even when the state column reads MERGED — use gh pr view --json mergedAt for the real merge time"
metadata: 
  node_type: memory
  type: reference
  originSessionId: f5dded91-eb5b-4a38-8d93-ac802a0210c0
  modified: 2026-08-05T13:24:13.548Z
---

`gh pr list --head <branch> --state all` prints a row like `1783  <title>  <branch>  MERGED
2026-08-05T13:08:47Z`. That trailing timestamp reads like "when it merged." It is not.

Verified 2026-08-05 on PR #1783: `gh pr view 1783 --json createdAt,mergedAt,updatedAt,closedAt`
returned `createdAt=13:08:47Z`, `mergedAt=13:17:54Z`, `updatedAt=13:17:56Z`. The list column is
**createdAt** — 9 minutes before the PR actually merged.

**Why:** investigations here lean on precise merge-order timelines ("did fix X land before or
after failing run Y" — same shape as
[[two-sessions-fixed-one-bug-main-was-never-ci-validated]]). Trusting the list column instead of
the real merge time can flip that causality conclusion outright, especially when a PR sat open for
review/CI before merging.

**How to apply:** for any timeline-sensitive question, pull the specific field —
`gh pr view <n> --json mergedAt -q .mergedAt` — never read merge time off `gh pr list`'s table.
