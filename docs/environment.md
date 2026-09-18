# Environment Variables

All environment variables are listed in `.env.example` at the repository root. Copy it to `.env.local` for local development.

## Stable environment facts (moved from `AGENTS.md` §3)

Lookup facts about where production, staging, the schedulers and the Supabase projects live. They auto-loaded on every request as `AGENTS.md` §3 until 2026-09-12, when the body moved here to cut that file's per-request cost; §3 there keeps a short summary and the Supabase project-ref table (which `tests/supabase-project-refs.test.ts` parses). Read this before touching deploy, staging, cron, domains, the region or a Supabase project ref.

**Each line is the fact, not the evidence.** Measurements, dates, PR numbers and incident narratives
are in [docs/agents-incident-history.md](agents-incident-history.md).

- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway, no longer Cloud Run.** Railway service `phoenix-people-workforce`, project `Phoenix-HR-Workforce`, environment **`production`**, region **`europe-west4-drams3a` (Amsterdam)**, 1 replica. **If production is ever re-platformed it must stay in Europe** — colocated with the Frankfurt Supabase project and near the Cairo users. Also at `https://phoenix-people-workforce-production.up.railway.app`; Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied.
- **Do not assume "merge to `main` ships to production" — confirm the Railway `production` service source branch first.** It tracks `main` directly, but it has silently drifted before and stranded five merged, green PRs for hours with no signal. `railway status --environment production --json` returns the WHOLE project, so select by `.environments.edges[] | select(.node.name=="production")`, print the name you matched, then read `.node.serviceInstances.edges[].node.latestDeployment.meta.branch`. See `AGENTS.md` §2.3.
- **GCP is DEAD, not standby.** Billing is closed; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`. Do not "verify production" against Cloud Run.
- **The production scheduler is the third-party `cron-job.org`, and it is running, not stalled.** The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring. **Never tell the owner notifications/iReports are stalled without checking `cron-job.org` first.** **It cuts every request at 30 s, a PLATFORM cap `requestTimeout` cannot raise — but the server DOES finish the work afterwards**, so a long route logs a false `Failed (timeout)` while succeeding. ⚠ **A MID-SWEEP SNAPSHOT READS EXACTLY LIKE A TRUNCATED ONE** — read the terminal artefact (the audit row, the response body of `GET /jobs/{id}/history/{identifier}`, the final log line), never row timestamps mid-run. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for 13 days.** **A green cron and a 200 prove nothing here**, and **`attempted: 0` cannot by itself tell idle from broken — read `drainHealth` in the response body.** The head-of-line block is **FIXED** on all three drains, with a dead-man's-switch alarm behind it. **That alert is deliberately never email, and do not "fix" that back** — it fires precisely when the notification pipeline is the thing not delivering. To check the drain, run its own window query — `status in ('pending','failed')` AND `(next_attempt_at is null or next_attempt_at <= now())` ordered by `created_at` **limit 50** — and count how many of those 50 are already exhausted.
- **This repository runs FIVE GitHub Actions crons of its own, and one of them is DRIVEN BY cron-job.org rather than separate from it.** `deploy-drift-check.yml` cron every 30 min, `migration-drift-check.yml` daily 07:00 UTC, `security-scan.yml` daily 05:17 UTC — which also produces the required `secret-scan` check — `attendance-weekly-digest.yml` at 03:23 and 10:23 UTC (on Actions only because `api.cron-job.org` could not be reached when it was added — its header says to move it once that lifts), and **`synthetic-journeys.yml`**, where the `schedule:` trigger is the SMALLER half: cron-job.org's `phoenix-run-synthetic-journeys` (`0 * * * *`) calls `/api/cron/run-synthetic-journeys`, which `workflow_dispatch`es it. **24 dispatch runs/day against ~3 scheduled. So its `17 2-18/3` cron line is NOT its rate** — ~27/day is — its cadence changes in `job-schedule.ts` and cron-job.org, never in the workflow, and at ~57 min/day of wall clock **it, not deploy-drift-check, is the standing Actions cost.** Reading the workflow's own cron as its rate is the mis-diagnosis this bullet exists to stop. Count all five before adding a sixth.
- 🔴 **A `schedule:` line is a REQUEST, not a rate — GitHub starts these crons hours late and skips most of the half-hourly one.** Measured 2026-09-10 → 09-17: `deploy-drift-check.yml` started 5–7 times per Cairo day (47 in the week, against 48 a day asked for), so a stranded deploy can sit unflagged for hours; `security-scan.yml` started 4–5¼ h after 05:17 UTC every day, `migration-drift-check.yml` 4½–7 h after 07:00 UTC, and the digest's 03:23 run 4½–6 h late. **A quiet drift check is not proof production matches `main` — read `/api/healthz` `revision`.** The digest route is idempotent, so its lateness costs nothing; anything that must fire ON TIME belongs on cron-job.org, not here.
- **There IS a live Railway `staging` environment**, same project, service `phoenix-people-workforce`, at `https://phoenix-people-workforce-staging.up.railway.app`. Its service source tracks git branch `main` (not the branch named `staging`), and its `NEXT_PUBLIC_SUPABASE_URL` points at the staging Supabase project — safe as a real verification target.
- Vercel: fully legacy/decommissioned — never deploy to or verify against it.
- **Supabase project refs — the complete list `list_projects` returns.** Two of these four belong to this app; the other two do not, and are listed so an unfamiliar ref is identifiable instead of alarming.

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | `rovnkzmhokgsruftjsaw` | unrelated to this app |
  | `mlbpzvaanusdejqnimst` | the owner's personal project | eu-central-1 | **`xadcyivhxyjtehyheowl`** | unrelated — **different organization** |

  **Dead refs — treat any doc, memory, or prompt still naming one as stale:** `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`. Neither is returned by `list_projects` any more.

  **Neither region nor org is a guard** — three of the four are `eu-central-1`, and both named MCP servers see **all four**. Resolve with `list_projects` before acting (`AGENTS.md` §8).
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY`: the staging service-role key, used by `ci.yml`'s login-smoke step and both staging legs of `migration-drift-check.yml`. **There is no `preview-smoke` job** — the smoke test is a step inside `validate`.
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.

Environment meanings — **Local**: this machine or localhost. **Preview**: the deployment generated
for the current branch. **Staging**: a preview connected to the staging Supabase project.
**Production**: the public production domain and production Supabase project.

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings, or
other credentials in this file or in Git. Never assume a pasted preview URL is current.

## Required for Local Development

| Variable | Description | Example |
|---|---|---|
| NEXT_PUBLIC_SUPABASE_URL | Supabase project URL | https://xxx.supabase.co |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase anon/public key (safe for browser) | eyJhbGc... |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key (server-only, bypasses RLS) | eyJhbGc... |
| PHOENIX_AUTH_SECRET | Session signing secret (64-char hex) | (generate with openssl rand -hex 32) |

## App URLs

| Variable | Description | Default |
|---|---|---|
| APP_URL | Server-side base URL | http://localhost:3000 |
| NEXT_PUBLIC_APP_URL | Client-side base URL | http://localhost:3000 |
| NOTIFICATION_DASHBOARD_URL | URL used in notification emails | http://localhost:3000 |

## Email & Notifications

| Variable | Description | Notes |
|---|---|---|
| EMAIL_NOTIFICATIONS_ENABLED | Enable email sending | Set to "true" in production |
| PHOENIX_EMAIL_DELIVERY_MODE | Set to "testing" to redirect ALL mail to the test recipients (case-insensitive); any other value, including unset, is a no-op | Not the on/off switch (that is EMAIL_NOTIFICATIONS_ENABLED). Redirect targets PHOENIX_EMAIL_TEST_RECIPIENTS, else a fallback list |
| PHOENIX_EMAIL_TEST_RECIPIENTS | Comma-separated test emails | Redirects all emails in test mode |
| RESEND_API_KEY | Resend.com API key | Required for live email |
| NOTIFICATION_EMAIL_FROM | Sender address | e.g. Phoenix HR <noreply@domain.com> |
| NOTIFICATION_REPLY_TO | Reply-to address, and the visible To of fan-out sends | Unset in production, so `systemEmail.defaultReplyTo` (care.phx@satopharma.com) ships. Never set it to an address Resend has suppressed |
| JOB_OFFER_EMAIL_FROM | Offer email sender | Speaks as Sato, never as Phoenix. Falls back to `hr@` on the sending domain — NOT to NOTIFICATION_EMAIL_FROM |
| JOB_OFFER_REPLY_TO | Where a candidate's reply to an offer lands | Defaults to hr@satopharma.com. Must be a real, monitored mailbox |
| INTERNAL_MESSAGE_EMAIL_FROM | Internal msg sender | Falls back to NOTIFICATION_EMAIL_FROM |
| HR_NOTIFICATION_EMAILS | HR team emails for admin notifications | Comma-separated. Owner 2026-09-13: omar.anwar@satopharma.com (was the suppressed phoenix@satopharma.com, so HR copies reached nobody) |
| NOTIFICATION_TEST_MODE | Force test mode | "true" to prevent real sends |

## Google Maps (Optional)

| Variable | Description |
|---|---|
| GOOGLE_MAPS_SERVER_KEY | Server-side Maps API key (geocoding, directions) |
| NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY | Browser-side Maps API key |
| NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID | Google Maps style/map ID |

## LocationIQ (Optional)

| Variable | Description |
|---|---|
| LOCATIONIQ_API_KEY | Server-side key for `src/lib/geocoding/locationiq.ts` — first-choice (free-tier) geocoder for CRM check-in addresses and the sales normalizer's pharmacy/brick geocoding ONLY. Google (`GOOGLE_MAPS_SERVER_KEY`) is still required as the accuracy fallback for low-confidence LocationIQ matches; outstation, marketing-requests, and Routes/Directions always use Google directly and never read this key. |

## Google Calendar (Optional)

| Variable | Description |
|---|---|
| GOOGLE_CALENDAR_API_KEY | Calendar API key for national holidays |
| GOOGLE_HOLIDAY_CALENDAR_ID_EG | Egyptian holiday calendar ID |

## Interview Calendar — Zoom (Optional)

A Zoom **Server-to-Server OAuth** app, read by `src/lib/zoom/meetings.ts`. With all four set,
Phoenix creates the Zoom meeting when an interview is booked on Zoom; with any one missing, the
booking still saves and the calendar says the meeting was not made. Nothing is ever sent to the
candidate either way. Set them in Railway only — never in a committed file.

| Variable | Description |
|---|---|
| ZOOM_ACCOUNT_ID | The Zoom account the Server-to-Server OAuth app was made in |
| ZOOM_CLIENT_ID | The app's client id |
| ZOOM_CLIENT_SECRET | The app's client secret (server only) |
| ZOOM_HOST_USER | Email of the Zoom user who hosts every interview meeting |

The app needs the scopes for the three calls Phoenix makes — create a meeting for the host, move
it, and delete it when the interview is cancelled: `meeting:write:meeting:admin`,
`meeting:update:meeting:admin` and `meeting:delete:meeting:admin` (an older app with classic scopes
needs only `meeting:write:admin`). Activate the app in the Zoom Marketplace, or every token request
is refused.

## Attendance Agent (Optional)

| Variable | Description | Default |
|---|---|---|
| ATTENDANCE_AGENT_LOCAL_URL | Local agent endpoint | http://127.0.0.1:8787 |
| ATTENDANCE_AGENT_TOKEN | Shared auth token between app and agent. Also the ONLY credential on `POST /api/attendance/raw-punches` — never expose it to a browser | |
| ATTENDANCE_AGENT_BROWSER_TOKEN | Weaker token handed to the admin page so "Sync Now" can call the agent directly. Unlocks `/sync-now` only. Optional; must differ from `ATTENDANCE_AGENT_TOKEN` | |
| ATTENDANCE_AGENT_START_SCRIPT | Path to agent start script | |
| ATTENDANCE_AGENT_WORKING_DIRECTORY | Agent working directory | |
| ATTENDANCE_DEFAULT_DEVICE_ID | Default ZKTeco device ID | 1 |
| ATTENDANCE_REPORT_TIME_ZONE | Timezone for attendance reports | Africa/Cairo |

## Action1 (Optional — device custody register)

Lets **Device Custody** pull the fleet straight from Action1 instead of anybody typing a serial
number. Create the key in Action1 under **Configuration → Users & API Credentials**. Without these
the button is still there and answers with the two variable names, so nothing breaks when it is
unset — the feature is simply not connected.

The pull **registers** devices and never issues one to anybody: Action1 knows which account last
logged into a machine, which is not who signed the custody receipt for it. Re-running it only adds
machines the register does not already hold.

| Variable | Description | Default |
|---|---|---|
| ACTION1_CLIENT_ID | API key client id | |
| ACTION1_CLIENT_SECRET | API key client secret. A fleet-wide read credential — server-only, never exposed to a browser | |
| ACTION1_API_BASE_URL | Tenant API root. EU tenants are `https://app.eu.action1.com/api/3.0` | https://app.action1.com/api/3.0 |
| ACTION1_ORG_ID | Which organization's endpoints to read. Only needed when the account has more than one — with several and none set, the pull refuses and names them rather than guessing | |

