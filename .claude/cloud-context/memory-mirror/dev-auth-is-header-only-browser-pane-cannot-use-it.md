---
name: dev-auth-is-header-only-browser-pane-cannot-use-it
description: "THE FILENAME IS A MISNOMER. GET /api/dev-auth?role=<Role>&hrId=<HR>&next=<path> DOES role-switch the Browser pane — navigate to it, it sets an httpOnly phoenix_dev_preview cookie (checked before the header path) and redirects, no proxy, and hrId signs you in as THAT person (the only way to verify a manager's own-team scope). Only the SEPARATE x-phoenix-* request-header path is header-only, and that is what role SWEEPS use. Dev auth can NEVER reach a deployed env and fails as a misleading role-403."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d7876385-32d4-4aa5-880a-8afbb11a769b
  modified: 2026-09-26T06:58:05.875Z
---

**The filename asserts the opposite of what this file concludes — left unrenamed deliberately** (renaming
touches the `MEMORY.md` pointer, which only the control-tower session rewrites, plus the backticked slug in
`AGENTS.md` that keeps this file reachable; a wrong name costs one confused search, a broken pointer an
invisible file). There are TWO dev-auth paths:

## The COOKIE route — works straight from the Browser pane, no proxy

`GET /api/dev-auth?role=<Role>&hrId=<HR>&next=<path>` sets an httpOnly **`phoenix_dev_preview`** cookie
(decoded by `accessContextFromDevPreviewToken`, checked BEFORE the header path) and 30x's to `next`.
Navigating the pane to it is a genuine role round-trip — the whole navigation surface changes and changes
back (verified: `?role=Super Admin` → `/admin`, `?role=Medical Rep&hrId=A-7` → `/employee-portals`, and
back). `document.cookie` never shows it (httpOnly). Rules: the role must be canonical (`parseRoleStrict`); a
portal page needs a role in `portalNavigationRoles` or it 307s to `/overview`. **`&hrId=<HR>` signs you in as
THAT person** — the only way to verify anything scoped to one manager's own team. `/admin/dev-preview` is the
Super-Admin picker doing the same via `POST /api/dev-auth/preview`. This is the cheapest verification route;
the cheapest structural check of all is curl:

```
curl -s -c jar.txt "http://localhost:3000/api/dev-auth?role=Super%20Admin"   # fresh jar
curl -s -b jar.txt -L "http://localhost:3000/admin" -o admin.html            # HTTP 200, whole shell
```

🔴 **Never log in through the browser to role-switch** — the real login flow revokes the owner's session
([[force-logout-everywhere-needs-three-writes]]). And each cookie switch replaces the WHOLE session, so
sweeping N roles through the cookie clobbers it N times — the cookie route is for viewing ONE role's page.

## The HEADER route — header-only, used by role SWEEPS

`isLocalDevHeaderRequest` (`src/lib/auth/server.ts`) reads ONLY the `x-phoenix-role` / `x-phoenix-hr-id`
request headers, gated on `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `NODE_ENV=development` + a localhost host.
The Browser pane cannot set request headers, so this path is for role SWEEPS (which drive many roles without
clobbering one cookie). Both headers are required: a dev-header context carries no `loginId`, and the admin
layout 307s to `/login` when `!loginId && !hrId` — pass a real active `hr_id` from `app_auth_users` (Super
Admin `PHX-1`, CEO `AA`, SFE Manager `A-2`). A session cookie OUTRANKS the headers and cookies ignore port,
so a stale `localhost:3000` session bleeds onto every role port unless a proxy deletes the cookie.

🔴 **Dev auth can NEVER reach a deployed environment, and it fails MISLEADINGLY.** Railway staging has
`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` set, which LOOKS available, but the host isn't localhost and
`NODE_ENV` is production, so `isLocalDevHeaderRequest` returns false, the request falls through to anonymous
(role `Employee`, source `guest`), and you get a **403 about the ROLE** ("Forbidden: Employee cannot use
marketing requests") that reads like a permissions bug. One gate, shared by both call sites — do not spend a
cycle on it.

## Verifying against STAGING data with no dev server (~150 MB vs ~2 GB — matters when RAM is saturated)

Run the real code in-process with the test runner's flags, pulling staging creds from Railway so nothing hits
disk:
```
eval "$(railway variables --environment staging --service phoenix-people-workforce --kv \
  | grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' \
  | sed 's/^\([A-Z_]*\)=\(.*\)$/export \1="\2"/')"
