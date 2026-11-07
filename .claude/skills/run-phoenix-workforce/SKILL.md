---
name: run-phoenix-workforce
description: Run, start, launch, drive or screenshot the Phoenix Workforce web app — drive the spare laptop's dev server (localhost:3000), start a local one only when that is down, sign in as any role through dev-auth (Super Admin, HR Operations, Medical Rep, District Manager, CEO...), open a page, click by text, take desktop and 375px mobile screenshots, measure horizontal scroll, or call a src/lib domain function directly. Use to see a change working in the real app, not just in tests.
---

# Run Phoenix Workforce

Next.js 16 web app (admin shell, HR shell, employee portal). An agent drives it with
`driver.mjs` in this folder: headless Chromium (the Playwright install the e2e suite already
has) signs in through `GET /api/dev-auth?role=…`, then runs steps — `go`, `click`, `shot`,
`overflow`, `text`, `waitfor`, `eval`. Paths below are relative to the repo root (or your
`_wt-<task>` worktree). First verified on the owner's Windows laptop, Git Bash, Node 24.15,
2026-10-20; the spare-laptop path below was added and run 2026-11-07.

🔴 **`.env.local` is PRODUCTION Supabase, so opening a page is not automatically read-only.** Every
page reads live payroll and sales data. Signed in as a real person (`--hrId`), a page writes under
that person's name with no click at all: its mount effects, its autosaves and the beacons of a
closing page. Opening a Phoenix CRM module clears their "new" badge, and opening an empty planner
day saves a draft plan.

**So the driver's browser sends GET and nothing else, on every step, and no flag turns that off.**
It aborts every non-GET request (a form post gets an empty 204 so the page stays where it is) and
replaces `navigator.sendBeacon` and non-GET `fetch` inside the page, because a beacon or keepalive
call from a closing page got past request routing alone. Every write it stopped is listed at the end
of the run, as `writes stopped (N)`.

- **A stopped fetch or beacon is answered as a success (204), so the screen can lie.** "Saved" on a
  driven page means nothing was saved. To prove a save works, use a test, or staging.
- **Use `click` for navigation (sidebar links, tabs).** A save, send or approve click is stopped too,
  so it proves nothing about that action.
- 🔴 **What it cannot stop: a write made by the SERVER while answering a GET.** The browser only asks
  for the page; the server does the writing. Reading a customer list mints that territory's
  carried-over customers (`phoenix_crm_ensure_reference_customers`), and some GET routes leave a row
  behind, such as a CV opened or a pack printed (`SEAT_VIEW_REFUSED_READS` in
  `src/lib/auth/seat-view.ts`, which names them). `writes stopped (0)` therefore does not prove that
  nothing was written. Prefer a role-only sign-in when you do not need a real person.
- A driver run from a checkout older than this rule has none of this. Check that the end of the
  run prints the `writes stopped` line.

## Prerequisites

Nothing to install: `node_modules` (junctioned into every `_wt-*` worktree) already holds
`playwright`. Each Playwright version pins its own browser build, and the weekly dependency
refresh moves the version (1.64.1 wants `chromium_headless_shell-1248`; the laptop held `1243`),
so when that build is missing the driver starts the installed **Microsoft Edge**, then Chrome,
and prints `browser: Playwright's own Chromium is missing, using installed msedge`. Nothing to
download.
Work in your own worktree — `node scripts/new-session.mjs <task>` — and never run `pnpm` inside
one (it purges the `node_modules` junction).

## Where the app runs — the spare laptop, not this one

🔴 **`localhost:3000` on this laptop is the SPARE laptop's dev server** (owner, 2026-11-07): the
scheduled task "Phoenix Spare Tunnel" holds an `ssh -L 3000` forward to it, and
`spare-follow-production.ps1` keeps it on **production's exact version, on the production
database**, every 10 minutes. So:

- **Never start a dev server on this laptop while `localhost:3000` answers**, and never move the
  spare's checkout to a branch.
- **It shows what is LIVE, never your branch.** To prove a change in `src/lib/`, use Direct
  invocation below or the tests on the spare (`& ~/.claude/scripts/spare-test.ps1`); the PR's CI is
  the verdict.
- Read it first (it can take 8 s when cold, and times out while the spare is compiling):

```bash
curl -s -m 60 -o /dev/null -w '%{http_code} %{time_total}
' http://localhost:3000/api/healthz
```

### Drive it ON the spare — `on-spare.ps1` (the default)

This laptop starts no browser: the wrapper copies THIS checkout's `driver.mjs` into the spare's
gitignored `output/run-skill-remote/<stamp>/`, runs it there against the spare's own server with
`--timeout 900`, and copies the PNGs back to `output/run-skill/`. It reads healthz first and
sends nothing when the server does not answer in 60 s. Every argument goes to the driver unchanged.