## Android Management API (Optional — managed Google Play)

Lets **Managed Google Play** open Google's own store iframe inside Phoenix, where the owner approves
which apps the company tablets may run and uploads Phoenix's own app privately. Without these the
page is still there and answers with the variable name it wants, so nothing breaks when it is unset —
the feature is simply not connected.

**There are two doors and only one of them charges.** The iframe's **Private apps** page creates the
enterprise's Play developer account itself and waives the US$25 registration fee — no Play Console
account, no card, no D-U-N-S number. Signing up at the Play Console instead charges the fee and, for
an organization account, requires a D-U-N-S number that Sato Pharma has never been confirmed to have.
Use the iframe.

The enterprise is created **once**, from the page's own setup panel, and the Google account that
signs in becomes its permanent owner with no transfer path afterwards — so it must be a company
account, never a personal one. Google's return has to reach Phoenix **within an hour** of the click:
the signup name waits in a cookie that long. It was ten minutes until the first real signup
(2026-09-18) came back after twelve and a half, because Google's email-first enrolment includes a
round trip to the company mailbox.

| Variable | Description | Default |
|---|---|---|
| ANDROID_MANAGEMENT_ENTERPRISE_NAME | The binding in full, starting `enterprises/` (it looks like `enterprises/LC0123456789`). The setup panel prints it after the one-time signup; set it and restart. Everything else refuses until it is set | |
| ANDROID_MANAGEMENT_PROJECT_ID | The Google Cloud project the Android Management API is enabled on — `phoenix-hr-2026` in production. **The quota is 2 projects for the whole company**, so this is Phoenix's own, never a new one | |
| ANDROID_MANAGEMENT_ACCESS_TOKEN | A short-lived OAuth token (`gcloud auth print-access-token`) for a one-off local run. Read first, ahead of the key — **so never set it on Railway**: it would outrank the key and die within the hour | |
| ANDROID_MANAGEMENT_KEY | A service-account JSON key, base64-encoded — production's credential since 2026-09-18: `phoenix-amapi` on `phoenix-hr-2026`, holding the Android Management User role and nothing else. A fleet-wide approval credential — server-only, never exposed to a browser. The owner's Google org blocks key creation (`iam.disableServiceAccountKeyCreation`), so a rotation means lifting that block on the one project, minting, and restoring it — **the owner's own action**, never a session's | |

