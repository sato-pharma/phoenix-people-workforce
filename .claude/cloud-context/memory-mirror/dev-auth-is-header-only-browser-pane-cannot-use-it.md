---
name: dev-auth-is-header-only-browser-pane-cannot-use-it
description: "GET /api/dev-auth?role=<Role> DOES role-switch the Browser pane — navigate to it, it sets an httpOnly dev-preview cookie and redirects; no proxy, and it DOES take hrId and loginId (corrected 2026-08-30 - the route reads both from the query string, so ?role=<Role>&hrId=<HR> signs you in as THAT person, which is the only way to verify anything scoped to one manager's own team). Only the SEPARATE x-phoenix-* request-header path is header-only, and that is what role sweeps use. This file's name is now a misnomer."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d7876385-32d4-4aa5-880a-8afbb11a769b
  modified: 2026-08-28T04:25:45.492Z
---

`isLocalDevHeaderRequest` (`src/lib/auth/server.ts`) reads **only** `x-phoenix-role` /
`x-phoenix-hr-id` request headers (gated on `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`,
`NODE_ENV=development`, and a localhost `host`/`x-forwarded-host`). No cookie or query-param
equivalent. The Browser pane cannot set request headers.

**But that does NOT mean browser verification is impossible — that conclusion was drawn once and was
wrong.** Run a tiny local proxy in front of `next dev`, one port per role, stamping the headers
(`scratchpad/role-proxy.mjs`, 2026-08-08 sidebar session). Three things each cost a cycle:

1. **Both headers are required.** `app/(admin)/layout.tsx` redirects to `/login` when
   `!access.loginId && !access.hrId`, and a dev-header context carries no loginId. Role alone → 307.
   Use a real active `hr_id` from `app_auth_users` (2026-08-08: Super Admin `PHX-1`, CEO `AA`,
   SFE Manager `A-2`).
2. **A session cookie OUTRANKS the dev headers**, and **cookies ignore port** — a stale
   `localhost:3000` session applies to `localhost:3101`, so every role port silently renders as
   whoever that session belongs to. The symptom is nasty: `curl` (no cookie jar) shows the correct
   per-role render while the browser shows ONE wrong role everywhere, which reads like a caching
   bug. **The proxy must `delete headers.cookie`** and drop `set-cookie` on the way back. That
   revokes nothing server-side; it only affects those ports.
3. Guard the proxy's error path with `if (clientRes.headersSent)` — otherwise one dead socket throws
   `ERR_HTTP_HEADERS_SENT` and kills the whole proxy mid-verification.

Always confirm the resolved identity in the page header (`PHX-1 Super Admin`) before trusting
anything you read off the page.

**Never log in through the browser to role-switch** — the cookie flow revokes the owner's real
session. See [[force-logout-everywhere-needs-three-writes]].

