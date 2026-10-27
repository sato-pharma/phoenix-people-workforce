---
name: windows-dev-server-turbopack-switch
description: "Windows pnpm run dev now uses Turbopack (not webpack) — PR #1435 MERGED; live-data manual verification done, no crashes, but cold compiles are very slow"
metadata: 
  node_type: memory
  type: project
  originSessionId: d511a1ba-4406-4c25-89f7-9c603b7590f3
  modified: 2026-10-01T00:00:00.000Z
---

**Status: PR #1435 confirmed MERGED 2026-07-28T18:45:07Z** (re-verified 2026-07-29 via `gh pr view`). This session also independently confirmed cold-Turbopack-compile behavior (20-56s, "looks hung, isn't") while testing an unrelated change on 2026-07-29.

`pnpm run dev` on Windows now runs `next dev --turbopack` unconditionally (package.json), same as
macOS/Linux. [PR #1435](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1435), branch
`claude/dazzling-gauss-be8ed5`, committed `e7c5d43c`.

**Why:** a report of `pnpm run dev` 500ing on every Windows route (webpack failing to resolve
`next/constants` inside `@sentry/nextjs`'s edge bundle, from `instrumentation.ts`'s unconditional
`@sentry/nextjs` import) did NOT reproduce with a clean `pnpm install` — pointing to a corrupted
local `node_modules` on whichever machine hit it, not a real Next 16.2.11/`@sentry/nextjs` 10.67.0
bug. That investigation surfaced a separate, more useful fact: the win32-forces-webpack fallback
itself only existed to dodge a Turbopack chunk-loading crash on employee-portal pages under Next
**16.2.6** (added by PR #699, `a10fae9`, 2026-07-02). Current `next` is **16.2.11** (5 patches
later) — testing showed clean boots/HMR/dev-auth navigation under Turbopack, plus webpack took
2.9 minutes to compile `/employee-portals` vs. single-digit seconds under Turbopack.

**Update 2026-07-28 — live-data manual verification done:** ran `pnpm run dev` for real on this
Windows machine (not a sandbox), authenticated via `/api/dev-auth` with real Supabase egress, and
loaded several routes including `/admin/dev-preview` and `/employee-portals/training-manager`.
No crashes, no chunk-loading errors — the PR #699/#1435 failure class does not reproduce. One real
finding: **first-visit ("cold") compiles under Turbopack are very slow** — individual routes took
21–56 seconds on first hit in the dev server log (`GET /employee-portals/training-manager 200 in
56s`, `GET /admin 200 in 10.9s`, etc.), dropping to ~1–1.5s on the second hit once cached. During
that cold window the browser sits on the `app/(admin)/loading.tsx` "Loading workspace" fallback
long enough to look hung — not a bug, just Turbopack's dev-mode lazy per-route compilation, but
worth knowing before assuming a stuck loading screen means something crashed.

Also confirmed while doing this: a report of "admin/dev-preview 404" did NOT reproduce as a code
bug. `app/(admin)/admin/dev-preview/page.tsx` calls `notFound()` whenever
`process.env.NODE_ENV === "production"`, and the Dockerfile's **runner stage** (`FROM base AS
runner`) sets `ENV NODE_ENV=production` unconditionally — so the page 404s **by design** on both
staging and production (its own nav description literally says "Local development only — not
available in this environment"). Loading it locally as Super Admin returned a clean 200. If this
404 is reported again, first ask which environment it was seen on before treating it as a bug.

**Cite that Dockerfile fact by STAGE and DIRECTIVE, never by line number.** This memory used to
say `Dockerfile:81` and the legacy space form `ENV NODE_ENV production`, and by 2026-10-01 both
had moved: the directive sits at line 83, and the five legacy `ENV key value` lines were converted
to `key=value` in the Railway audit because the space form warns on every production build. The
stage name and the directive survive that churn; a line number does not. Re-verified 2026-10-01
against `origin/main` and a feature branch.

**Cookie-precedence gotcha hit while testing this:** `resolveAccessContext`/
`resolveAccessContextFromPage` (`src/lib/auth/server.ts`) check the real app session cookie
(`phoenixSessionCookieName`) BEFORE the dev-preview cookie — so if a browser profile already has a
valid real session (e.g. left over from earlier testing), hitting `/api/dev-auth?role=X` silently
sets a dev-preview cookie that gets ignored until the real session expires or is cleared. Also:
`/api/auth/logout` only accepts a non-GET method — navigating to it directly returns 405 and does
NOT clear the session; it must be invoked the way the UI does (a real form/fetch call), not by
typing the URL into the address bar.

**Caveat — not fully proven:** testing before 2026-07-28 ran in a sandbox with no live Supabase
egress; that gap is now closed (see update above). Still unverified: the exact original crash
scenario (#699) under real multi-page employee-portal click-through with a human clicking rather
than direct URL navigation.

**How to apply:** if a future session hits a Turbopack crash on Windows again, this is the THIRD
occurrence of this exact class of bug (after #499 and #699) — don't re-litigate from scratch,
just revert: set `"dev"` back to `next dev --webpack`, or tell the user to run
`pnpm run dev:no-turbopack` (kept as an explicit escape hatch, unaffected by this change). Don't
assume a Windows dev-server error is a real code bug before ruling out a corrupted local
`node_modules` first (`rm -rf node_modules .next && pnpm install`) — that was the actual cause
here, not a Next/Sentry incompatibility.