## Observability

`COMMIT_SHA` / `NEXT_PUBLIC_COMMIT_SHA` are the release identifier for the self-hosted
`app_error_events` table (server + client error capture — see docs/observability.md), set by the
deploy workflows from the same `$SHA_TAG` used for the Cloud Run image tag.

| Variable | Description |
|---|---|
| COMMIT_SHA | Runtime release identifier, set by the deploy workflows from the same `$SHA_TAG` used for the Cloud Run image tag. Feeds the self-hosted `app_error_events.release` field for server errors. |
| NEXT_PUBLIC_COMMIT_SHA | Build-time twin of `COMMIT_SHA`, baked into the client bundle and used as the release identifier for client-side error reports. |
| HEALTHCHECKS_PING_KEY | External cron-liveness dead-man's-switch. Set on the `phoenix-hr` **production** Cloud Run service ONLY — never staging, never local (see the Dead-Man's-Switch section below for why, and for the full variable table). |

See docs/observability.md for the full picture.

## Cloud Scheduler / Deployment

| Variable | Description |
|---|---|
| CRON_SECRET | Bearer-token auth checked against Google Cloud Scheduler job requests (see docs/deployment.md) |
| PHOENIX_PREVIEW_READ_ONLY | Legacy Vercel-preview read-only guard; inert on Cloud Run today (neither environment sets `APP_ENV=preview`) |
| VERCEL_ENV | Legacy — Vercel is decommissioned for hosting, so nothing sets this anymore; any code still branching on it is inert |

