---
name: run-phoenix-workforce
description: Run, start, launch, drive or screenshot the Phoenix Workforce web app locally — start the dev server, sign in as any role through dev-auth (Super Admin, HR Operations, Medical Rep, District Manager, CEO...), open a page, click by text, take desktop and 375px mobile screenshots, measure horizontal scroll, or call a src/lib domain function directly. Use to see a change working in the real app, not just in tests.
---

# Run Phoenix Workforce

Next.js 16 web app (admin shell, HR shell, employee portal). An agent drives it with
`driver.mjs` in this folder: headless Chromium (the Playwright install the e2e suite already
has) signs in through `GET /api/dev-auth?role=…`, then runs steps — `go`, `click`, `shot`,
`overflow`, `text`, `waitfor`, `eval`. Paths below are relative to the repo root (or your
`_wt-<task>` worktree). Verified on the owner's Windows laptop, Git Bash, Node 24.15, 2026-10-20.

🔴 **`.env.local` is PRODUCTION Supabase.** Every page reads live payroll and sales data, and a
click on save / send / approve / delete does it for real. `go`, `shot`, `text`, `overflow` and
`eval` are read-only; `click` only on navigation (sidebar links, tabs).

## Prerequisites

Nothing to install: `node_modules` (junctioned into every `_wt-*` worktree) already holds
`playwright`, and its Chromium is in `%LOCALAPPDATA%\ms-playwright\chromium-1243`.
Work in your own worktree — `node scripts/new-session.mjs <task>` — and never run `pnpm` inside
one (it purges the `node_modules` junction).

Read live free RAM first; do not start the server under ~3 GB free:

```bash
powershell -NoProfile -c "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)"
```

## Start the dev server

Run it with `run_in_background: true` (the launcher picks `--webpack`, caps the heap at
4,096 MB and refuses a second server). `preview_start` cannot spawn it here (space in the path).

```bash
node scripts/dev-server.mjs --port 3000
```

Ready in ~2 s; the first request compiles (healthz took 8 s, a page 12-60 s):

```bash
curl -s -m 150 -w "\n%{http_code}\n" http://localhost:3000/api/healthz
```

## Run (agent path) — the driver

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
  `--base`, `--out`. Steps: `go <path>`, `click <exact text>`, `fill <label> <value>`,
  `waitfor <text>`, `shot <name>`, `text`, `overflow`, `eval <js>`, `wait <ms>`.
- Exit 1 on a failed step or on horizontal scroll (`overflow`). Console errors and 5xx responses
  print at the end.
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
(AGENTS.md §7), and a local typecheck is refused by `bash-guard.mjs` C8.

## Stop

Stop the server YOU started by port (never one the owner or another session started):

```powershell
$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*scripts/dev-server.mjs --port 3000*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 2; "listening: " + [bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
```

It stops the listener AND the launcher (which would otherwise respawn), and prints
`listening: False` when the port is free.

## Run (human path)

`pnpm run dev` in the primary (his PowerShell profile routes it to `scripts/dev-server.mjs`),
then open http://localhost:3000/api/dev-auth?role=Super%20Admin in a browser.

## Gotchas

- **Git Bash rewrites `/admin` into `C:/Program Files/Git/admin`** before node sees it — the first
  run failed `net::ERR_FILE_NOT_FOUND at c:/Program%20Files/Git/admin`. `export
  MSYS_NO_PATHCONV=1`; the driver also undoes the rewrite on `go`.
- **Next restarts its own server mid-session**: `⚠ Server is approaching the used memory
  threshold, restarting...` after three or four page compiles under the 4 GB cap. Requests in
  flight die `ERR_CONNECTION_RESET`/`REFUSED`; the driver waits for `/api/healthz` and retries
  (4 attempts). Console errors printed during that window are the restart, not the page.
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
| `ERR_CONNECTION_RESET` / `REFUSED` on every step | the server died or is restarting; `curl` healthz, restart it in the background |
| screenshot is a grey skeleton | add `waitfor "<text on the loaded page>"` before `shot` |
| `dev-auth refused (409) role_mismatch` | use the role the message names, or drop `--hrId` |
| background launcher task "failed, exit 127" after you stopped it | expected — that is the kill, not a crash |
