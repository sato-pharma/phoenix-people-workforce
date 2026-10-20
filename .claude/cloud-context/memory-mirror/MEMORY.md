# Memory Index

**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.

**Hooks only - the FILE is the fact. Rules: `AGENTS.md` §2.2.**
- [ARCHIVE](MEMORY-ARCHIVE.md) - the pre-2026-10-02 archive; every note in it is now filed in a module.

## 🥇 RULE #1 - never trim, never forget
- 🔴 [**`B-10` is the OWNER himself**](b-10-is-the-owner-himself.md) - sole Super Admin, so EVERY `decided_by` is his. Never advise him to "tell B-10" or notify him of his own decisions.
- 🔴 [**Monthly Closing** = the ONLY sales+target truth](sos-monthly-closing-is-the-only-sales-truth.md) - every surface reads ITS sales AND target (targets confirmed 2026-09-27); Weekly excluded; Marketing ROI the ONE exception.
- 🔒 [Head Office is in NEITHER weekly NOR monthly - unmapped is CORRECT](head-office-products-are-not-tracked-weekly-golden-rule.md) - tracked = **CNS · Anti Infective · Pedia** ONLY; HO is **90% of weekly VALUE**. NEVER flag or map it; ALWAYS filter before quoting a number.
- 🔒 [Lacto: family NAMES split; family_code still shared](lacto-advanced-and-basic-share-family-and-family-code.md) - `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); no bare `Lacto`. **Both keep family_code=`LA` DELIBERATELY** - the direct-order basket allow-list; tidying it un-combines the order.
- 🔴 [NEVER add units of different products/concentrations](units-of-different-products-are-never-added.md) - a unit total is valid for ONE product_code only; above that aggregate by **VALUE**. Same for TARGET units.
- 🔴 [Head Office is ABSENT from `phx_monthly_achievement`](head-office-sales-are-absent-from-phx-monthly-achievement.md) - no rows ≠ zero: it rendered real July units as 0. Royanoxicam DOES return (line NULL), Lacto Basic and Satoslim do not. `direct_value` is NOT the sales value; HO has NO price, units only.
- 🔴 Pre-July: [reconcile per customer×product](closing-reconcile-per-customer-product-not-area-pre-july.md)·[CURRENT price + backfill targets](closing-pre-july-revalue-and-backfill-targets-at-phoenix-price.md)
- 🔴 [a price fix RESTATES every published month](a-price-fix-silently-restates-every-published-closing.md) - INTENDED; drift sees VALUE now, price outside the lock. **July AI stays as published (owner).**·🔒 [the matrix can NEVER fit; summary ships BESIDE it](monthly-closing-matrix-cannot-fit.md) - leave the scroll.

## In flight
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → Yasmeena, cc B-10**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here

















Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.




























- [a manager's own visit never requires GPS or a live photo](a-managers-own-visit-never-requires-gps-or-a-live-photo.md) - owner 2026-10-20 "NO NEVER 1 OR 3 IN MANAGERS VISIST": a DM's own single visit (vacant area included) is never refused for missing GPS and never made to carry a live photo; the typed-address-or-location rule stands; never re-propose either.
- [the Recruitment rebuild: collect his instructions first, start only on his word](recruitment-rebuild-instructions-are-collected-first.md) - owner 2026-10-19 ~22:40 Cairo: retire and destroy the Recruitment workspace WITH a backup, rebuild from scratch; each instruction he sends is acknowledged and logged, never started; work begins only on "implement the full phased recruitment plan" plus plan mode.
- [employee laptops are controlled from MeshCentral on the Alienware](meshcentral-laptop-control-server-on-the-alienware.md) - self-hosted at `C:\Program Files\Open Source\MeshCentral`, admin `it.satopharma`, group Laptops; public at https://mesh.satopharma.com through the `cloudflared-mesh` Cloudflare tunnel since 19 Oct 2026, login locked to his email by Cloudflare Access with a SECOND Bypass app for `agent.ashx`/`meshrelay.ashx`/`devicefile.ashx`/`meshagents` — without it every agent is cut off. 🔴 A `lanonly` server writes `MeshServer=local` into the installer, so that agent can NEVER be reached off its own subnet — only a new installer fixes it (Yasmeena's HP EliteBook was stranded that way). Claude cannot restart Windows services here, and the cloudflared cert token cannot write Access.
- [heavy production checks wait until after 17:00 Cairo](heavy-production-checks-wait-until-after-17-cairo.md) - owner 2026-10-19: a multi-second query, parity view or temp-view check on production runs after 17:00 (or before 09:00); on 19 Oct 15:19-15:27 Cairo every Supabase call timed out in three waves while the CRM entry-days checks ran, and the failed app_error_events insert was a casualty, not the cause.
- [the Training Manager chair reports to the CEO](the-training-manager-chair-reports-to-the-ceo.md) - owner 2026-10-19: open vacancy 394, the open requisition and the offer job title all moved A-9 / Marketing Manager -> AA / Chief Executive Officer (Anwar Gaweesh); they must move together or the hire never auto-fills the vacancy; two offers sent earlier that day still say Marketing Manager / General Manager and were not edited.
- [the release gate lets Railway build while CI runs](the-release-gate-lets-railway-build-while-ci-runs.md) - owner 2026-10-19 "speed up the Railway deploy ... faster and costs less": `/api/readyz` answers 503 until ci.yml's `release-gate` job records the commit in `release_gates`; Wait for CI is OFF on BOTH the app and the worker since 20 Oct (each answers the gated /api/readyz; merges go live 6-8 min after the push, 10-18 s after CI ends); never both gates off, `PHOENIX_RELEASE_GATE=off` is the emergency word, image-in-CI refused.
- [the Hetzner CI box is retired; CI is GitHub-hosted and parallel](the-hetzner-ci-box-is-retired-ci-is-github-hosted-and-parallel.md) - owner 2026-10-19 (PR 6163): six parallel ci.yml jobs, remote-check reads the PR run, pre-push remote-check test gone, phx-live/phx-preview dead, runner deregistered; never route CI to our own machine or pitch hardware.
- [GitHub Actions status can freeze while the jobs actually run](github-actions-status-can-freeze-while-the-jobs-actually-run.md) - 2026-10-19 incident: PR checks pending 30+ min though every job log ended clean and the coverage proof read 2500 of 2500; tell a platform stall from the account by status page, job logs/artifacts, repo-wide in_progress count and start lag; never merge on logs alone.
- [the desktop app's session list is account-scoped, and that store is MSIX-virtualized](the-desktop-apps-session-list-is-account-scoped-and-msix-virtualized.md) - the sidebar lists ONE account's `local_*.json` records while the `.jsonl` conversations are shared by every account, so an unfinished session on the other account is resumable and merely unlisted; the RUNNING app holds the list in memory and only re-reads the folder at next start; and a process outside the app's MSIX container sees `%APPDATA%\Claude` as NOT EXISTING (the store is under `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\`), which is why a hard-coded path works in a session and fails from an hourly task. `~/.claude/scripts/import-account-sessions.mjs` resolves both.
- [a stale chrome-native-host.exe squats the bridge pipe](a-stale-chrome-native-host-squats-the-bridge-pipe.md) - Claude in Chrome/Edge says connected but no session reaches it: an orphaned host holds `\.\pipe\claude-mcp-browser-bridge-<user>` and every new host dies on EADDRINUSE; find the owner with GetNamedPipeServerProcessId, kill it, re-connect in the side panel; not the account, not Chrome-vs-Edge, not an app restart.
- [MeshCentral's second home is an Android phone under Termux](meshcentral-second-home-is-an-android-phone-under-termux.md) - built 19-20 Oct 2026 over an ADB cable on his word, after Oracle Cloud Always Free demanded a card: Samsung A13, Termux `apt-android-7` armeabi-v7a (32-bit phone), driven by `adb shell "cat <script> | run-as com.termux sh"` (works only because the GitHub build is a debug build); MeshCentral 1.2.5 with the laptop's own certs and db so NO agent needs reinstalling. 🔴 Its first five minutes holding `mesh.satopharma.com` ended in a Cloudflare 530 - Android SIGKILLed the detached processes while the phone stayed up 104 min - so it now runs behind a 45s keeper ON the phone and a failover watch OFF it, with the Android 12+ phantom-process reaper disabled. 🔴 A DNS change does NOT move an established agent WebSocket: the agents are still on the laptop, and `cloudflared-mesh` must not be stopped until the phone has PROVEN uptime. Read a tunnel's life with `GET /accounts/<acct>/cfd_tunnel/<id>` (status + conns_inactive_at) - no device needed; the `cert.pem` token writes DNS but is 403 on Access.
- [a MeshCentral installer behind a tunnel needs `aliasPort`, and the generic download enrols nothing](meshcentral-second-home-is-an-android-phone-under-termux.md) - 🔴 MeshCentral stamps its OWN listening port into the agent, so behind Cloudflare it built `wss://mesh.satopharma.com:4430/agent.ashx` and Cloudflare proxies only 443 - every installer made before 20 Oct 2026 22:03Z could never reach the server, the queued Action1 package for Yasmeena included. Fix is `"aliasPort": 443` in config.json settings. 🔴 And `/meshagents?id=4` carries NO MeshServer/MeshID/ServerID at all - the enrolment build needs `&meshid=<group id>&installflags=0` and is 35,888 bytes larger; verify by reading those three keys out of the binary, never with `strings`.
- [MeshCentral behind Cloudflare needs `certurl` in `domains`, and tlsOffload does not exist](meshcentral-second-home-is-an-android-phone-under-termux.md) - 🔴 Cloudflare terminates TLS, so the agent reports Cloudflare’s cert hash and the server answers `Agent bad web cert hash ... holding connection`. Fix: `"domains": { "": { "certurl": "https://mesh.satopharma.com/" } }` - lowercase, inside domains, NOT settings - after which it logs `Loaded web certificate` with the exact hash the agent reported and releases the held agents; it re-learns on its own, so Cloudflare cert rotation self-heals. 🔴 `tlsOffload`, `ignoreAgentHashCheck` and `settings.certUrl` have ZERO references in MeshCentral 1.2.5 and are not the answer; the gate is `supportsProxyCertificatesRequest`, true only when a domain has `certurl`. Pairs with `aliasPort: 443`.
- [`curl -o /dev/null` reports 0 bytes and exit 23 in Git Bash](curl-o-dev-null-reports-zero-bytes-and-exit-23-in-git-bash.md) - it intermittently fails to write the body, so every 200 WITH content reads as "0 bytes" while empty 302s look fine - the exact signature of a broken proxy. It made a healthy MeshCentral look like it served empty responses on 19 Oct 2026 and a live DNS record was rolled back on that false evidence; the same server was serving a 75,803-byte page and a 3.4 MB MZ binary. 🔴 Write the body to a real file and measure with `wc -c`/`sha256sum`; treat exit 23 as a FAILED MEASUREMENT, never as an empty response, and read a cloudflared "stream canceled by remote" as the client aborting, not the tunnel.
- [a Telegram every time a company laptop comes online](mesh-telegram-alert-when-a-laptop-comes-online.md) - owner 2026-10-20 "I WANT TO RECIEVE A TELGRAM WHENEVER HER LAPTOP IS ON AND I CAN CONTROL ... NOT ONCE ALWAYS": a watcher on the PHONE reads the `lastconnect` records MeshCentral appends to meshcentral.db (no password, no API), alerts on every node except the Alienware's own, seeds on first run, is supervised by keeper.sh and started by Termux:Boot - and is BLIND whenever the DNS failover has the address on the laptop, whose standby server now has aliasPort/certurl written but needs an elevated restart.
- [a Telegram connect link comes from getMe, not TELEGRAM_BOT_USERNAME](telegram-connect-links-read-getme-not-the-env-username.md) - the env username drives no link (the env-based `buildTelegramDeepLink()` has zero callers); it is a display label only, so production's stale `PhoenixWorkspacePilotBot` beside a `@sato_pharma_hr_bot` token was NOT the broken onboarding I reported - read the consumer before calling an env mismatch a defect; and `railway variables --set` redeploys at once, so check the serving commit is in `release_gates` first.