## Dead-Man's-Switch Monitoring (Optional)

External liveness alert for the 8 Cloud Scheduler jobs, independent of GCP Monitoring — see
docs/observability.md for what it catches and full setup steps.

| Variable | Description | Default |
|---|---|---|
| HEALTHCHECKS_PING_KEY | Healthchecks.io project Ping Key. Inert (no ping ever attempted, in any environment) until set. | (unset) |
| HEALTHCHECKS_PING_HOST | Override for a self-hosted Healthchecks instance | `https://hc-ping.com` |

## Live Google Sheet Token Rotation (Optional)

Three live sheets pull from Phoenix through an unauthenticated bearer token in their Apps Script.
Each can also be handed a REPLACEMENT token on a weekly cron, so a token that leaks stops being a
permanent exposure — see `docs/direct-orders-live-sheet.gs`, `docs/marketing-request-live-sheet.gs`
and `docs/cv-lifecycle-live-sheet.gs` for the sheet-side setup.

Each pair is independently optional. With either half of a pair unset that sheet's rotation route
answers 200 `{ rotated: false, reason: "not configured" }` and touches nothing, so the cron may be
scheduled before the sheet is wired up.

| Variable | Description | Default |
|---|---|---|
| SHEET_REFRESH_WEBHOOK_URL | Direct-orders sheet: the Apps Script Web App `/exec` URL | (unset) |
| SHEET_REFRESH_WEBHOOK_SECRET | Direct-orders sheet: must equal its `WEBHOOK_SECRET` script property | (unset) |
| MARKETING_SHEET_REFRESH_WEBHOOK_URL | Marketing-requests sheet: the Apps Script Web App `/exec` URL | (unset) |
| MARKETING_SHEET_REFRESH_WEBHOOK_SECRET | Marketing-requests sheet: must equal its `WEBHOOK_SECRET` script property | (unset) |
| CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL | CV-lifecycle sheet: the Apps Script Web App `/exec` URL | (unset) |
| CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET | CV-lifecycle sheet: must equal its `WEBHOOK_SECRET` script property. **No fallback** — unset means that sheet's `doPost` refuses every caller | (unset) |

