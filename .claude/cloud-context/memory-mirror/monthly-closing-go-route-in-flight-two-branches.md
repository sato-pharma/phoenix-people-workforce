---
name: monthly-closing-go-route-in-flight-two-branches
description: "The monthly-closing \"go\" redirect route (the closing-published email deep link) is SHIPPED and on main at app/api/sales/monthly-closing/go — the \"live/uncommitted, split across two unmerged branches\" state is resolved. DURABLE: one feature split across two branches is invisible to any single-branch check, which is the hazard this file records."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8175c9e3-9303-4136-95f3-f695f7267c28
  modified: 2026-08-08T10:19:15.217Z
---

As of 2026-08-08 ~13:15 Cairo, `app/api/sales/monthly-closing/go/route.ts` (redirect dispatcher for
the "Open Phoenix Workforce" link in the closing-published email — routes each recipient role to its
own correct landing page: admin Matrix, portal tab, or `resolveLandingPathForRole` fallback) exists
in two places, neither merged:

1. **Primary checkout** (`F:\Phoenix Workforce\phoenix-workforce`), branch
   `codex/email-recipient-assurance-guard` — untracked, alongside 4 related new untracked modules
   (`closing-publish-notification.ts`, `closing-publish-recipients.ts`, `closing-store-split-net.ts`,
   `monthly-closing-with-store-split.ts`) plus 22 modified files. This is the **complete** version.
2. **PR #1887** (`codex/closing-publish-email`, worktree `_wt-closing-publish-email`) — committed,
   route file only (byte-identical to #1's), no sibling modules.

Neither branch's `src/lib/security/access-registry.ts` has an entry for this route yet, so
`tests/access-registry-coverage.test.ts` currently fails there with `unregistered`, not
`missingPermissionGuard` — a different assertion than any single-worktree fix would expect.

**Why:** A task described this file as sitting untracked in a *third* worktree with "no permission
enforcement, add assertPermission" — it didn't exist there at all. Tracing it required
`git worktree list` + existence checks across all ~40 registered worktrees, and `git log --all` to
confirm it was never committed on any branch reachable from that worktree. Fabricating a standalone
fix there would have diverged from the real in-progress feature (missing the 4 sibling modules) and
scattered the same logical change across a third branch. Separately: this route is a role-based
redirect dispatcher used by **every** recipient role including non-sales roles (CEO, Marketing
Manager, PM/GPM) — copying a sibling route's `assertPermission(ctx, "sales", "import"/"export")`
verbatim (as the task instructed) would lock those roles out of a link designed to work for everyone.

**How to apply:** Before adding the access-registry guard, check whether
`codex/email-recipient-assurance-guard` or PR #1887 has already landed — the fix belongs wherever the
real feature ships, not as a standalone recreation elsewhere. When it is guarded, don't copy
`assertPermission(ctx, "sales", ...)` from `monthly-closing/route.ts` or `.../export/route.ts` — the
guard must let every authenticated role through and only reject the unauthenticated case (it already
redirects unauthenticated access to `/login`), so it likely wants a `canAccess`-style check or a
registry entry classified with `guard: "domain-helper"`, not a single resource/action assertion.

## 2026-09-04 — landed; the split-branch hazard is the part that lasts

The route exists on `main` at `app/api/sales/monthly-closing/go`, so the in-flight state is over.

**Keep the hazard.** A feature split across two unmerged branches is invisible to any check that
looks at one branch: each half reads as incomplete work, and neither branch shows the feature. It
sits alongside the related traps that a squash-merged branch reads as "on no origin ref", and
that an empty `git log <branch> --not --remotes=origin` is not proof a branch is safe to delete.
