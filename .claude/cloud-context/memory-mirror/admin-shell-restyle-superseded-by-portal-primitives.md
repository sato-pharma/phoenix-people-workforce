---
name: admin-shell-restyle-superseded-by-portal-primitives
description: "The uncommitted _wt-admin-shell-restyle diff (employee-management.tsx bespoke mobile/table restyle) should NOT be resurrected — main already solved the same need with a different, broadly-adopted shared pattern"
metadata: 
  node_type: memory
  type: project
  originSessionId: ca3ff325-bc00-4df1-b856-df76870bf385
  modified: 2026-07-25T17:46:24.514Z
---

`_wt-admin-shell-restyle` (branch `codex/admin-shell-restyle`) has real uncommitted work: a
`.phx-restyled` opt-out class in `app/globals.css`, a flattened `adminHeroSurfaceClassName`
gradient in `admin-design-tokens.ts`, and a full bespoke restyle of Employee Master Data
(`employee-management.tsx`) with its own hand-built mobile card view + desktop table.

**Do not cherry-pick or resurrect the `employee-management.tsx` part.** Attempted this
2026-07-25 (owner-approved plan, "land orphaned worktrees as fresh PRs") and aborted after
discovering: `main` has since independently added mobile support to this exact page using
`PortalRecordCard`/`PortalDesktopTable`/`PortalRecordFields`/`PortalEmptyState`
(`src/components/employee-portal/portal-primitives.tsx`) — a shared pattern now used across
**33 files** (recruitment, coaching, marketing, employee-portal dashboards, etc.). The
uncommitted branch's bespoke approach doesn't use these primitives at all. Forcing it in
would revert this one page off the established, broadly-adopted pattern — a real
regression, not a merge nuisance. A `git apply --3way` surfaces this immediately as an
unresolvable structural conflict (not a simple line-shift) between the two approaches at
every major section of the file.

**Why:** the original Explore-agent review that judged this diff "genuinely complete and
valuable" (2026-07-25) assessed it in isolation, without cross-checking whether `main` had
already solved the same underlying need differently in the interim (86-107 commits of
drift). That gap is exactly what a real patch-application attempt surfaces and a diff-only
review cannot.

**What happened to the other 2 files:** `globals.css`'s `.phx-restyled` mechanism and the
`admin-design-tokens.ts` gradient tweak both apply cleanly with no conflict — but neither is
meaningful in isolation (the CSS opt-out class would have zero components using it once
`employee-management.tsx` is dropped; the shared gradient token is a real design decision
affecting every admin page's hero header, not something to apply silently as a side effect
of salvaging an abandoned diff). Reset both back to clean rather than partially land them.

**How to apply:** if the owner wants Employee Master Data's mobile view changed/improved
further, the right starting point is extending the EXISTING `PortalRecordCard`-based
implementation already on `main`, not reviving this branch. The `_wt-admin-shell-restyle`
worktree itself was left untouched (its uncommitted diff still sits there) — safe to clean
up/remove whenever, since none of it should be landed as-is.

Related: [[parallel-work-model-2026-07]].
