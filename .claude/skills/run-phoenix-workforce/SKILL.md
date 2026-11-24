---
name: run-phoenix-workforce
description: Run, open, drive or screenshot the Phoenix Workforce web app WHERE THE OWNER CAN WATCH IT — only in the Claude app's browser pane or his own Chrome (Claude in Chrome), never a headless or backgrounded browser, with every screenshot sent to him as it is taken. Covers the spare laptop's dev server (localhost:3000), a PR preview on localhost:3001 on his word, starting a local server only when that is down, signing in as any role through dev-auth (Super Admin, HR Operations, Medical Rep, District Manager, CEO...), desktop and 375px phone looks, measuring horizontal scroll, and calling a src/lib domain function directly. Use to see a change working in the real app, not just in tests.
---

# Run Phoenix Workforce

Next.js 16 web app (admin shell, HR shell, employee portal). Paths below are relative to the repo
root (or your `_wt-<task>` worktree).

## 🥇 The golden rule — he must be able to watch it (owner, 24 Nov 2026)

> "run dev server only run dev server in two sources, either in Chrome, either in panel. I must be
> able to see what are you doing. Never run in background and send me screenshots."

- **A page of the app is opened ONLY in one of two places:** the Claude app's **browser pane**
  (`mcp__Claude_Browser__*`) or **his own Chrome** through Claude in Chrome
  (`mcp__claude-in-chrome__*`), in the browser he picks.
- **Never a browser he cannot see.** `driver.mjs` and `on-spare.ps1` in this folder, a Playwright
  or Puppeteer script, `npx playwright`, Chrome or Edge with `--headless` pointed at the app, and
  any of those with `run_in_background` are all RETIRED for looking at the app. The two files stay
  only because `scripts/phoenix-inspect/` still imports the driver's layers; do not run them.
- **Send him the screenshots as you take them** (`SendUserFile`, status `normal`), not one batch at
  the end, and say in a line what each one shows.
- Printing a LOCAL file you built (a PDF guide, an export) with headless Chrome is not driving the
  app and is not covered by this rule.

## 🔴 Opening a page is not read-only — `.env.local` is PRODUCTION

Every page reads live payroll and sales data, and a visible browser stops NOTHING: a click on save,
send, approve, reverse or confirm is real, and so is a page's own write with no click at all.

- Signed in as a real person, a page writes under that person's name on its own: mount effects,
  autosaves, the beacons of a closing page. Opening a Phoenix CRM module clears their "new" badge;
  opening an empty planner day saves a draft plan.
- The SERVER also writes while answering some reads: a customer list mints that territory's
  carried-over customers (`phoenix_crm_ensure_reference_customers`), and some routes leave a row
  behind, such as a CV opened or a pack printed (`SEAT_VIEW_REFUSED_READS` in
  `src/lib/auth/seat-view.ts` names them).
- So: **sign in role-only unless you need a real person**, click navigation (sidebar links, tabs,
  "Go to…") freely, and open a form to photograph it, then press **Close** — never its save or
  confirm button unless that action IS the task and he asked for it.

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
- **The one exception is a PR PREVIEW, and only on the owner's own word** ("preview 649"; owner,
  2026-11-20: "Set up PR preview"). `& ~/.claude/scripts/spare-preview.ps1 <PR>` shows that open
  pull request on `localhost:3001` for 2 hours (`-Hours` to change), BESIDE the live version, which
  stays on `localhost:3000` (side by side since 2026-11-23); `status` says what is showing, `stop`
  ends it now. Never open one on your own reading. It runs on the production database, so
  everything done in it is real. Open it in the pane or his Chrome like any other page.
- Read it first (it can take 8 s when cold, and times out while the spare is compiling):

```bash
curl -s -m 60 -o /dev/null -w '%{http_code} %{time_total}\n' http://localhost:3000/api/healthz
```

### A local dev server — only when localhost:3000 does NOT answer

Read live free RAM first; do not start the server under ~3 GB free:

```bash
powershell -NoProfile -c "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)"
```

The server process itself runs with `run_in_background: true` (the launcher picks `--webpack`,
caps the heap at 4,096 MB and refuses a second server); it is the PAGES that he must watch.
`preview_start {name}` cannot spawn it here (space in the path).

```bash
node scripts/dev-server.mjs --port 3000
```

## Driving it — the browser pane (default) or his Chrome

