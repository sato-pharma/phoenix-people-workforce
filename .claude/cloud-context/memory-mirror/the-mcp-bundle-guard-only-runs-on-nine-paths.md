---
name: the-mcp-bundle-guard-only-runs-on-nine-paths
description: "phoenix-mcp.yml's \"no administrative Phoenix IO survived bundling\" assertion triggers on only 9 paths while the bundle's import graph reaches email, notifications and sales — so a breach sits green on main until someone touches one of the nine; reproduce it in 7 s locally and grep dist/main.mjs, which is written before the throw."
metadata:
  node_type: memory
  type: project
  originSessionId: f1479c36-700b-425f-a493-804d277da62c
  modified: 2026-10-23T09:06:41.677Z
---

`.github/workflows/phoenix-mcp.yml` runs the MCP bundle's security assertion — *"Administrative
Phoenix IO survived bundling"*, `infra/phoenix-mcp/build.mjs:39` — on a **pull_request touching one
of nine paths**: `infra/phoenix-mcp/**`, `src/lib/mcp-source/**`, `app/api/mcp-source/**`, the
workflow, `permissions.ts`, `session-lifecycle.ts`, `employees/employee-directory.ts`,
`reports/organogram.ts`, `sales/monthly-closing-portal.ts`. **It does not run on push to `main`.**

🔴 **The bundle's real import graph is far wider than those nine paths** — it reaches
`src/lib/email/*`, `src/lib/notifications/*` and more. So a change *outside* the filter can break
the assertion, nothing turns red, and the breach sits on `main` until the next PR that happens to
touch one of the nine — which then looks like that PR's fault. It happened on 2026-10-23: #6336
(the action-inbox name roster) went red on `mcp-security`, and swapping `origin/main`'s own versions
of both changed files in reproduced the same red, proving it pre-existing.

**Reproduce it locally in about 7 seconds** — no CI, no guessing:

```bash
cd infra/phoenix-mcp && npm ci --no-audit --no-fund && node build.mjs --tests
```

`npm ci` there is safe in a worktree (its own `package-lock.json`, its own `node_modules`, both
gitignored) and is **not** the banned `pnpm`. The build **writes `dist/main.mjs` before it throws**,
so the artifact is there to read:

```bash
grep -n "serviceRoleKey\|/rest/v1/\|getRequiredEnv(\"SUPABASE\|supabase\.co" dist/main.mjs
```

Then work backwards: find which bundled symbol still references the surviving function, and which
`init_<module>` wrapper contains it — the `__esm` wrapper names carry the real source path.

**Why the deny plugin does not save you.** `build.mjs` replaces `@/lib/supabase/server`,
`@/lib/supabase-rest` and `@/lib/observability/log` with throwing stubs **by module name** — but
`employee-directory.ts` has its **own private `supabaseRest`** (there is no shared one; five files
in `src/lib/` each carry a copy), so no stub can reach it. Only **tree-shaking** keeps it out of the
bundle, which means any new reference chain to it is a live hazard.

**The 2026-10-23 cause, for the pattern:** `src/lib/email/recipient-assurance.ts:238` runs
`const productionAssuranceDirectoryReader = createAssuranceDirectoryReader();` at **module level**.
That top-level call retains the default parameter `loadAssuranceDirectoryFresh` →
`getEmployeeDirectoryRows` → the directory's private `supabaseRest`, which holds both `/rest/v1/`
and `getRequiredEnv("SUPABASE")`. It arrived with #6297, which touched none of the nine paths.
**A top-level call in a module the MCP can reach is the shape to look for.**

`mcp-security` is **not** one of `main`'s required checks (those are `validate` and `checks`), so it
never blocks a merge — which is exactly why a red one can be ignored into permanence.