The CV-lifecycle secret is the one with no fallback to the feed token, deliberately: that token
reads candidate names and phone numbers, and letting it double as the key that can REPLACE itself
would mean one leaked token kept its holder in control of where the sheet points.

## Live Google Sheet Script Push (Optional)

The three `docs/*-live-sheet.gs` files used to be REVIEW copies only. The script that actually
runs lives in Google, so merging an improvement to the repository copy changed nothing on the
sheet until somebody pasted ~2,000 lines into the Apps Script editor by hand — and a fix nobody
pastes is a fix that never shipped. `scripts/push-apps-script.mjs` closes that: it writes the
repository copy into Google, so a merged sheet fix reaches the sheet like any other deploy.

Each sheet is connected independently. **A target whose script id is unset is skipped, and the
run still succeeds** — the same shape as the token rotation above, so nothing has to be wired up
in a particular order. With no script id set at all the pusher prints what it would need and
exits 0.

| Variable | Description | Default |
|---|---|---|
| GOOGLE_APPS_SCRIPT_CLIENT_ID | OAuth client (type "Desktop app") for the Apps Script API | (unset) |
| GOOGLE_APPS_SCRIPT_CLIENT_SECRET | That client's secret | (unset) |
| GOOGLE_APPS_SCRIPT_REFRESH_TOKEN | Long-lived grant from the sheets' owner. Issued by `scripts/apps-script-authorize.mjs`; scope `script.projects` and nothing wider | (unset) |
| CV_LIFECYCLE_APPS_SCRIPT_ID | CV-lifecycle sheet: Extensions to Apps Script to Project Settings to Script ID | (unset) |
| DIRECT_ORDERS_APPS_SCRIPT_ID | Direct-orders sheet: same place | (unset) |
| MARKETING_REQUESTS_APPS_SCRIPT_ID | Marketing-requests sheet: same place | (unset) |