```bash
powershell -NoProfile -File .claude/skills/run-phoenix-workforce/on-spare.ps1 --role "Super Admin" go /admin shot admin-desktop overflow
```

Run it with `run_in_background: true`: a page the spare has not served since its last restart
compiles for minutes (see Gotchas).

### A local dev server — only when localhost:3000 does NOT answer

Read live free RAM first; do not start the server under ~3 GB free:

```bash
powershell -NoProfile -c "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)"
```

Run it with `run_in_background: true` (the launcher picks `--webpack`, caps the heap at
4,096 MB and refuses a second server). `preview_start` cannot spawn it here (space in the path).
Verified 2026-10-20, before the spare took the dev server.

```bash
node scripts/dev-server.mjs --port 3000
```

Ready in ~2 s; the first request compiles (healthz took 8 s, a page 12-60 s):

```bash
curl -s -m 150 -w "
%{http_code}
" http://localhost:3000/api/healthz
```

## The driver — steps and output

The same steps work on the spare (above) or locally against `localhost:3000`; a local run starts
Edge on THIS laptop (~300 MB), so prefer `on-spare.ps1` when free RAM is under ~3 GB.

```bash
export MSYS_NO_PATHCONV=1
node .claude/skills/run-phoenix-workforce/driver.mjs --role "Super Admin" go /admin shot admin-desktop overflow text
node .claude/skills/run-phoenix-workforce/driver.mjs --role "Super Admin" go /admin click "Needs You" shot needs-you
node .claude/skills/run-phoenix-workforce/driver.mjs --role "Medical Rep" --width 375 go /employee-portals shot portal-mobile overflow
node .claude/skills/run-phoenix-workforce/driver.mjs --role "HR Operations" go /hr/admin/hr-command-center shot hr-ops overflow
```

Output, one line per step, e.g.

```
signed in: Super Admin
go /admin -> 200 "Command Center · Phoenix Workforce" at /admin
click "Needs You" -> /admin/needs-you
shot output\run-skill\needs-you.png
overflow @375px ok [{"sel":"main","scrollWidth":351,"clientWidth":351},{"sel":"body","scrollWidth":375,"clientWidth":375}]
```

- Screenshots land in `output/run-skill/<name>.png` (gitignored); a failed step also writes
  `failure.png`. **Open the PNG and look at it.**
