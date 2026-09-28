---
name: local-browser-verify-gotchas
description: "How to browser-verify pages locally in this repo. SAFETY: local .env.local targets PRODUCTION Supabase — page loads are read-only-safe, never click a write action. The in-app Browser pane frequently can't finalize React streaming Suspense/effects (it reports document.hidden even with focus, which suppresses rAF); the escape hatch for all of it is PLAYWRIGHT (already a repo dep). Also: preview_start always binds to the PRIMARY worktree, raw-RSC-fetch grep gives false positives for conditionally-rendered UI, and access-scope.ts drags puppeteer into the dev client bundle."
metadata:
  node_type: memory
  type: reference
  originSessionId: 77d1b67e-6071-4e33-b292-07ab1e57d207
  modified: 2026-09-26T05:36:02.101Z
---

Verifying portal/admin pages locally (the in-app Browser pane, or `pnpm run dev` + dev-auth).

## Safety and auth

🔴 **Local `.env.local` targets PRODUCTION Supabase (`ozucdzovmcqvepbozvqf`) — a local dev server
reads/writes PRODUCTION data.** dev-auth (`GET /api/dev-auth?role=<Role>&hrId=<seat>&next=<path>`,
`NODE_ENV=development` only) just sets a session cookie — page LOADS are read-only-safe, but any WRITE
(approve/return/reject, submit, save) hits prod. **Keep verification strictly read-only**; confirm rendering,
honest empty states, and expand client-only inputs, but NEVER click Approve/Confirm/Submit against the
prod-pointing dev server ([[one-prod-deploy-per-task]]). dev-auth needs NO request headers for page
verification — `PHOENIX_ENABLE_DEV_AUTH_HEADERS` matters only for header-driven role sweeps.

⚠️ **The dev-auth session can be force-logged-out mid-verification by `SessionSecurityGuard`'s heartbeat** — a
dev-preview cookie is not a real `app_auth_users` session, so during a slow first-compile (7–13s in a fresh
worktree) the client `POST /api/auth/heartbeat` fires, the app treats the cookie as invalid, and auto-logs
out to `/login?reason=session-timeout`. **Fix:** re-hit `/api/dev-auth` immediately before navigating, and
verify against WARM (already-compiled) routes — visit once to compile, then re-auth + revisit for the real
pass.

## Running the server (worktrees)

🔴 **`preview_start({name})` ALWAYS binds to the PRIMARY worktree, ignoring Bash `cd`** — a worktree-only
change never shows up through it. Diagnostic: `netstat -ano | grep :<port>` for the LISTENING pid, then check
that process's `CommandLine` (`Get-CimInstance Win32_Process`) — if it's rooted in the primary, that's why.
Two ways to verify a worktree change: apply the same edit uncommitted to the primary, verify, `git checkout
--`; OR start the server yourself in the worktree — `cd <worktree> && PORT=3007 pnpm run dev &` (background
Bash) — then `preview_start({url:"http://localhost:3007"})` just attaches the pane tab to it. Worktree setup:
`node scripts/sync-worktree-env.mjs` copies the gitignored `.env*` (without it dev-auth 500s), then a real
`pnpm install` (~24s; a junction to primary's `node_modules` is the WRONG shortcut —
[[worktree-junction-breaks-turbopack]]). Port 3000 is often held by a parallel session — netstat-check, else
use 3007. `preview_start({name})` can also fail with "cwd must be a relative path" unrelated to any of this —
use `preview_start({url:...})` after starting `pnpm run dev` yourself.

## The Browser pane frequently can't finalize React streaming/effects

