---
name: worktree-junction-breaks-turbopack
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: in a junctioned worktree, reach straight for `--webpack` ... the junction is the pattern AGENTS.md prescribes (safe only if you never `pnpm run` in it) (see `turbopack-cannot-resolve-a-junctioned-node-modules-here`, `bare-worktree-cannot-push-pre-push-gate-needs-node-modules`). Older text follows: A node_modules junction into another tree lets tsc/eslint/test pass but FAILS `npm run build` (Turbopack); do a real npm ci per worktree."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4cbbcbdf-7abe-4293-9dfc-a49bf94e3069
---

When spinning up a fresh `git worktree` for isolated work, a Windows directory **junction** for `node_modules` pointing at another tree's modules (instant, saves an install) works for `tsc`, `eslint`, and `npm run test` — but **`npm run build` fails** with `TurbopackInternalError: Symlink [project]/node_modules is invalid, it points out of the filesystem root`.

**Why:** Turbopack/Next reject a node_modules that resolves outside the project root.

**How to apply:** for any worktree that must run the production build, do a real `npm ci` in it (not a junction). Remove a junction safely with `cmd //c rmdir <path>` (link-only; NEVER `Remove-Item -Recurse`, which would delete the target tree's real modules). Also: never `npm install` *through* a junction — it writes into the target tree and can disrupt the other session. See [[main-sync-and-wt-main]], [[parallel-session-swarm-hazard]].