These are GitHub Actions secrets, not Railway variables — the push happens in CI, not in the
running app. `scripts/apps-script-authorize.mjs` performs the one-time consent and stores all
three OAuth values with `gh secret set`, piped through stdin so no credential ever reaches a
command line (a permission allow-rule in this repo stores the literal command).

### What actually runs the push

`.github/workflows/apps-script-push.yml`. It fires on a push to `main` that touches
`docs/*-live-sheet.gs`, the pusher, or the manifest — path-filtered so the repository's ordinary
~30 commits a day cost nothing — and can also be dispatched by hand, with `check_only` for a dry
run or `only` for a single sheet.

**That workflow is the only place the credentials can be read.** GitHub Actions secrets are
write-only, and the last local copy of `GOOGLE_APPS_SCRIPT_CLIENT_SECRET` was lost with a removed
worktree on 2026-09-05. So deleting the workflow does not merely disable an automation — it makes
`scripts/push-apps-script.mjs` unrunnable anywhere until somebody mints a replacement client secret
in Google Cloud, and Google allows only **two per client**, so a third requires disabling and
deleting one of the existing pair first.

Two details in it are deliberate and should not be tidied away. It runs **no `pnpm install`**: the
pusher uses only Node built-ins, so an install would be the slowest, most fragile step in a job that
otherwise takes seconds, and it would add a lockfile's worth of supply chain to a job holding Google
credentials. And it is **serialised** (`concurrency`, `cancel-in-progress: false`) because
`projects.updateContent` replaces every file in a project: two overlapping runs would each send a
whole file list and the loser would silently undo the winner, and a cancelled run that has already
sent its request has still written.

There is no `pull_request` leg, on purpose. Actions minutes are a real cost constraint here, and a
PR run would either need the Google credentials on unmerged code or report nothing useful. Dispatch
the workflow with `check_only` when you want to see a diff before merging.

### Finding a sheet's script id, and proving it is the right one

All three sheets were connected on 2026-09-05. If a fourth is ever added, or an id has to be
recovered, two things about that hunt are worth not repeating.

**Do not identify a project by its name.** Only one of the three carries a recognisable one. The
marketing project is "Phoenix Marketing Sheet"; the direct-orders project is literally "Untitled
project". Match it instead by hashing the project's `FEED_TOKEN` script property and comparing that
against the live share token in Phoenix — `select left(encode(sha256(token::bytea),'hex'),16) from
<report>_share_links where surface = 'feed' and revoked_at is null`. That is a proof of identity, not
an inference from a label, and it never puts either token on screen.

**The direct-orders project is not in this account's project list at all.** It is owned by a
different Google account and only shared, so it appears under **Shared with me** at
`script.google.com/home/shared`, not `/home/my`. That matters beyond finding it: the OAuth grant is
`achieverrr303@gmail.com`'s, so writing that project depends on the sharing carrying edit rights. It
does — proven by an actual push on 2026-09-05 — but a permission error there means the sharing, not
the credentials.

The script id itself is not in the page text on either listing; it sits in the row markup beside the
container (spreadsheet) id, so a row's 57-character id is the script and the 44-character one is the
sheet it is bound to.

A service account cannot be used here. Apps Script projects belong to a PERSON, and
`projects.updateContent` acts as the signed-in user, so the grant has to come from the account
that owns the sheets.

Running the one-time consent:

```bash
node scripts/apps-script-authorize.mjs --client-file ~/Downloads/client_secret_....json
```

