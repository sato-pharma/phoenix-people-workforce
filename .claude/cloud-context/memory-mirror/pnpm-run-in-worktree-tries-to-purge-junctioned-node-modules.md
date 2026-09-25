---
name: pnpm-run-in-worktree-tries-to-purge-junctioned-node-modules
description: "In a worktree whose node_modules is a junction to the main checkout, `pnpm run` tries to DELETE it — only the no-TTY abort saves the primary repo's dependencies."
metadata: 
  node_type: memory
  type: project
  originSessionId: d3d7ff0c-7077-426c-bc7c-4f0b250fec8d
  modified: 2026-08-12T13:02:03.110Z
---

**Never run `pnpm run <script>` in a git worktree whose `node_modules` is a junction/symlink to the
main checkout.** pnpm's dependency-status check decides the worktree needs a reinstall, and the
first thing `pnpm install` does is remove the modules directory — which is the junction, pointing
at the PRIMARY repo's real `node_modules`. Observed 2026-08-09:

```
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY
```

Only the missing TTY stopped it. **Do NOT "fix" this by setting `CI=true` or
`confirmModulesPurge=false`** — that is precisely the flag that lets the deletion proceed.

**Why it bites:** worktrees are mandatory here (AGENTS §5) and `git worktree add` never copies
`node_modules`, so junctioning it from the main checkout is the obvious cheap shortcut — a real
`pnpm install` per worktree costs ~85,000 paths. The junction works fine for `npx tsc`, `npx
eslint` and the pre-push hook (which uses `npm run`, not pnpm, so it never runs the check).

**`next build` is where the junction STOPS working** (found 2026-08-09). Turbopack refuses it:

```
FATAL: An unexpected Turbopack error occurred.
Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid, it points out of the filesystem root
```

It fails during `find_package`, before compiling anything, so it says nothing about your code — do
NOT go debugging the diff. So a junctioned worktree can run typecheck + lint + the test suite but
**cannot run the build gate locally**. Either accept CI's `build` step as that gate (ci.yml runs it
as its own step — see [[ci-does-not-run-check-harden]]) or delete the junction FIRST and do a real
`pnpm install` in the worktree. Never run `pnpm install` while the junction is still in place.

~~**A NON-junctioned worktree is safe, and the pre-push hook FORCES you to install (2026-08-12).**~~ **[CORRECTED 2026-08-27: the pre-push hook is GONE — `.git/hooks` holds only `pre-push.bak-20260730`, verified live — so NOTHING forces an install any more and a bare worktree pushes fine. What a bare worktree still cannot do is RUN a suite: junction `node_modules` from the primary and invoke `node` directly. Never `pnpm install` or `pnpm run` inside a worktree. See AGENTS.md §5.]**
`git worktree add` alone leaves no `node_modules` at all, and the pre-push hook runs
`check:migrations` + `lint` + `typecheck`. Lint dies with `'eslint' is not recognized`, and pointing
`node ../phoenix-workforce/node_modules/eslint/bin/eslint.js` at it does NOT work either —
`eslint.config.mjs` does `import ... from "eslint"`, which cannot resolve from a worktree with no
modules dir (`ERR_MODULE_NOT_FOUND`). So there is no way to satisfy the hook without installing.
**Just run `pnpm install --prefer-offline --ignore-scripts` in the worktree**: 21s, pnpm hardlinks
from the store, and the primary checkout's `node_modules` is untouched — the purge hazard above
applies ONLY when the dir is a junction. Verify after: `ls node_modules/eslint` in BOTH trees.
Do not reach for `--no-verify`; the hook caught two real defects of mine that CI would only have
found minutes later (a wrong import path, and a PostgREST `GenericStringError[]` cast).

**How to apply:** in a junctioned worktree, invoke scripts directly instead of through pnpm — for
the test suite that is the command in `package.json`'s `test` script:
`node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs tests/run-tests.ts`.
Also: a non-zero exit from `pnpm run test` may mean the suite NEVER RAN — read the actual output
before attributing the failure to an assertion. I misreported a green-but-unrun suite as
"the two failures I predicted" this way. See [[validate-once-at-done-not-per-edit]].