- Options: `--role`, `--hrId` (sign in as that person), `--width` (375 = phone, with touch),
  `--base`, `--out`, `--timeout <s>` (one navigation's limit, default 180). Steps: `go <path>`, `click <exact text>`, `fill <label> <value>`,
  `waitfor <text>`, `shot <name>`, `text`, `overflow`, `eval <js>`, `wait <ms>`.
- Exit 1 on a failed step or on horizontal scroll (`overflow`). Console errors, 5xx responses and
  `writes stopped (N)` print at the end. A stopped write does not fail the run. A page that reads
  its data through a POST shows that data as empty, and its POST is in that list.
- Landing pages: Super Admin `/admin`, HR Operations / HR Resourcing
  `/hr/admin/hr-command-center`, portal roles (Medical Rep, District Manager, …)
  `/employee-portals`, SFE Manager `/admin/sfe-command-center` — see `src/lib/auth/landing.ts`.

## Direct invocation (no server)

Most PRs change `src/lib/<domain>/`. Import and call it with the test suite's loader:

```bash
node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs --input-type=module -e 'const m = await import("@/lib/auth/landing"); console.log(m.resolveLandingPathForRole("HR Operations"), m.resolveLandingPathForRole("Medical Rep"));'
```

prints `/hr/admin/hr-command-center /employee-portals` (plus harmless
`MODULE_TYPELESS_PACKAGE_JSON` warnings). Add `--env-file-if-exists=.env.local` only if the code
reads the database — that is production.

## Tests and typecheck

Not run locally on this 16 GB laptop: the PR's `validate` + `checks` jobs are the verdict
(AGENTS.md §7), and a local typecheck is refused by `bash-guard.mjs` C8. Tests that must run
before the push go to the spare: `& ~/.claude/scripts/spare-test.ps1` (the whole suite, this
checkout's state sent as one patch; never the dev server's folder).

## Stop

Never stop or restart the spare's dev server — the scheduled task owns it. Stop only a LOCAL
server YOU started, by port (never one the owner or another session started):

```powershell
$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*scripts/dev-server.mjs --port 3000*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 2; "listening: " + [bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
```

It stops the listener AND the launcher (which would otherwise respawn), and prints
`listening: False` when the port is free.

## Run (human path)

`pnpm run dev` in the primary (his PowerShell profile routes it to `scripts/dev-server.mjs`),
then open http://localhost:3000/api/dev-auth?role=Super%20Admin in a browser.

## Gotchas

- 🔴 **The spare is an 8 GB box and its first compile of a page can take 10+ minutes.** On
  2026-11-07 (free RAM 500-1,000 MB, a suite from another session running beside it) the first
  `go /admin` sat on `Compiling /(admin)/admin/page ...` for over 15 minutes: the default 180 s
  `page.goto` timed out, and for several minutes even `/api/healthz` stopped answering through the
  tunnel. Hence `--timeout 900` and the healthz read in `on-spare.ps1`. Read the spare's own log
  for progress, never re-send the request:
  `& ~/.claude/scripts/spare.ps1 'Get-Content D:Phoenixdev-server.log -Tail 5'`.
- **A killed run leaves its Edge on the spare.** Stop only the headless ones you started:
  `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"` filtered on `--headless`, via
  `spare.ps1`.
- **The spare has no Playwright browser either**, so the driver there also falls back to Edge
  (`browser: Playwright's own Chromium is missing, using installed msedge`) — expected.
- **Git Bash rewrites `/admin` into `C:/Program Files/Git/admin`** before node sees it — the first
  run failed `net::ERR_FILE_NOT_FOUND at c:/Program%20Files/Git/admin`. `export
  MSYS_NO_PATHCONV=1`; the driver also undoes the rewrite on `go`.
- **The dev server restarts itself mid-session, once nothing is in flight**: after three or four
  page compiles under the 4 GB cap the log says `[dev-server] heap … — restarting once the N
  request(s) in flight finish`, then `restarting now`. Since 2026-10-31 the restart waits for open
  requests (`scripts/dev-server-graceful-restart.mjs`), so a streaming page is no longer cut into
  React error 419. It still restarts at once past 92% of the cap or after 90 s of waiting, and
  `PHOENIX_DEV_GRACEFUL_RESTART=0` brings back Next's own mid-request exit. The next request can
  meet `ERR_CONNECTION_REFUSED` while the server respawns; the driver waits for `/api/healthz` and
  retries (4 attempts). Console errors printed in that window are the restart, not the page.
- **A lower heap cap makes it worse, not lighter**: `PHOENIX_DEV_HEAP_MB=3072` restarted ten times
  in twenty minutes, served `ChunkLoadError` pages between restarts, then died with exit 134 (V8
  out of memory). Keep the default 4,096 MB; when free RAM is too low for that, prove a single
  component outside Next instead (bundle it with React and drive it in Playwright).
- **The restart moves the PID**: the listener on 3000 is a new child, not the one you launched.
- **Heavy pages stream after the network is quiet** — the first Needs You shot was a "Loading
  Needs You" skeleton. The driver now waits up to 120 s for any `Loading …` heading to go; use
  `waitfor <text>` for anything else.
- **A sidebar click is a client navigation**: `click` returned at `/admin` while
  `/admin/needs-you` was still compiling. The driver now waits for the link's own `href`.
- **RAM collapses fast**: free RAM went 3.4 GB → 1.0 GB after six driven pages (server ~4 GB +
  Chromium). Stop the server as soon as the look is done; under ~1.8 GB this laptop freezes.
- **`--hrId` is checked against the real person**: `--role "Medical Rep" --hrId B-10` exits 1 with
  `dev-auth refused (409) … signs in as Super Admin, not Medical Rep`. A role-only sign-in has no
  hr id (`dev.preview`), so blocks scoped to one person's team read empty — pass `--hrId`.
- **Needs You logs `needs_you_source_timeout` in dev** for slow sources (action-inbox,
  closing-publication-drift); the page still renders the rest.
- **`main` is 20 px wider than the viewport on desktop admin pages** (`scrollWidth 1460` at
  1440) but `body` does not scroll; `overflow` judges each element against its own clientWidth.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `net::ERR_FILE_NOT_FOUND at c:/Program%20Files/Git/…` | `export MSYS_NO_PATHCONV=1` |
| `no browser could start` (Playwright's build, Edge and Chrome all failed) | `npx playwright install chromium` from the primary, never from a worktree |
| `ERR_CONNECTION_RESET` / `REFUSED` on every step | the server died or is restarting; `curl` healthz, restart it in the background |
| screenshot is a grey skeleton | add `waitfor "<text on the loaded page>"` before `shot` |
| a block reads empty, a console error says an unexpected response came from the server, or `ERR_BLOCKED_BY_CLIENT` | its POST was stopped: look for it under `writes stopped`, and do not read it as a defect |
| `dev-auth refused (409) role_mismatch` | use the role the message names, or drop `--hrId` |
| `on-spare.ps1`: `the spare's dev server does not answer /api/healthz in 60 s` | it is compiling or out of memory — read its log through `spare.ps1`, wait, never restart it |
| `FAILED: page.goto: Timeout 180000ms exceeded` | a first compile on a slow server: run through `on-spare.ps1` (900 s) or pass `--timeout 900` |
| background launcher task "failed, exit 127" after you stopped it | expected — that is the kill, not a crash |