`--client-file` points at the JSON Google offers at the moment the OAuth client is created, and it
is the preferred route for a reason that is not convenience: **Google shows a client secret exactly
once** and no longer allows viewing or downloading it afterwards, so the alternative is copying the
value by hand, through a clipboard or a chat window or a shell command, each of which leaves a copy
behind. Reading Google's own file means the secret goes from disk into one HTTPS request and
nowhere else. Dismissing that dialog is not fatal but it is not free either: the only way back is
to add a SECOND secret to the same client.

Two further flags exist for re-running it:

- `--write-env-local` additionally writes the three values into `.env.local`, which is gitignored.
  Actions secrets are **write-only** — once stored, nothing can read them back — so a run that only
  stores them proves the storing and nothing else. A local copy is what makes
  `node --env-file=.env.local scripts/push-apps-script.mjs --check` runnable, and therefore what
  makes the whole setup verifiable before CI is ever trusted with it. That file also holds
  production credentials, so the write carries through every line it is not setting, refuses if it
  would drop more lines than the keys it is adding, and lands via a rename so an interrupted write
  cannot leave half a file behind.
- `--reuse-consent` drops `prompt=consent`, so an account that has already approved is not asked to
  approve the same scope again. Google only guarantees a refresh token on the FIRST approval, so
  the run still **fails loudly** when none comes back, rather than storing nothing and reporting
  success.

One setting outside this repository decides whether the grant survives: the OAuth consent screen's
publishing status. While it reads **Testing**, Google expires every refresh token after 7 days, so
the push would work for a week and then start failing with `invalid_grant` for no visible reason.
**In production** has no such expiry. Check it before wondering why a working setup stopped.

The API this uses REPLACES every file in a project — there is no per-file write. So the pusher
reads the project first and sends every existing file back with only the managed one swapped, and
refuses outright if the project reads back empty or if the file named in
`scripts/apps-script-manifest.mjs` is not there. `tests/apps-script-push.test.ts` pins both
refusals, proves `appsscript.json` survives an update, and fails if a new `docs/*-live-sheet.gs`
is added without a manifest entry — which would otherwise leave that sheet silently manual.

## Dev-Only Variables

These should never be set in production.

| Variable | Description |
|---|---|
| PHOENIX_ENABLE_DEV_AUTH_HEADERS | Allow x-phoenix-role/x-phoenix-hr-id headers in dev |
| PHOENIX_PORTAL_SHOW_BETA_NAV | Show beta navigation items in employee portal |

## Business Rule Overrides

| Variable | Description | Default |
|---|---|---|
| PHOENIX_MONTHLY_EXCUSE_ALLOWANCE | Max excuses per employee per month | 2 |
| PHOENIX_PERMISSION_MATRIX_CACHE_SECONDS | Permission matrix cache TTL | 30 |

## GitHub Actions Secrets & Variables

Secrets flow **GitHub → Railway production** automatically: `.github/workflows/sync-railway-production-secrets.yml`
runs `scripts/sync-railway-production-secrets.mjs` (push a value) then `scripts/validate-railway-production-secrets.mjs`
(confirm it landed) on every push touching either file, or on manual dispatch. Most of the list below
only needs setting once, in GitHub — Railway picks it up from there. A number of Railway variables are
not yet mirrored to GitHub at all (no automated backup if Railway ever lost them); the sync script's own
`variables` array is the authoritative, current list of what's actually covered — treat this doc as a
map, not the source of truth for that.

