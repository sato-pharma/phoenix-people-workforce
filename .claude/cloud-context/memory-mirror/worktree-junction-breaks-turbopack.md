---
name: worktree-junction-breaks-turbopack
description: "A node_modules junction into the primary (the worktree pattern AGENTS.md prescribes) works for node/tsc/eslint/tests but Turbopack rejects it (\"Symlink [project]/node_modules is invalid\") — keep the junction, run the dev server with --webpack (node scripts/dev-server.mjs), leave the production build to CI or node scripts/remote-check.mjs build, and NEVER npm ci / pnpm install inside a worktree."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4cbbcbdf-7abe-4293-9dfc-a49bf94e3069
  modified: 2026-10-02T16:40:29.849Z
---

When spinning up a fresh `git worktree` for isolated work, a Windows directory **junction** for `node_modules` pointing at another tree's modules (instant, saves an install) works for `tsc`, `eslint`, and `npm run test` — but **`npm run build` fails** with `TurbopackInternalError: Symlink [project]/node_modules is invalid, it points out of the filesystem root`.

**Why:** Turbopack/Next reject a node_modules that resolves outside the project root.

**How to apply:** keep the junction — it is the pattern AGENTS.md §5 prescribes (`node scripts/new-session.mjs <task>` creates it), and it is safe as long as you never `pnpm install`/`pnpm run`/`pnpm exec` (or `npm ci`) inside the worktree, which purges the PRIMARY's `node_modules` through it. For a dev server in a junctioned worktree, reach straight for `--webpack` (`node scripts/dev-server.mjs --port 3000` runs webpack on Windows) — webpack's resolver accepts the junction where Turbopack's does not ([[turbopack-cannot-resolve-a-junctioned-node-modules-here]]). The production build is CI's job; if you need one before a PR, `node scripts/remote-check.mjs build` runs it on the CI box. Invoke `node` directly for anything else ([[bare-worktree-cannot-push-pre-push-gate-needs-node-modules]]).
**Superseded 2026-10-02:** previously "for any worktree that must run the production build, do a real `npm ci` in it (not a junction)" — the 2026-08-29 `--webpack` correction and AGENTS.md §5 (junction + `node` invoked directly, never an install inside a worktree) replaced it.

Remove a junction safely with `cmd //c rmdir <path>` (link-only; NEVER `Remove-Item -Recurse`, which would delete the target tree's real modules). Also: never `npm install` *through* a junction — it writes into the target tree and can disrupt the other session. See [[main-sync-and-wt-main]], [[parallel-session-swarm-hazard]].
