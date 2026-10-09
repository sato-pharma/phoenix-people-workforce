---
name: a-role-sweep-runs-without-a-dev-server
description: "An API role sweep needs NO dev server — import the real route handlers under the test loader and call GET/POST with the x-phoenix-* dev-auth headers plus host localhost; 115 people x 5 ROI/Coverage routes ran in one ~150 MB node process at the 1.8 GB freeze line (2026-10-09). It cannot see page shells or sidebar reach, and never call an export route (it writes an audit row in that person's name)."
metadata:
  node_type: memory
  type: feedback
  originSessionId: fa0248ab-fe20-4436-83e9-0e1783314a87
  modified: 2026-10-09T01:11:50.952Z
---

When free RAM sits at the ~1.8 GB freeze line, a webpack dev server (~4 GB) is off the table, but
an API role sweep still runs: `resolveAccessContext(request)` in `src/lib/auth/server.ts` reads the
dev-auth headers off the `Request` object itself (no `next/headers`), so a route handler called
directly in plain Node takes the exact path the dev server would.

How (2026-10-09, ROI Tracker + Coverage Report sweep, 115 people, 0 failures, 1,326 s, ~150 MB):
- From the repo root: `node --env-file=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs <script.mjs>` (the loader's projectRoot is the cwd; it stubs `next/cache`).
- In the script set `process.env.NODE_ENV = "development"` and `PHOENIX_ENABLE_DEV_AUTH_HEADERS = "true"` BEFORE importing the routes.
- Build `new Request("http://localhost:3000/api/...", { headers: { host: "localhost:3000", "x-forwarded-host": "localhost:3000", "x-phoenix-role": role, "x-phoenix-hr-id": hrId } })`; dynamic segments go in as `{ params: Promise.resolve({ id }) }`.
- People come from `app_auth_users` (active, `is_test_persona` false) joined to `employees.full_name` (there is no `employees.name` — 42703).
- Assert invariants, not counts: every row a report lists must open its drill-down (200), a request outside the viewer's set must be refused (403).

**Why:** the owner asked for the sweep while the box was at its freeze line; starting a server would have risked every open session.

**How to apply:** use it for API-level role checks whenever RAM is tight. It does NOT prove page reach (server components, the shell bounce, the sidebar) — say so, and do that half on a dev server or the preview box when RAM allows. Skip export routes: `writeMarketingRoiExportAudit` and its kin record an export the person never made. `.env.local` is PRODUCTION, so only call read routes. Related: [[dev-auth-is-header-only-browser-pane-cannot-use-it]], [[laptop-thrashing-pagefile-feedback-loop]].