**GitHub secrets AND variables both exist for the same 4 public values** (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL`) —
intentionally left duplicated: `ci.yml`'s synthetic-journey-ingest and full-e2e steps read the secret
copies directly with no variable fallback, so deleting the secret copies would silently break both.

### Core platform & auth
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_SUPABASE_URL | Supabase project URL (also a GitHub variable) |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase anon/public key (also a GitHub variable) |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | Modern publishable key (also a GitHub variable) |
| SUPABASE_SERVICE_ROLE_KEY | Production service-role key — canonical, preferred by the Railway sync |
| STAGING_SUPABASE_SERVICE_ROLE_KEY | Staging service-role key — the login smoke test step in `ci.yml`'s `validate` job + both of `migration-drift-check.yml`'s staging legs |
| PRODUCTION_SUPABASE_SERVICE_ROLE_KEY | Used ONLY by `migration-drift-check.yml`'s production leg — intentionally a separate secret from `SUPABASE_SERVICE_ROLE_KEY` (see that workflow's comment); never reaches Railway |
| PHOENIX_STAGING_DATABASE_URL | Staging Postgres connection string — used ONLY by `staging-migrate.yml`, which applies missing migrations to staging on every merge to `main`. Must be the **Session pooler** URI (`postgres.<ref>@aws-0-<region>.pooler.supabase.com`): a direct `db.<ref>.supabase.co` host is IPv6-only and GitHub runners have no IPv6. Without it that workflow applies nothing and emits a `::warning::` |
| PHOENIX_AUTH_SECRET | Session signing secret |

### App URLs
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_APP_URL | Client-side base URL (also a GitHub variable) |

### Email & notifications
| Secret | Purpose |
|---|---|
| RESEND_API_KEY | Primary email provider |
| RESEND_WEBHOOK_SECRET | Verifies inbound Resend delivery webhooks |
| NOTIFICATION_WEBHOOK_SECRET | Verifies inbound Telegram webhook calls (`secret_token`) |
| TELEGRAM_BOT_TOKEN | Telegram Bot API token |
| NEXT_PUBLIC_ONESIGNAL_APP_ID | OneSignal app id (client-side) |
| ONESIGNAL_REST_API_KEY | OneSignal REST API key (server-side push) |

### Scheduling & agents
| Secret | Purpose |
|---|---|
| CRON_SECRET | Bearer-token auth for cron-job.org's calls into `/api/cron/*` |
| FTP_VIDEO_HANDOFF_SECRET | Bearer token the Future Talents Portal sends to `/api/integrations/ftp-videos` to list and claim WhatsApp closing videos. Its own token, deliberately never `CRON_SECRET`; unset means the route refuses every call. The portal holds the same value as `PHOENIX_VIDEO_RELAY_SECRET` |

### Maps & geo
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY | Browser-side Maps API key |
| NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID | Google Maps style/map ID |

### AI
| Secret | Purpose |
|---|---|
| OPENAI_API_KEY | AI-assist features (email drafting, SoS normalizer suggestions) |

### Feature flags
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_SMI_USE_FACT_TABLES | Sales-marketing-intelligence fact-table toggle |

### Infra & ops
| Secret | Purpose |
|---|---|
| RAILWAY_TOKEN | Auth for `sync-railway-production-secrets.yml`'s Railway CLI calls |
| CLOUDFLARE_API_TOKEN | Not currently consumed by any workflow or app code — held for future Cloudflare DNS/cache automation |
| SENTRY_AUTH_TOKEN | Build-time only — sourcemap upload for the Sentry Next.js plugin, never read at runtime |

### CI / testing
| Secret | Purpose |
|---|---|
| PLAYWRIGHT_DATA_USER_HRID | Data-bearing E2E test account HR ID |
| PLAYWRIGHT_DATA_USER_PASSWORD | Data-bearing E2E test account password |
| SYNTHETIC_ADMIN_HR_ID | Synthetic-journey monitoring account |
| SYNTHETIC_ADMIN_PASSWORD | Synthetic-journey monitoring account |

### Orphaned — flagged for removal
| Secret | Purpose |
|---|---|
| WIF_PROVIDER | GCP Workload Identity Federation — authenticated the now-`workflow_dispatch`-only Cloud Run deploy workflows. GCP billing closed 2026-08-01; safe to delete. |
| WIF_SERVICE_ACCOUNT | Same as above. |

### GitHub variables (non-secret)
`APP_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `RAILWAY_PROJECT_ID`,
`RAILWAY_SERVICE_NAME`, `SUPABASE_PROJECT_ID` — all verified matching their Railway counterparts.

Optional for full E2E:
- PLAYWRIGHT_DATA_USER_HRID
- PLAYWRIGHT_DATA_USER_PASSWORD