`.claude/launch.json` here is **attach-only**: `preview_start`'s spawn mode rejects this checkout
(`cwd must be a relative path within the project root`) because the path is on `F:\` with a space.
Start the server yourself (`pnpm exec next dev --turbopack --port 3000`), then `preview_start`
with the URL. Screenshots need the pane to be *displayed*; when it is not, `read_page` and
`javascript_tool` still work and are better evidence for structural checks anyway.

`.env.local` points at PRODUCTION, so a dev server reads live data. Read-only page loads are safe —
verified 2026-08-08 that dev-header page loads wrote **zero** `audit_logs` rows — but never click
action buttons. See [[blind-coordinate-clicks-fired-a-production-collection-run]] and
[[local-env-already-points-at-production]].

**CORRECTION (2026-08-09): there IS a cookie path — no proxy needed.** The header route
(`isLocalDevHeaderRequest`) is header-only, but `resolveAccessContext` ALSO honors a **dev-preview
cookie** (`phoenixDevPreviewCookieName`, decoded by `accessContextFromDevPreviewToken`) whenever the
request is local. Two built-in routes mint it and both work straight from the Browser pane by
navigating to a URL — no header-injecting proxy:
- `GET /api/dev-auth?role=<Role>&hrId=<HR>&next=<path>` (`app/api/dev-auth/route.ts`) — sets the
  httpOnly cookie and 302s to `next`. Verified 2026-08-09: `role=Super%20Admin&next=/admin/...` and
  `role=Medical%20Rep&hrId=A-7&next=/employee-portals/private-calendar` both authed cleanly in the
  pane (`dev.preview <Role>` shows in the header). Role must be canonical (`parseRoleStrict`);
  portal pages need a role in `portalNavigationRoles` (Employee, Medical Rep, District/Regional/
  National Sales Manager, Product/Group Product/Marketing/Training Manager, CEO, Manager, Talent
  Acquisition) or they 307 to `/overview`.
- `/admin/dev-preview` — the Super-Admin picker UI does the same via `POST /api/dev-auth/preview`.
The header-proxy above still works, but for a quick role view the `/api/dev-auth` GET is far less
setup. (Logout clears the cookie: `app/api/auth/logout` deletes `phoenixDevPreviewCookieName`.)

**Pane-not-displayed breaks layout reads, not just screenshots (2026-08-09).** When the Browser
pane is not on screen it stops compositing, and then EVERY layout-dependent read collapses, not only
`computer{screenshot}`: `getBoundingClientRect().width` → 0, `el.offsetParent` → null, and
`element.innerText` → "" (even with a fully-populated DOM). This masquerades as "the grid is inside
a `display:none` branch" — it is not; nothing is hidden. What still works while undisplayed:
`getComputedStyle(el)` (read `gridTemplateColumns` etc.) and `el.textContent`. So structural/CSS
proof survives a hidden pane; pixel-width, visibility, and screenshot proof do NOT — for those the
user must bring the pane into view first. (Cost ~10 round trips chasing a phantom hidden-ancestor on
the private-calendar month grid before realizing the pane had simply gone dark.)

**WORSE THAN THAT: a hidden pane makes a WORKING page look BROKEN, with no error anywhere
(2026-08-19).** An undisplayed pane reports `document.visibilityState === "hidden"`, and Chrome then
**never fires `requestAnimationFrame`**. Next's streamed route content is delivered as
`<div hidden id="S:0|S:1|S:2">` blocks at the end of `<body>` that a paint-driven step swaps into
place — so the swap never happens. The portal shell hydrates fine (badge/notification polling keeps
running, no console error, all chunks 200), while `.employee-portal-route-loading` — "Loading
employee portal page" — stays on screen forever. Every portal page does this, not just the one you
changed. **The trap:** `document.querySelector` still finds the real page's buttons, because that
markup is sitting in the `hidden` `#S:n` div — so you read the SERVER's initial state and mistake it
for the live one. Here that meant "My Pharmacies (0), disabled" while the API in the same tab
returned 3 items, which reads exactly like a state-wiring bug. Tells, in order of cheapness:
`document.visibilityState`, a `requestAnimationFrame` that never fires, `Object.keys(el).some(k =>
k.startsWith("__reactFiber$")) === false` on an element that should be interactive, and
`[...document.body.children]` showing `DIV#S:0[hidden]`. `tabs_select` does NOT fix it — the pane
itself must be on screen.

**So verify UI in a real Chrome instead, driven by Playwright — it needs nothing from the user
(2026-08-19).** `playwright` is already a devDependency, but **there is no downloaded chromium** in
`%LOCALAPPDATA%\ms-playwright` (`browserType.launch` fails asking for `npx playwright install`).
Launch the installed browser instead: `chromium.launch({ channel: "chrome" })`. Then
`page.goto("/api/dev-auth?role=…&hrId=…&next=…")` gives you the same cookie auth, and screenshots,
`isMobile` viewports, and `getBoundingClientRect` all work properly. Put the script under
`node_modules/.scratch/` in the worktree so `import { chromium } from "playwright"` resolves — a
script in the scratchpad directory cannot see the repo's `node_modules`.

**Dev auth can NEVER reach a deployed environment, and it fails MISLEADINGLY (2026-08-19).** Railway
staging *does* have `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`, which makes it look available — but the
host is not localhost and `NODE_ENV` is production, so `isLocalDevHeaderRequest` returns false and
the request falls through to `anonymousAccessContext` (role `Employee`, source `guest`). The reply
is a **403 about the ROLE**, e.g. `Forbidden: Employee cannot use marketing requests` — it reads
like a permissions bug, not "your headers were ignored". Do not spend a cycle on it; there is one
gate and both call sites (`server.ts:441`, `:489`) share it.

