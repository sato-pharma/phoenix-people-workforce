---
name: bare-worktree-cannot-push-pre-push-gate-needs-node-modules
description: "SUPERSEDED 2026-08-24: the pre-push gate is DISABLED (renamed pre-push.bak-20260730), so a bare `git worktree add` checkout pushes fine. What a bare worktree still cannot do is RUN anything — and the junction that fixes that is safe only if you never `pnpm run` in it."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8031b3ca-9a44-46e9-aef8-a95699827cf6
  modified: 2026-08-23T21:24:43.776Z
---

**The push half of this is DEAD. Verified live 2026-08-24.** `git config core.hooksPath` is
`.git/hooks`, and that folder holds only `pre-push.bak-20260730` and `pre-push.sample` — **there is
no active `pre-push` file**, so nothing runs on push at all. A worktree made by plain
`git worktree add`, with no `node_modules` and no install, pushed
`codex/marketing-reuse-picker-comment` cleanly with zero gate output. Do not budget an install just
to push, and do not repeat the old advice as if it still bound.

**What a bare worktree still cannot do is RUN.** No `node_modules` means every test invocation dies
at the first real dependency: `ERR_MODULE_NOT_FOUND: Cannot find package '@supabase/supabase-js'`.

**The junction works, and the danger is narrower than this file used to say.** Make it with
`New-Item -ItemType Junction -Path <worktree>/node_modules -Target <primary>/node_modules`, invoke
`node` DIRECTLY (the `--experimental-strip-types` + `tests/alias-loader.mjs` line), then unlink it.

The killer is **`pnpm run`, not the junction** — see
[[pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved]]: pnpm purges `node_modules` when it
thinks the lockfile moved, and through a junction that purge lands on the PRIMARY checkout. So never
`pnpm` anything inside a junctioned worktree; `node` on its own touches nothing.

**Unlink with `cmd /c rmdir <path>`, never `Remove-Item -Recurse`** — plain `rmdir` removes the
junction only, and `Remove-Item -Recurse` can walk into the target. Confirmed after the run above:
the primary's `node_modules` still held its 54 entries.

**How to apply:** a bare worktree is now the right default for anything that ends in a commit and a
push — a comment fix, a doc change, a test-only change — because CI is the gate anyway (AGENTS.md
§7). Reach for the junction only when you must run a suite locally, which you DO owe for the
break-the-fix proof, and drop it again the moment the run is done. Related:
[[gitignored-wt-scratch-makes-a-worktree-look-clean]] ·
[[repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm]] ·
[[dont-skip-validation-for-ram-wait-instead]] · [[heredoc-eats-backslashes-and-makes-a-test-that-only-passes]].
