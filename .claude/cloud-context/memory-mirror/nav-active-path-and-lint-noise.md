---
name: nav-active-path-and-lint-noise
description: "Sidebar nav logic is in src/lib/navigation/active-path.ts (data-driven); `npm run lint` is noisy from .codex-worktrees."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7a4fd344-9e8e-4a7f-8f44-4e6f52c8d8df
---

**Nav logic:** sidebar visibility + active-route matching are pure functions in
`src/lib/navigation/active-path.ts` (React-free, unit-tested in
`tests/navigation-active-path.test.ts`). Active-route matching is data-driven: nav
items in `src/config/system-navigation.ts` carry optional `exact?: boolean` and
`activeTab?: string` instead of hardcoded route literals. To change highlighting,
edit the nav item, not the matcher.

**Lint gotcha:** `npm run lint` scans the untracked `.codex-worktrees/` (stale repo
copies), reporting ~3000 problems / ~165 errors that are NOT in the real tree. To lint
the actual project use `npx eslint app src tests scripts` (clean: 0 errors, a few
pre-existing warnings). `.codex-worktrees/` is local-only and not committed.

**Brand assets:** `npm run optimize:brand-assets` (sharp) downscales the admin sidebar
PNGs in place — already applied (1.97MB → 55KB). Re-run if the source art is replaced.

Related: [[admin-route-group-shell]], [[windows-defender-dev-exclusions]].