**To verify domain behaviour against STAGING DATA without a dev server** (2026-08-19, ~150 MB vs
~2 GB — matters when RAM is saturated): run the real code in-process with the test runner's own
flags, pulling staging creds from Railway so nothing is written to disk:

```
eval "$(railway variables --environment staging --service phoenix-people-workforce --kv \
  | grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' \
  | sed 's/^\([A-Z_]*\)=\(.*\)$/export \1="\2"/')"
NODE_ENV=development PHOENIX_ENABLE_DEV_AUTH_HEADERS=true node --experimental-strip-types \
  --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs <script>
```

Build a `new Request("http://localhost:3000/...", {headers:{host:"localhost:3000", "x-phoenix-role":…,
"x-phoenix-hr-id":…}})` and pass it to the real `resolveAccessContext` — all three gate conditions
are then satisfied, and `access.source === "dev-header"` proves it applied. Two gotchas: `railway`
is linked to the **main checkout path only** (`~/.railway/config.json`), so run it from there; and a
worktree usually has **no `node_modules`**, so `react` fails to resolve — link it with
`New-Item -ItemType Junction`, and remove it afterwards with `cmd /c rmdir <link>` (**never**
`Remove-Item -Recurse`, which follows the junction and would eat the main checkout's modules).

Still true: **do not try to enable the flag by appending to `.env.local`.** Reading it is
permission-gated (it holds production secrets, correctly), and a PowerShell `Add-Content` append
lands with a trailing CR on this CRLF repo — the value becomes `true\r`, `=== "true"` is false, and
the flag silently does nothing. Pass it inline instead:
`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true pnpm exec next dev ...`. Recovery from a bad edit:
`pnpm run worktree:sync-env -- --force`. See
[[git-bash-crlf-corrupts-secrets-written-to-secret-manager]].

## 2026-08-23 — a hidden pane returns a MIX of correct rects and 0×0, and you cannot tell which

The notes above say `getBoundingClientRect().width → 0` in an undisplayed pane. That is only *one*
of its behaviours. A hidden pane computes layout **partially**: in one and the same `javascript_tool`
call on `/admin/outstation/expense-command`, two `<table>` elements holding 11 and 251 real rows
reported `0×0` while a sidebar label span reported `clientWidth 125` / `scrollWidth 129`.

**The sidebar numbers were CORRECT.** Playwright, driving a properly rendered Chromium, reproduced
`125` / `129` exactly. So the hazard is not that hidden-pane rects are wrong — it is that some are
and some are not, in the same call, with nothing to distinguish them. Treat the whole read as
unverified, then **re-measure in a real browser**. Do not treat it as refuted.

**The expensive mistake was the retraction, not the measurement.** The 4px clip on
`Territory Management` was reported, then withdrawn because the repo's own harness
(`tests/sidebar-label-width.test.ts`) said the label fits with 6px to spare. The harness was the
thing that was wrong: `labelBudgetPx()` in `src/config/sidebar-metrics.ts` derived its numbers by
reading the Tailwind classes in `sidebar.tsx`, so it never charged the two costs that are not
written there — the aside's 1px `border-r` (`w-[280px]` is border-box) and the **10px scrollbar
gutter** that `.phoenix-admin-sidebar-scroll` reserves permanently via `scrollbar-gutter: stable`.
Every budget was **11px too generous**, so the test certified labels that were visibly clipping.
Corrected, it immediately caught three (`People Management`, `Territory Management`,
`Doctor Coverage Settings`). Fixed in #2353 by widening the rail 280 → 292.

**How to apply:** a repo-side model is not a higher authority than the browser — it is a *claim about*
the browser, and it can be wrong in exactly the direction that makes it pass. When a measurement and
a model disagree, the model is the cheaper thing to audit but the browser is the thing that decides;
re-measure properly (Playwright, not a hidden pane) before you retract a finding. A model that
derives geometry from source classes cannot see anything the CSS adds — borders, gutters, scrollbars.

Two smaller things that held up: when checking whether a page rendered at all, `textContent` on
`document.body` is the honest signal — it read **565,925 chars** of real content on a page whose
`<main>` said only "Loading workspace". And `getComputedStyle` remains trustworthy in a hidden pane
even when rects are not.

**There IS a cookie route, and "no cookie or query-param equivalent" above is wrong about it —
corrected 2026-08-28.** That sentence is true of the `x-phoenix-*` DEV-HEADER path only. Separately,
`GET /api/dev-auth?role=<Role>` (`app/api/dev-auth/`) 307s to `/admin` and sets a
**`phoenix_dev_preview`** cookie, consumed by `accessContextFromDevPreviewToken` at
`src/lib/auth/server.ts:432-439` — which is checked BEFORE the header path, so no proxy and no
`hr_id` is needed. **This is the cheapest way to render a real admin page for verification:**

```
curl -s -c jar.txt "http://localhost:3000/api/dev-auth?role=Super%20Admin"   # fresh jar
curl -s -b jar.txt -L "http://localhost:3000/admin" -o admin.html            # HTTP 200
```

Measured 2026-08-28 on a fresh jar: **HTTP 200, 507,042 bytes, 25 distinct `/admin/*` sidebar
links** — the whole shell, greppable. Role-only dev HEADERS still 307 to `/login` exactly as point 1
above says, so the two paths behave differently and that contrast is the tell.

Caveat that cost time the same day: the **Browser pane** was pointed at the same `/api/dev-auth` URL
and afterwards sat on `/` with `<main>` reading "Loading workspace". That was NOT established as a
pane failure — per the paragraph above, `<main>` saying exactly that is a known false signal and
`document.body.textContent` is the honest check. It went unmeasured because curl had already given
the stronger answer. **Do not cite that attempt as evidence either way.**

## 2026-08-29 — the pane round-tripped a role switch; the description was the last wrong copy

The correction below has been in this file since 2026-08-09 and was restated on 2026-08-28. What
stayed wrong for three weeks was everything a session actually reads FIRST: this file's frontmatter
`description`, the hook in `AGENTS.md` 2.1, and the account in `docs/agents-session-traps.md` — all
three still said the Browser pane cannot role-switch and that a header-injecting proxy is required.
A session that recalls a memory sees the description, so the one line that decides recall was
carrying the refuted claim. All three corrected today.

Measured by navigating the Browser pane to the URL three times against `next dev --webpack` on
localhost:3002:

| Navigated to | Landed on | `/admin` links | `/employee-portals` links | body chars |
| --- | --- | --- | --- | --- |
| `?role=Super Admin` | `/admin` | present | — | 168,315 |
| `?role=Medical Rep` | `/employee-portals` | 0 | 69 | 64,633 |
| `?role=Super Admin` | `/admin` | 79 | 0 | 166,998 |

That is a genuine round trip, not a first login — the navigation surface changes completely and
changes back. `document.cookie` does NOT show `phoenix_dev_preview`, confirming the httpOnly flag.

**This closes the open caveat above.** The 2026-08-28 note says the pane was pointed at
`/api/dev-auth` and afterwards "sat on `/` with `<main>` reading Loading workspace", recorded as
proving nothing either way. It proves nothing because that string is the known false signal this
same file documents: on the successful loads here, `<main>` ALSO read "Loading workspace" while
`document.body.textContent` held 168,315 chars of real admin content. Read the body text, not
`<main>`.

**Role SWEEPS still use the headers**, and that half was never wrong: each cookie switch replaces
the browser's whole session, so sweeping N roles through the cookie clobbers it N times. The cookie
route is for looking at ONE role's page, which is the common case for verifying a UI change.

**The filename is now a misnomer** — it asserts the opposite of what the file concludes. It was left
alone deliberately: renaming means touching the `MEMORY.md` pointer, which only the control-tower
session rewrites, plus the backticked slug in `AGENTS.md` that keeps this file reachable at all.
The cost of a wrong name is one confused search; the cost of a broken pointer is an invisible file.

Related: [[a-broken-rsc-page-still-returns-http-200]] ·
[[a-responsive-primitive-test-proves-layout-not-content]] ·
[[portal-sidebar-label-width-budget]] ·
[[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]]