NODE_ENV=development PHOENIX_ENABLE_DEV_AUTH_HEADERS=true node --experimental-strip-types \
  --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs <script>
```
Build a `new Request("http://localhost:3000/...", {headers:{host:"localhost:3000","x-phoenix-role":…,
"x-phoenix-hr-id":…}})` and pass it to the real `resolveAccessContext` (`access.source === "dev-header"`
proves it applied). Gotchas: `railway` is linked to the MAIN checkout path only (run it from there), and a
worktree has no `node_modules` so `react` won't resolve — junction it and remove with `cmd /c rmdir <link>`,
**never `Remove-Item -Recurse`** (which follows the junction and eats the main checkout's modules).

🔴 **Do NOT enable the flag by appending to `.env.local`** — reading it is permission-gated (production
secrets), and a PowerShell `Add-Content` append lands with a trailing CR (`true\r`), so `=== "true"` is false
and the flag silently does nothing ([[git-bash-crlf-corrupts-secrets-written-to-secret-manager]]). Pass it
inline: `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true pnpm exec next dev …`. Recovery from a bad edit:
`pnpm run worktree:sync-env -- --force`. `.env.local` points at PRODUCTION, so read-only page loads are safe
(they wrote zero `audit_logs` rows) but never click an action button ([[local-env-already-points-at-production]]).

## Rendering caveats (fuller account: [[local-browser-verify-gotchas]])

- 🔴 **A hidden/undisplayed Browser pane makes a WORKING page look BROKEN, with no error** — it reports
  `document.visibilityState === "hidden"`, Chrome then never fires `requestAnimationFrame`, and Next's
  streamed `<div hidden id="S:n">` content never swaps in, so the shell hydrates (polling runs, chunks 200)
  while "Loading…" stays forever on EVERY page. The trap: `document.querySelector` finds the real buttons
  inside the hidden `#S:n` div, so you read the SERVER's initial state and mistake it for live. Geometry
  collapses PARTIALLY — some rects correct, some `0×0` in the same call, indistinguishable — so treat the
  whole read as unverified and re-measure in a real browser, don't retract a finding off it. What still works
  hidden: `getComputedStyle` and `el.textContent`. `tabs_select` does NOT fix it — the pane must be on
  screen. Tells: `visibilityState`, an rAF that never fires, no `__reactFiber$` key on an interactive
  element, `document.body.children` showing `DIV#S:0[hidden]`.
- 🔴 **`<main>` reading "Loading workspace" is a KNOWN FALSE signal** — `document.body.textContent` is the
  honest check (it held 168,315 chars of real admin content while `<main>` still said "Loading";
  [[a-broken-rsc-page-still-returns-http-200]]).
- **The escape hatch is real Chrome via Playwright** (needs nothing from the owner): there is no downloaded
  chromium, so `chromium.launch({ channel: "chrome" })`, then `page.goto("/api/dev-auth?role=…&hrId=…&next=…")`
  for the same cookie auth; screenshots/`isMobile`/`getBoundingClientRect` all work. Put the script under the
  worktree's `node_modules/.scratch/` so `import { chromium } from "playwright"` resolves.
- **launch.json here is attach-only** — `preview_start`'s spawn mode rejects this checkout ("cwd must be a
  relative path", the path is on `F:\` with a space); start `next dev` yourself, then `preview_start` with the
  URL.
- **A repo-side model that derives geometry from source Tailwind classes is a CLAIM about the browser, not a
  higher authority** — it can't see what CSS adds (a `border-r`, the 10px `scrollbar-gutter: stable`), so it
  can be wrong in exactly the direction that makes it PASS (a width harness once certified visibly-clipping
  labels, 11px too generous). When a measurement and a model disagree, re-measure in a real browser before
  retracting; the retraction is the expensive mistake ([[portal-sidebar-label-width-budget]]).