🔴 **The headless preview tab reports `document.hidden === true` even while focused**, which per spec
suppresses `requestAnimationFrame` — so React's client reveal-swap for a streamed `<Suspense>` boundary
(`$RC`) AND post-hydration `useEffect` can get stuck showing `loading.tsx` forever. Symptoms: `.animate-pulse`
skeletons persist, `div[hidden]` count stays >0, a resolved `<h2>` has `offsetParent===null`/height 0, or a
data-driven page never fires its fetch. It is **inconsistent, not universal** — retry a plain fresh
`window.location.href` navigation first; monkey-patching `document.hidden`/rAF on an already-stuck page does
NOT unstick it. **Verify streamed sections by reading `element.textContent` of the hidden subtree, not
visibility/geometry/screenshots** (the preview viewport also starts 0×0 — `preview_resize` before any
geometry check, and screenshots may fail outright with "Browser pane is not displayed"). **Repeated rapid
`navigate` calls on the same tab race and restart the load** — navigate ONCE, then wait several real seconds
(or poll the dev log for the route's compile line) before touching the tab.

**`computer{left_click, ref}` can silently no-op** (success reported, no DOM change) even when the coords fall
inside the visible button — don't burn more than one retry; dispatch a native
`[...document.querySelectorAll('button')].find(b => b.textContent.trim()===X && b.getBoundingClientRect().width>0).click()`
via `javascript_tool`. That is inspection-tool-as-click for verification, not implementing UI in JS.

## Raw-fetch grep: powerful, with one sharp trap

When rendering looks stuck, `fetch(url,{credentials:'include'}).then(r=>r.text())` from `javascript_tool`
returns the server's raw RSC HTML, bypassing client rendering — definitive for what the SERVER produced.
🔴 **But it gives FALSE POSITIVES for conditionally-rendered UI:** the RSC/flight payload serializes ALL
props passed to a `"use client"` component, including a label string that is only conditionally rendered
(`cond ? <Tab label={labelString}/> : null`) — the string travels to the client regardless. For
presence/absence of a RENDERED element, trust `read_page` (post-hydration accessibility tree) or a screenshot,
not raw-text grep; reserve raw-fetch-grep for what a component RECEIVED. (RSC streaming can also split a word
across chunk boundaries, producing a false substring match in concatenated raw text.)

## access-scope.ts breaks the dev client bundle

**`src/lib/sales/access-scope.ts` transitively pulls `puppeteer-core` into the client bundle** (→
`employee-directory.ts` → `offers/service.ts` → `offer-letter-pdf.ts`, which needs Node `fs`), so any page
reachable from it fails local dev (webpack AND turbopack) with "Module not found: Can't resolve 'fs'" — a
hard overlay, page never hydrates. **Dev-mode-only** — `pnpm run build` (production) routes it fine. Workaround:
verify SERVER-side code (API routes/RPCs) via `fetch(...,{credentials:'include'})` against the routes
directly, skipping the broken page; stick to read-only/negative-path calls and confirm no mutation via an
unchanged `updated_at`.

## 🔴 The escape hatch for all of the above: drive with PLAYWRIGHT

`playwright` is already a repo dependency. A headless chromium loads stuck-Suspense pages cleanly, hydrates,
fires `useEffect`, and returns real data — strictly better proof than HTTP status or DOM text. It also does
what the pane cannot: assert real row counts, drive `SearchableSelect` (which commits on **`mousedown`**, not
`click` — a synthetic click can land after the outside-mousedown handler closed the portal), measure
`document.documentElement.scrollWidth - clientWidth` at 375px to catch horizontal overflow, and **download +
parse an XLSX** (`page.waitForEvent('download')` + `download.saveAs()`, then parse with `exceljs`) to assert
on the literal artifact the user receives. Setup: auth is just `page.goto('/api/dev-auth?role=...&next=<path>')`
(no headers); a scratchpad script must `createRequire('<repo-or-worktree>/package.json')` so
`chromium`/`exceljs` resolve from the right `node_modules`. Always `waitForFunction(rows > 0)` before
asserting ([[headless-preview-cannot-measure-data-driven-layout]]). Read-only discipline still applies —
never click Approve/Save.
