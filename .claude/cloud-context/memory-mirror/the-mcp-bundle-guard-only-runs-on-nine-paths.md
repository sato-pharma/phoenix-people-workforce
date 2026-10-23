---
name: the-mcp-bundle-guard-only-runs-on-nine-paths
description: "FIXED 23 Oct 2026 — the MCP bundle's \"no administrative Phoenix IO survived bundling\" assertion is now a step in ci.yml's `static` job, so it gates every PR and every push to main; phoenix-mcp.yml's 9 paths are still NOT the bundle's import graph, and mcp-security is still not a required check, so never read that workflow's silence as coverage. The cause pattern: a MODULE-LEVEL call retains its own default argument's chain down to a PRIVATE supabaseRest the deny plugin cannot stub. Reproduce in 7 s and grep dist/main.mjs, written before the throw."
metadata:
  node_type: memory
  type: project
  originSessionId: f1479c36-700b-425f-a493-804d277da62c
  modified: 2026-10-23T09:20:02.056Z
---

🔴 **FIXED on 2026-10-23 (branch `codex/mcp-bundle-lazy-assurance`): the assertion is now gated
repo-wide.** `ci.yml`'s `static` job runs `node build.mjs` in `infra/phoenix-mcp` (~15 s, its own
lockfile and `node_modules`), `static` carries no `paths:` filter, and the required `checks` status
`needs` it — so a PR that retains an administrative loader in the bundle now goes red and cannot
merge. Pinned by `tests/mcp-bundle-io-guard.test.ts`, which also forbids a module-level
`createAssuranceDirectoryReader()`. **Do not delete that step on the grounds that phoenix-mcp.yml
already covers it.**

**What is still true, and is the transferable half.**
`.github/workflows/phoenix-mcp.yml` runs the MCP's deeper pass — the cold typecheck, the isolated
PostgreSQL fixture, the dependency audit — on a **pull_request touching one of nine paths**:
`infra/phoenix-mcp/**`, `src/lib/mcp-source/**`, `app/api/mcp-source/**`, the workflow,
`permissions.ts`, `session-lifecycle.ts`, `employees/employee-directory.ts`,
`reports/organogram.ts`, `sales/monthly-closing-portal.ts`. **It does not run on push to `main`, and
`mcp-security` is not one of `main`'s required checks** (those are `validate` and `checks`).

🔴 **The bundle's real import graph is far wider than those nine paths** — it reaches
`src/lib/email/*`, `src/lib/notifications/*` and more. **The paths a workflow watches are a cost
decision; what its assertion covers is the import graph, and the two are never the same list.** So
before the `static` step existed, a change *outside* the filter broke the assertion, nothing turned
red, and the breach sat on `main` until the next PR that happened to touch one of the nine — which
then looked like that PR's fault. That is exactly how it was found: #6336 (the action-inbox name
roster) went red on `mcp-security`, and swapping `origin/main`'s own versions of both changed files
in reproduced the same red, proving it pre-existing.

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

🔴 **THE CAUSE PATTERN, WHICH IS THE THING TO CARRY:** `src/lib/email/recipient-assurance.ts` ran
`const productionAssuranceDirectoryReader = createAssuranceDirectoryReader();` at **module level**.
A top-level **call** is a side effect esbuild may not drop, so the statement was retained — and with
it its **default parameter** `loadAssuranceDirectoryFresh` → `getEmployeeDirectoryRows` → the
directory's private `supabaseRest`, which spells both `/rest/v1/` and `getRequiredEnv("SUPABASE")`.
It arrived with #6297, which touched none of the nine paths. The fix was to build the reader on
first use (`reader ??= createAssuranceDirectoryReader()` inside `resolveAssuranceDirectory`), which
is behaviour-identical — construction does no I/O and `??=` resolves before any await, so it is
still one per-process singleton with one last-good copy. **A module-level call in any module the MCP
can reach is the shape to look for.** See [[the-recipient-assurance-guard-fails-closed]].