1. **Open the pane at the sign-in link** — it signs in and lands on the role's home page:

   ```
   preview_start { url: "http://localhost:3000/api/dev-auth?role=Super%20Admin" }
   ```

   `role=HR%20Operations`, `role=Medical%20Rep`, … for other roles; add `&hrId=<id>` only when a
   block scoped to one person's team must show (a role-only sign-in reads those empty, and a real
   person's sign-in writes as them — see above). Landing pages: Super Admin `/admin`, HR Operations /
   HR Resourcing `/hr/admin/hr-command-center`, portal roles `/employee-portals`, SFE Manager
   `/admin/sfe-command-center` (`src/lib/auth/landing.ts`).
2. **Go to the page** with `navigate`; read it with `get_page_text` / `read_page`; click with
   `find` + `computer {left_click, ref}`. Batch predictable steps in `browser_batch`.
3. **Photograph it** with `computer {action: "screenshot"}` and send it to him straight away. The
   pane keeps every screenshot as a JPG under this session's `tool-results/` folder; crop it with
   `sharp` if a document needs one region.
4. **Phone look:** `resize_window {preset: "mobile"}` (375 × 812, with touch), reload, screenshot.
   **Reset with `{preset: "desktop"}` the moment you finish** — a size you set stays on the tab.
5. **Horizontal scroll (the fits-the-screen rule):** measure it in the page, never by eye:

   ```js
   [...document.querySelectorAll("main, body, main *")]
     .filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== "hidden")
     .slice(0, 10).map(e => ({ tag: e.tagName, cls: e.className.toString().slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth }))
   ```

   with `javascript_tool`; an empty list at both widths is the pass. (`main` is 20 px wider than the
   viewport on desktop admin pages while `body` does not scroll — judge each element against its own
   width.)
6. **His Chrome instead** when he asks for it: load the Claude in Chrome tools in ONE ToolSearch,
   open a new tab (never take over one of his), same steps.

If the pane is hidden (`tabs_context` says so), ask him to show it before you go on.

## Direct invocation (no server, no browser)

Most PRs change `src/lib/<domain>/`. Import and call it with the test suite's loader:

```bash
node --experimental-strip-types --experimental-specifier-resolution=node --import ./tests/register-alias-loader.mjs --input-type=module -e 'const m = await import("@/lib/auth/landing"); console.log(m.resolveLandingPathForRole("HR Operations"), m.resolveLandingPathForRole("Medical Rep"));'
```

prints `/hr/admin/hr-command-center /employee-portals` (plus harmless
`MODULE_TYPELESS_PACKAGE_JSON` warnings). Add `--env-file-if-exists=.env.local` only if the code
reads the database — that is production.

## Tests and typecheck

Not run locally on this 16 GB laptop: the PR's `validate` + `checks` jobs are the verdict
(AGENTS.md §7), and a local typecheck is refused by `bash-guard.mjs` C8. Tests that must run
before the push go to the spare: `& ~/.claude/scripts/spare-test.ps1`.

## Stop

Never stop or restart the spare's dev server — its systemd service owns it. Stop only a LOCAL
server YOU started, by port (never one the owner or another session started):

```powershell
$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*scripts/dev-server.mjs --port 3000*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 2; "listening: " + [bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
```

It stops the listener AND the launcher (which would otherwise respawn), and prints
`listening: False` when the port is free.

## Gotchas

- 🔴 **On the spare, `/admin` can take many minutes — the page's own server work, not the compile.**
  On 2026-11-07 the spare's log read `GET /admin 200 in 11.6min (next.js: 8.2s, …
  application-code: 11.5min)`: the Command Center's reads of the production database over the home
  Wi-Fi. Open the page you actually changed, not `/admin` as a smoke test.
- **The dev server restarts itself once nothing is in flight** after a few compiles under its 4 GB
  cap (`[dev-server] heap … — restarting once the N request(s) in flight finish`). A page that
  fails to load in that window is the restart, not the page — wait for healthz and reload.
- **Heavy pages stream after the network is quiet** — a "Loading …" skeleton in the first
  screenshot means wait and take it again.
- **A sidebar click is a client navigation** — the address changes before the page has compiled;
  read the page text before you photograph it.
- **A page's own language switch beats the profile's.** Before photographing for an English
  document, press the page's own "English" button and check the headings in `get_page_text`.
- **Needs You logs `needs_you_source_timeout` in dev** for slow sources; the page still renders the
  rest.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| every page fails, `ERR_CONNECTION_REFUSED` | the server is restarting or down; `curl` healthz, then reload |
| screenshot is a grey skeleton | wait, read the page text until the content is there, photograph again |
| `dev-auth refused (409) role_mismatch` | use the role the message names, or drop `hrId` |
| the pane answers that it is hidden | ask him to show it (Ctrl+Shift+B, or the globe icon) |
