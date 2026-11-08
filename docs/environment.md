# Environment Variables

All environment variables are listed in `.env.example` at the repository root. Copy it to `.env.local` for local development.

## Stable environment facts (moved from `AGENTS.md` §3)

Lookup facts about where production, staging, the schedulers and the Supabase projects live. They auto-loaded on every request as `AGENTS.md` §3 until 2026-09-12, when the body moved here to cut that file's per-request cost; §3 there keeps a short summary and the Supabase project-ref table (which `tests/supabase-project-refs.test.ts` parses). Read this before touching deploy, staging, cron, domains, the region or a Supabase project ref.

**Each line is the fact, not the evidence.** Measurements, dates, PR numbers and incident narratives
are in [docs/agents-incident-history.md](agents-incident-history.md).

- 🔴 **The repository is `sato-pharma/phoenix-people-workforce`, an ORGANIZATION, since 2026-11-06 about 02:00 Cairo** (his "migrate the project to the trail enterprise"). A transfer, not a re-push: PR numbers, history, all 81 secrets, the variables, the 3 environments and the self-hosted runners came across; the ghcr images did not. Only this repository moved — `hmdm-android` and `Sato-Pharma-Website` stay on the personal account `Omar-3-xx` (`PERSONAL_OWNER` in `scripts/required-check-names.mjs`). Railway needed its GitHub app installed on `sato-pharma` and every source and trigger re-pointed (done the same night). An organization's Actions billing is read under `organizations/`, never `users/`.
- 🔴 **The repository moved again to `Omar-3-xx/phoenix-people-workforce` on the owner's word (2026-11-04), after GitHub suspended `gawishtheit` as well.** That move carried the same losses as the one below: PR numbers restart, and PR pages, CI history, ghcr images, repository settings and secret values do not come across. Docs that name an older account describe history.
- 🔴 **The repository moved to `gawishtheit/phoenix-people-workforce` on the owner's word (2026-11-02), after GitHub suspended `it-gawish-hr`.** Old PR numbers, their comments, CI history and the ghcr images stayed behind and are unreachable while that suspension holds. The tablet launcher's release assets are still on `it-gawish-hr/hmdm-android` (`infra/headwind-phoenix-actions/phoenix-entrypoint.sh`); a failed fetch logs and the server still boots. Railway's source moves only on his separate word. Docs below that name the old account describe history.
- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway, no longer Cloud Run.** Railway service `phoenix-people-workforce`, project `Phoenix-HR-Workforce`, environment **`production`**, region **`europe-west4-drams3a` (Amsterdam)**, 1 replica. **If production is ever re-platformed it must stay in Europe** — colocated with the Frankfurt Supabase project and near the Cairo users. Also at `https://phoenix-people-workforce-production.up.railway.app`; Cloudflare holds `CNAME phoenix-hr -> phoenix-people-workforce-production.up.railway.app`, **unproxied**, TTL 60 (since 2026-10-31 20:36 Cairo, owner). Before that it was `xok6ir4p.up.railway.app` (Railway edge 69.46.46.36, which dropped about one in six Egyptian connections), behind Cloudflare's proxy from 2026-10-27 12:25 — and Vodafone home broadband (AS24835) silently drops traffic to Cloudflare's addresses, so a Medical Rep could not open Phoenix on her home wifi. 🔴 Never re-enable the proxy or repoint at `xok6ir4p` without the owner (`docs/deployment.md`, "Production Verification").
- **Do not assume "merge to `main` ships to production" — confirm the Railway `production` service source branch first.** It tracks `main` directly, but it has silently drifted before and stranded five merged, green PRs for hours with no signal. `railway status --environment production --json` returns the WHOLE project, so select by `.environments.edges[] | select(.node.name=="production")`, print the name you matched, then read `.node.serviceInstances.edges[].node.latestDeployment.meta.branch`. See `AGENTS.md` §2.3.
- **GCP is DEAD, not standby.** Billing is closed; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`. Do not "verify production" against Cloud Run.
- **The production scheduler is the third-party `cron-job.org`, and it is running, not stalled.** The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring. **Never tell the owner notifications/iReports are stalled without checking `cron-job.org` first.** **It cuts every request at 30 s, a PLATFORM cap `requestTimeout` cannot raise — but the server DOES finish the work afterwards**, so a long route logs a false `Failed (timeout)` while succeeding. ⚠ **A MID-SWEEP SNAPSHOT READS EXACTLY LIKE A TRUNCATED ONE** — read the terminal artefact (the audit row, the response body of `GET /jobs/{id}/history/{identifier}`, the final log line), never row timestamps mid-run. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for 13 days.** **A green cron and a 200 prove nothing here**, and **`attempted: 0` cannot by itself tell idle from broken — read `drainHealth` in the response body.** The head-of-line block is **FIXED** on all three drains, with a dead-man's-switch alarm behind it. **That alert is deliberately never email, and do not "fix" that back** — it fires precisely when the notification pipeline is the thing not delivering. To check the drain, run its own window query — `status in ('pending','failed')` AND `(next_attempt_at is null or next_attempt_at <= now())` ordered by `created_at` **limit 50** — and count how many of those 50 are already exhausted.
- **This repository runs SIX GitHub Actions crons of its own, and one of them is DRIVEN BY cron-job.org rather than separate from it.** 🔴 **Six since 2026-09-30, when `secret-drift-check.yml` was added at 06:41 UTC** — the production secret validator had no schedule at all, and its only caller was path-filtered to two files, so the one moment it mattered (a rotation, which changes no file) was the one moment nothing ran it. 🔴 **Since 2026-10-01 that workflow does TWO things and is named `Configuration Drift Check` for it** — it also compares AGENTS.md §2's required-check declaration against live branch protection. `scripts/check-required-checks.mjs` previously surfaced only through `repo-doctor.mjs`, which **skips that very comparison under the `--no-auth` flag sessions are told to pass**, so the one tool guarding a list that has rotted five times ran only when a human remembered it *without* that flag. Both halves share the property that put them in one file: **a secret rotation and a branch-protection edit each change NO file**, so nothing path-filtered or gated on a diff can ever see either. Like every alarm here it reports a finding and concludes GREEN, because a red scheduled suite withholds the production deploy of whatever commit is `main` HEAD when it fires. Then `deploy-drift-check.yml` cron every 30 min, `migration-drift-check.yml` daily 07:00 UTC — 🔴 **the one alarm that goes RED on a finding again since 2026-10-23 (owner: "make the Migration Drift Check go red again when its checks fail")**, safe because Railway Wait-for-CI is off and the release gate reads only `validate` + `checks`; `tests/scheduled-alarms-never-withhold.test.ts` pins that precondition — `security-scan.yml` daily 20:17 UTC (moved from 05:17 on 2026-10-16 so its late start misses the day's merges) — 🔴 **which is now its ONLY trigger: the `pull_request` one was removed on 2026-09-29 and `secret-scan` is no longer a required check, so this scheduled run is the whole of it** — `attendance-weekly-digest.yml` at 03:23 and 10:23 UTC (on Actions only because `api.cron-job.org` could not be reached when it was added — its header says to move it once that lifts), and **`synthetic-journeys.yml`**, which has NO `schedule:` trigger of its own since 2026-10-14 (owner, cost cuts): cron-job.org's `phoenix-run-synthetic-journeys` (`17 5,8,11,14,17,20 * * *`, Africa/Cairo) calls `/api/cron/run-synthetic-journeys`, which `workflow_dispatch`es it **6 times a day** — it was ~27 (24 hourly dispatches plus ~3 from its own `schedule:` leg, the standing Actions cost at ~79 billable minutes a day on 13 Oct). Its cadence changes in `job-schedule.ts` and cron-job.org, never in the workflow, and `tests/scheduled-alarms-never-withhold.test.ts` fails if a `schedule:` block comes back. That leaves five GitHub-scheduled workflows in this list (it said six); recount against `.github/workflows/` before adding another. 🔴 **Recounted 2026-10-27: SEVEN carry a `schedule:` block** — the five above plus `origin-certificate-check.yml` (daily 05:17 UTC) and `staging-hr-drift-check.yml` (daily 05:00 UTC), which this line never listed. `deploy-drift-check.yml` is 48 of the 55 runs a day they ask for, and the digest 2; with the 6 synthetic-journey dispatches that is 61, and `tests/github-workflow-validity.test.ts` pins each one by name and caps the total at 61 a day, so a new cron or a tighter one fails CI until that ceiling and its cost note are raised on purpose.
- 🔴 **A `schedule:` line is a REQUEST, not a rate — GitHub starts these crons hours late and skips most of the half-hourly one.** Measured 2026-09-10 → 09-17: `deploy-drift-check.yml` started 5–7 times per Cairo day (47 in the week, against 48 a day asked for), so a stranded deploy can sit unflagged for hours; `security-scan.yml` started 4–5¼ h after 05:17 UTC every day, `migration-drift-check.yml` 4½–7 h after 07:00 UTC, and the digest's 03:23 run 4½–6 h late. **A quiet drift check is not proof production matches `main` — read `/api/healthz` `revision`.** The digest route is idempotent, so its lateness costs nothing; anything that must fire ON TIME belongs on cron-job.org, not here.
- 🔴 **STAGING RUNS AGAIN — the stop below is HISTORY.** Its deploy trigger was recreated on 2026-10-23 (`tests/railway-deploy-triggers.test.ts`, and the scheduled `check-railway-deploy-triggers.mjs` reads it every day), and on 2026-10-27 the account move repointed it to `it-gawish-hr/phoenix-people-workforce`; the 13:33 Cairo merge of #6586 deployed it with production. Read it live (`/api/healthz` on the staging domain) before calling it up or down.
- **(History, 2026-10-14 to 10-23.) The Railway `staging` APP WAS STOPPED (owner, 2026-10-14, cost cuts) — the environment and the staging Supabase project remain.** Service `phoenix-people-workforce` in `staging` had its only deploy trigger (GitHub, branch `main`, trigger id `c5379d4d-554c-423f-a047-ad54346aced4`, check suites OFF) deleted and its running deployment removed, so a merge no longer builds it and `https://phoenix-people-workforce-staging.up.railway.app` answers 404. It served about 1 request an hour at ~275 MB. **A replica count of 0 is not possible here:** `railway service scale <region>=0` only removes that region's entry and Railway puts back 1 replica in `us-west2`, so the stop is the trigger plus the removed deployment. **To bring it back:** create a GitHub deploy trigger on `main` for that service in `staging` (`deploymentTriggerCreate`) and run `railway up`/redeploy; it will not be gated on CI. Its `NEXT_PUBLIC_SUPABASE_URL` still points at the staging Supabase project. Do not set `STAGING_TRACKS_BRANCH`; Staging Branch Sync is deleted.
- Vercel: fully legacy/decommissioned — never deploy to or verify against it.
- **Supabase project refs — the complete list `list_projects` returns.** Two of these three belong to this app; the third does not, and is listed so an unfamiliar ref is identifiable instead of alarming.

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | **`tvweawmrjrekvepkcxzs`** | unrelated to this app — **different organization** |

  **Dead refs — treat any doc, memory, or prompt still naming one as stale:** `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`. Neither is returned by `list_projects` any more.

  **Neither region nor org is a guard** — two of the three are `eu-central-1`, and `supabase-production` sees **all three**. Resolve with `list_projects` before acting (`AGENTS.md` §8).
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY`: the staging service-role key, used by `ci.yml`'s login-smoke step and both staging legs of `migration-drift-check.yml`. **There is no `preview-smoke` job** — the smoke test is a step inside `validate`.
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.
- **The production database host is a Supabase Small — 2 shared cores, 1,932 MB — and the host, not Postgres, is the saturated part.** `src/lib/observability/db-host-sampler.ts` writes one `db_host` line a minute from the worker (`railway logs <deployment-id> -s phoenix-workforce-worker -e production -d --lines 5000 | grep db_host`). Measured 1 Nov 2026, 20:00–20:11 Cairo, a quiet Sunday evening of ~25 users: CPU user 41–76 %, idle 20–57 %, load 2.0–3.0, 291–829 MB free, 191–483 MB swap in use; the 10:30–11:00 peak that morning carried 36,104 Supabase requests in half an hour at a median of ~450 ms each for 2–7 ms of SQL. The compute tier is decided on the Supabase dashboard (Project → Settings → Compute and Disk), never in chat. Account: `docs/performance-engineering-standards.md`, "The speed root cause".

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
| JOB_OFFER_EMAIL_FROM | Offer email sender | Speaks as Sato, never as Phoenix. 🔴 **Only `hr@satopharma.com` or `hr@send.satopharma.com`** (owner, 2026-10-13); any other mailbox is refused in `src/lib/email/job-offer-sender.ts`, the send falls back to `hr@satopharma.com` and the Job Offers screen names the refused value. NOT NOTIFICATION_EMAIL_FROM. The same list stops a backup provider account rewriting an offer's From — such an account declines the offer instead, so it waits for Resend's first account (the only one holding both Sato domains, measured 2026-10-13) |
| JOB_OFFER_REPLY_TO | Where a candidate's reply to an offer lands | Unset in production, so the code default `hr@satopharma.com, omar.anwar@satopharma.com` ships (owner 2026-09-23 — a reply reaches HR and the owner). 🔴 **The owner's own mailbox is APPENDED whenever this value does not already name it** (owner, 2026-10-13: "make sure if candidate replies the email reaches me") — this variable can add reply targets and reorder them, never remove him. May name several mailboxes, comma-separated. Every one must be a real, monitored mailbox. An address on the sending-only host `send.satopharma.com` (no mailboxes, SES bounce MX) is rewritten to the apex in code (`src/lib/email/receivable-address.ts`), each address independently, as is the offer From |
| JOB_OFFER_SMTP_APP_PASSWORD | App password of the `hr@satopharma.com` Turbify mailbox — job offers go through the real hr@ mailbox | Owner, 2026-11-06. **Set, every offer email (letter, resend, expiry notice) leaves through Turbify SMTP (`smtp.bizmail.yahoo.com:465`, the business server — Yahoo's consumer `smtp.mail.yahoo.com` refused both offers of 8 Nov 2026 with reply 550) signed in as hr@**, From `hr@satopharma.com` with the offer's display name, subject, body, attachments, Reply-To, To and CC unchanged, and the same bytes are filed in hr@'s Sent folder (a failed Sent copy is logged, never a resend). Recorded in `email_delivery_events` under provider `turbify`; the admin Telegram mirror still fires. 🔴 **A Turbify failure fails the send — it never falls back to Resend.** Why: 112 offers sent through Resend in 35 days drew 0 opens — Yahoo junks the company's own apex address arriving from Amazon SES. Blank or unset keeps the ordinary provider chain. Spaces pasted from Turbify are stripped. Code: `src/lib/email/job-offer-smtp.ts`. Optional in the secret sync |
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

## Headwind MDM + RustDesk (Optional — the company's own rep-tablet server)

Lets **Rep Tablets** drive the fleet from the company's own Headwind MDM server instead of a vendor,
and opens a free remote-screen session on a tablet through the company's own RustDesk relay. Full
account, including how the server is built and how a tablet moves onto it:
[docs/devices/headwind-rustdesk.md](devices/headwind-rustdesk.md).

🔒 **THE WHOLE SECTION SHIPS DARK.** With `HEADWIND_MDM_*` unset, the Headwind card does not render
at all and no route reaches out — `/devices/tablets` says the tablet server is not connected in this
environment. That is deliberate: the bridge merges to production before the server exists, and the owner
turns it on by setting these variables once the box is up.

🔴 **It runs on RAILWAY, and no box is rented — corrected 2026-09-27; this paragraph used to say
"one small dedicated VPS, about $5–6/month".** Since 2026-09-25, at the owner's instruction, Headwind
is the `phoenix-headwind` service in the existing Phoenix project, with its own `headwind-db-eu`
Postgres. 🔴 **The region is NOT inherited — this paragraph claimed it was, and that was false.** A new
Railway service in this account is created in `sfo`, so both Headwind services ran in the United States
from 2026-09-25 until they were moved to `europe-west4-drams3a` on 2026-09-28 at the owner's instruction
(426 ms → ~245 ms, level with `phoenix-hr.satopharma.com`). The `sfo` database `headwind-db` was deleted
the same night once the move was verified, so **`headwind-db-eu` is the only Headwind database** and
`postgres.railway.internal` no longer resolves to anything. Nothing holds a new service in Europe by
itself, so §3's "it must stay in Europe" needs an explicit
`railway service scale europe-west4-drams3a=1 <old-region>=0` and a re-read. The VPS plan was dropped after an
evening across three providers: **Hetzner's verification refuses Egyptian customers and takes no
PayPal**, and OVH split the account across two regions that do not share a sign-in. Do not go
looking for that box, and do not propose renting one.

**What Railway genuinely cannot host is the RustDesk relay.** Its ID server needs fixed raw TCP
*and* UDP ports (21115–21119, plus 21116 UDP) with the real client addresses visible, and Railway
allows one TCP proxy port per service and no UDP at all. So the company uses RustDesk's **own free
EU relay** — NaCl end-to-end encrypted, so it carries ciphertext it cannot read — and
`docker-compose.headwind.yml` is kept, unchanged and ready, for the day owning the relay matters
(an SLA and custody, never secrecy). The original concern that a device-management server "does not
belong beside the payroll database" is answered by `headwind-db-eu` being its own Postgres service, not
the Supabase project.

🔴 **THE BOX MUST RUN THE PHOENIX-BUILT IMAGE, NOT THE STOCK `headwind/hmdm` ONE — there is no
variable for this and no error that says it.** Lock, lost mode, factory reset and reset-the-screen-lock
are carried by a small Apache-2.0 `SyncResponseHook` add-on of ours (`infra/headwind-phoenix-actions/`,
built in by the Dockerfile that extends the pinned `HEADWIND_IMAGE_TAG`). The **tablets** already obey
all five fields as shipped; the stock free **server** has no way to set them, so on a stock image those
four routes answer a Headwind refusal and the console reports it faithfully — which reads like a broken
tablet rather than the wrong image. Everything else on this page works on either image.

| Variable | Description | Default |
|---|---|---|
| HEADWIND_MDM_BASE_URL | ✅ **Set 2026-09-26 to `https://mdm.satopharma.com`** — the tablets' own hostname, deliberately. **Two earlier claims in this row were wrong and are corrected:** there is no Cloudflare Tunnel (the server runs on Railway, which terminates TLS itself), the port is 8080 and not 31000, and pointing this at the tablets' name does **not** "put the API back on the public internet" — one Tomcat serves `/rest/*` on **every** hostname aimed at the service, and `mdm` must stay open with no Access or the fleet goes dark, so the private REST surface is on a public name whatever this says. What the choice actually decides is coupling: `mdm` can never have Access on it, so Phoenix never needs a service token; `mdm-console` would break Phoenix the moment Access goes on. `http://phoenix-headwind.railway.internal:8080` is a possible upgrade that keeps the traffic inside Railway, but it rests on an IPv6-only network nobody has yet watched this container resolve — see the runbook §4.6. No trailing slash — one is trimmed either way. Nothing here has a safe default: a guessed address would send an admin password to whoever owns that name | |
| HEADWIND_MDM_LOGIN | An admin login on that server. Give Phoenix its own account, not a person's, so the audit trail on the Headwind side reads as "Phoenix" — it is `phoenix` (read live off both Fly services, 2026-10-22; `admin` is the human console login). Headwind's own 2FA is **unavailable** in this build (its console UI is hard-disabled upstream) and would not affect this account anyway: it is server-wide (`settings.twoFactor`, no per-account toggle) and read only by the console's browser login, while `/rest/public/jwt/login` never consults it — runbook §4.7 | |
| HEADWIND_MDM_PASSWORD | That account's password, **in plain text here**. 🔴 Phoenix MD5-hashes it before sending, because that is Headwind's wire format — do not pre-hash it yourself, and never "upgrade" the hash: the server would refuse every sign-in. A Headwind admin password factory-resets tablets — server-only, never exposed to a browser, never logged | |
| HEADWIND_MDM_ACCESS_CLIENT_ID | The Cloudflare Access **service token** id, when the console is behind a Cloudflare Tunnel — which it is, by the owner's decision of 2026-09-25. 🔴 **Not because Headwind lacks two-factor code — it has it, but its console UI is hard-disabled in this build, so Access is the console's ONLY second factor** (corrected 2026-10-22, runbook §4.7); the console otherwise sits on the public internet behind one password that factory-resets tablets. 🔴 Access asks a *person* to sign in and Phoenix is not one: without this, every Phoenix call is answered by Cloudflare's own sign-in page and the bridge goes dark against a perfectly healthy server. Sent as the `CF-Access-Client-Id` header | |
| HEADWIND_MDM_ACCESS_CLIENT_SECRET | That token's secret, sent as `CF-Access-Client-Secret`. **Both or neither** — one alone is refused by name before any call goes out, because Cloudflare would answer HTML and the failure would then read as a wrong Headwind password. Cloudflare shows it once, at creation; server-only, never logged. Leave both unset for a server with no tunnel | |
| RUSTDESK_RELAY_HOST | 🔴 **Leave empty — empty is the working setting.** Empty means RustDesk's own free EU relay, which is what this fleet uses since 2026-09-25 (owner's decision): screen view and control work with no server at all, because RustDesk is NaCl end-to-end encrypted and a relay carries ciphertext it cannot read. Fill it in only if the company later runs its own `hbbs` from `docker-compose.headwind.yml`, e.g. `relay.satopharma.com` | *(public relay)* |
| RUSTDESK_PUBLIC_KEY | That self-hosted relay's public key, from `rustdesk-data/id_ed25519.pub` on the box. **Public by design** — the app needs it to verify the relay — and the matching *private* key never leaves the server. 🔴 **Both or neither:** one alone is refused by name and turns the screen buttons off, because a client pointed at a private relay it cannot verify does not fail loudly, it quietly connects elsewhere | *(public relay)* |
| RUSTDESK_APP_PACKAGE | The Android package the remote-screen app installs under. Only set it if a rebuilt client changes the package | com.carriez.flutter_hbb |

🔴 **The screen-session password is NOT here and must never be.** Phoenix builds a connect target —
which tablet, which relay, the public key — and stops. The person types the tablet's access password
into the RustDesk app themselves, or the tablet is set up for unattended access. RustDesk's link
scheme accepts a password in the query string; a URL is logged by browsers, proxies and anything that
touches it, and a tablet's permanent password in a log is a tablet anybody can drive.

🔴 **A tablet's RustDesk ID lives in Headwind, not in a Phoenix table** — in each device's first
custom field. One place to look, and nothing to keep in step when a tablet is re-enrolled.

**The server's own settings are a different file.** `ADMIN_EMAIL`, `BASE_DOMAIN`, `SQL_*` and the
pinned image tags belong in `.env.headwind` **on the box**, beside
[`docker-compose.headwind.yml`](../docker-compose.headwind.yml); `.env.headwind.example` documents
them. Nothing in that file is a Phoenix variable and none of it goes on Railway.

## Observability

🔴 **`COMMIT_SHA` is the only release identifier, and it is NOT set by a deploy workflow** — that was
the Cloud Run pipeline, which is dead. What identifies a release is `getDeployRevision()` in
`src/lib/observability/deploy-identity.ts`, reading `COMMIT_SHA || RAILWAY_GIT_COMMIT_SHA ||
K_REVISION` — the non-prefixed one, server-side.

🔴 **`NEXT_PUBLIC_COMMIT_SHA` NO LONGER EXISTS ANYWHERE, and re-adding it would tag nothing.** It was
a `Dockerfile` build ARG, declared and re-exported, read by **zero** call sites across `src/`, `app/`
and `lib/`, under a comment claiming it tagged which revision a client error came from — which it
never did. Both its `Dockerfile` lines and its row in the table below were removed together on
2026-09-30, because a build arg that looks like client-side release tagging and is not answers "are
client errors tagged?" with a reassuring yes. **If that tagging is ever wanted, it needs a call site
FIRST; the ARG is the last step, not the first.**

On Railway today `COMMIT_SHA` is **absent**, and `RAILWAY_GIT_COMMIT_SHA` is injected by the platform
at runtime rather than stored as a service variable — which is why `/api/healthz` still returns a
`revision` while `railway variables` lists neither of them.

| Variable | Description |
|---|---|
| COMMIT_SHA | Runtime release identifier for `app_error_events.release`. 🔴 **Absent on Railway on purpose, and it must stay that way.** It takes PRECEDENCE over the platform's own `RAILWAY_GIT_COMMIT_SHA`, so a hand-set or left-over value makes `/api/healthz`, every deploy-drift check and every shipped-verification read report a revision production is not running — the one instrument that answers "did my deploy go live" would be lying, permanently, with nothing anywhere to catch it. `scripts/validate-railway-production-secrets.mjs` now fails if it is present on production. |
| HEALTHCHECKS_PING_KEY | External cron-liveness dead-man's-switch. Lives on the **Railway `phoenix-people-workforce` service, `production` environment** — never staging, never local. 🔴 **It is SET there today** (measured 2026-10-01 against the live service; absent from staging, which is correct), so the switch is live rather than the optional extra the section below reads like. It arrives GitHub → Railway through `sync-railway-production-secrets.yml` as an OPTIONAL entry (`required: false` in `scripts/sync-railway-production-secrets.mjs`), so like `CRON_SECRET` the GitHub secret is the one to change first — editing it on Railway alone is overwritten by the next sync. It said "the `phoenix-hr` **Cloud Run** service" until 2026-10-01, naming a platform that has not existed since GCP billing closed on 2026-08-01. |
| PHOENIX_RELEASE_GATE | Emergency switch for the production release gate (`src/lib/platform/release-gate.ts`, docs/deployment.md "The release gate"). **Unset on purpose.** Only the exact word `off` (any case) switches it off — `0`, `false` and a typo leave it ON, so a mistake can never be what removes the gate. 🔴 Never set it while Railway's Wait for CI is also off: every merge would then go live the moment it builds. Read only when `RAILWAY_ENVIRONMENT_NAME` is `production`. |

See docs/observability.md for the full picture.

## Scheduler / Deployment

| Variable | Description |
|---|---|
| CRON_SECRET | Bearer-token auth on every `/api/cron/**` route. 🔴 **It authenticates `cron-job.org`, the live production scheduler — NOT Google Cloud Scheduler**, which this row named until 2026-10-01. The 8 GCP Cloud Scheduler jobs do still fire and **401 on every route** (see the top of this file), so reading this row as "Cloud Scheduler auth" makes those 401s look like a broken secret and sends you hunting a rotation AGENTS.md §2.3 forbids. It flows GitHub → Railway via `sync-railway-production-secrets.yml`, so **rotate the GitHub secret first**. See docs/deployment.md. |
| PHOENIX_PREVIEW_READ_ONLY | Legacy Vercel-preview read-only guard; inert on Railway today (neither environment sets `APP_ENV=preview`) |
| VERCEL_ENV | Legacy — Vercel is decommissioned for hosting, so nothing sets this anymore; any code still branching on it is inert |

## The previous secrets after the October 2026 rotation (temporary — until 2026-11-22)

Railway, the host, reported a security incident on 21 October 2026 that may have exposed environment
variables, so `PHOENIX_AUTH_SECRET` and `CRON_SECRET` are replaced. Two temporary variables hold the
**PRE-incident values** so nothing people already hold breaks on the day:

| Variable | Description |
|---|---|
| PHOENIX_AUTH_SECRET_PREVIOUS | The old `PHOENIX_AUTH_SECRET`. Accepted ONLY when **opening a link** issued before the rotation: the email-signature picture address, the unsubscribe link, the offer acceptance / joining-form link, the Monthly Closing Export PDF seal and the public share card. Everything new is signed with the current secret. **Never accepted** for a login session, a password-reset code, the native web hand-off, the seat-view token or a payroll acknowledgment link — those stop working with the old secret on purpose, because a leaked old secret must never sign anybody in. |
| CRON_SECRET_PREVIOUS | The old `CRON_SECRET`, also accepted as the cron bearer (`assertCronAuthorized`, `src/lib/security/cron-auth.ts`) so cron-job.org's jobs can be moved to the new value one at a time without a 401. Every use logs `event=cron_previous_secret` with the job name, so `railway logs \| grep cron_previous_secret` lists the jobs still to move. Never accepted by a route on its own token, and never while `CRON_SECRET` itself is unset. |

🔴 **The end date is hard: `PREVIOUS_SECRET_ACCEPTED_UNTIL = 2026-11-22T00:00:00+02:00`** (midnight Cairo,
`src/lib/auth/previous-secret.ts`). After it both variables are ignored even if still set. A value shorter
than 16 characters, or equal to the current secret, is ignored too. Both must be set on the web service
AND the worker (`phoenix-workforce-worker`), because the moved cron-job.org jobs call the worker: a new
variable on the app does NOT appear on the worker by itself, so add each there as a reference to the
app's own (`${{phoenix-people-workforce.NAME}}`), the way every other worker variable is. They are deliberately NOT in `sync-railway-production-secrets`'
list: editing that script or its workflow pushes every GitHub secret over Railway on merge, which in the
middle of a rotation could put a leaked value back. After 2026-11-22 delete both variables, the helper file
and its callers' fallback.

## Dead-Man's-Switch Monitoring

External liveness alert for the production cron jobs, independent of any platform's own monitoring —
see docs/observability.md for what it catches and full setup steps.

🔴 **"(Optional)" was dropped from this heading on 2026-10-01: the key is SET on Railway production,
so this is live.** The heading also said "for the 8 Cloud Scheduler jobs, independent of GCP
Monitoring", which described a dead arrangement twice over — GCP billing closed 2026-08-01, and those
8 jobs now 401 on every route. What the switch actually watches is the **`cron-job.org`** schedule
that runs production.

| Variable | Description | Default |
|---|---|---|
| HEALTHCHECKS_PING_KEY | Healthchecks.io project Ping Key. Inert — no ping is ever attempted — while unset, which is still true of staging and local. 🔴 **Set on Railway `production` today**, so pings ARE being sent from there; the `(unset)` beside this row is the default when nobody sets it, never a statement about production. | (unset) |
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
| GOOGLE_APPS_SCRIPT_REFRESH_TOKEN | Long-lived grant from `achieverrr303@gmail.com`. Issued by `scripts/apps-script-authorize.mjs`; scopes `script.projects` (write HEAD, create a version) and `script.deployments` (move the web app), nothing wider. A grant issued before 22 Oct 2026 carries `script.projects` only: it still pushes HEAD, and the run then fails naming the missing scope | (unset) |
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

`--clasp-client` (22 Oct 2026) replaces `--client-file` when no Google Cloud client secret is at
hand — the original was lost on 2026-09-05. It reads only the client id and secret of the OAuth
client Google's own Apps Script CLI (clasp) signs in with from `~/.clasprc.json`, never that file's
tokens, and the consent asks for the same two scopes, so the grant is no wider. Sign in as
`achieverrr303@gmail.com` and approve.

Two more further flags exist for re-running it:

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

### The web app follows HEAD (since 22 Oct 2026)

Writing the project's content changes its HEAD — what the sheet's own time-driven trigger runs. A
web app `/exec` URL does NOT run HEAD: it runs the saved VERSION its deployment was given, and stays
there until somebody points it at another. The pusher never did, so every `/exec` URL Phoenix calls
(`SHEET_REFRESH_WEBHOOK_URL` and the two below it) sat on the version it was deployed with. Read on
22 Oct 2026: Direct Orders on version 5 (5 Aug), Marketing Requests on version 3 (5 Aug), CV
Lifecycle on version 1 (5 Sep). The Direct Orders one answered Phoenix's instant refresh ping with
HTTP 200 and a Google error page from version 5 — *"You can't merge frozen and non-frozen columns
(line 404)"* — a defect HEAD had already fixed, while the sheet itself stayed fresh on its trigger.

So after the content step, on every run including one where the content was already current, the
pusher reads the project's deployments, takes the ONE versioned deployment with a web-app entry
point, and compares the files of the version it serves with HEAD. Different → it creates a version
and updates THAT deployment to it, keeping its id, manifest and description, so the `/exec` URL never
changes. It never creates a deployment (none is a skip), refuses when there are two (it cannot tell
which URL Phoenix holds), and leaves the editor's `/dev` HEAD deployment alone. `--check` reports
`would … deploy a new version` without writing. `planWebAppDeployment` is the pure decision;
`tests/apps-script-push.test.ts` drives the real `pushTarget` through a stubbed Google on the
22 Oct state.

This needs the `script.deployments` scope, which the original grant did not ask for. Until the grant
is re-issued, a run still writes HEAD and then FAILS naming the missing scope, rather than reporting
success while the web app stays behind.

🔴 **THE PUSH NEVER MOVES THE DIRECT ORDERS WEB APP, BECAUSE THAT PROJECT BELONGS TO ANOTHER GOOGLE
ACCOUNT.** Its manifest entry carries `moveWebApp: false`. Measured 22 Oct 2026, 04:28 Cairo: moving
its deployment to version 6 as `achieverrr303@gmail.com` (an editor there, the grant's own account)
turned the `/exec` URL into HTTP 403 *"Access denied — you need permission"* for every caller, right
secret or wrong, and moving it back to version 5 the same way did not undo it — so the editor's move,
not the code, is what Google refuses. Marketing Requests and CV Lifecycle are that account's own
projects; Marketing moved from version 3 to 4 at the same minute and answered `ok` at once. For an
owner-only project the push still reads the web app and FAILS, naming the version it serves, when that
is not HEAD's code — the repair is the owning account's own **Deploy → Manage deployments → Edit →
Version: New version → Deploy**, which keeps the same URL. Never flip the flag to fix a red run.

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
| PHOENIX_CLOSING_LOCK_PASSWORD | **Unused since 2026-10-26.** The owner turned the closing-workbook protection off ("make the exported monthly closing xlsx all its types download non protected"): every downloaded Monthly Closing workbook (normal, portal, details, Performance Review, rep ranking, rep-product, premium) now leaves with NO sheet or workbook protection, and no code reads this variable. **Removed from Railway production on 2026-10-26** (the app and the worker; the cron service never had it), and no GitHub secret of that name exists, so nothing syncs it back. `.railway/railway.ts` no longer lists it (2026-10-26). Code: `src/lib/sales/closing-workbook-lock.ts` | *(unused)* |

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
| RESEND_API_KEY | 🔴 **THE ONE Resend account — primary for EVERY email since 2026-11-06** (owner: "keep a free Resend account as the primary, and one Brevo account in case needed as a fallback"). It holds `satopharma.com` and `send.satopharma.com`, so it sends every message under the message's own From. The chain is `resend → brevo`, the same for every module and sender (`src/lib/email/email-providers.ts`). Free plan: about 100 a day and 3,000 a month; Brevo takes the rest |
| RESEND_WEBHOOK_SECRET | Verifies inbound Resend delivery webhooks |
| BREVO_API_KEY | The ONE Brevo account — the fallback, tried when Resend refuses (quota) or accepts and then fails a message. Free plan: 300 a day |
| BREVO_EMAIL_FROM | Sender verified on the Brevo account. A job offer is never re-branded onto it — the offer waits for Resend |
| RESEND_API_KEY_2/_3/_4, RESEND_EMAIL_FROM_2/_3/_4 · RESEND_API_KEY_SALES/_PEOPLE, RESEND_EMAIL_FROM_SALES/_PEOPLE · BREVO_API_KEY_2, BREVO_EMAIL_FROM_2 | 🔴 **RETIRED 2026-11-06 — the code never reads them.** They were the extra Resend accounts (`send2`/`send3`/`send4.satopharma.com`, added 2026-10-08 and 2026-10-11), the per-module Sales and People accounts (`sales.`/`people.satopharma.com`, 2026-10-13) and a second Brevo account. Spreading ~245 emails a day over seven sending addresses was the cause found for company mail landing in junk. Leaving a value set on Railway does nothing; never wire one back without the owner's word |
| RESEND_WEBHOOK_SECRET_2/_3/_4 · RESEND_WEBHOOK_SECRET_SALES/_PEOPLE | Still read by `/api/webhooks/resend`, so the late bounces and complaints of mail the retired accounts sent before the cut are recorded instead of rejected with a 401 |
| NOTIFICATION_WEBHOOK_SECRET | Verifies inbound Telegram webhook calls (`secret_token`) |
| TELEGRAM_BOT_TOKEN | Telegram Bot API token |
| NEXT_PUBLIC_ONESIGNAL_APP_ID | OneSignal app id (client-side) |
| ONESIGNAL_REST_API_KEY | OneSignal REST API key (server-side push) |
| SENTRY_DSN | Sentry (sentry.io) project DSN, read at runtime by `instrumentation.ts`. Production only: ignored unless `APP_ENV=production` |
| SENTRY_WEBHOOK_SECRET | Client secret of the Sentry internal integration that posts alerts to `/api/webhooks/sentry`. Unset means the route refuses every call; the alert only reaches the owner's Telegram |
| NEXT_PUBLIC_SENTRY_DSN | The same DSN for the browser. Build-time (a Dockerfile `ARG`), used only when the page is served from the production host; also adds the DSN's origin to the CSP `connect-src` |

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
| ANTHROPIC_API_KEY | **The second AI provider (2026-10-18), optional.** With it set beside `OPENAI_API_KEY`, every call through `createOpenAiResponseText` (`src/lib/ai/openai-client.ts`) tries OpenAI first and answers from Anthropic's Messages API when OpenAI says its account is out of credit or rejects its key (🔴 out of credit arrives as HTTP 429 with `code: "credit_balance_exhausted"` and `type: "insufficient_quota"` — read on 18 Oct 2026; `isOpenAiOutOfCredit` reads the code AND the type, because the code alone read it as a rate limit and nothing failed over); after that, calls go straight to Anthropic for ten minutes, doubling to 20, 40 and at most 60 while OpenAI stays dead, and one OpenAI answer resets it (a fixed ten minutes sent every process back into the dead account six times an hour, 12 of the 13 AI error rows on 18 Oct 2026). The second provider gets what is LEFT of the caller's timeout, never a fresh one. The caller's `reasoning.effort` reaches Claude as `output_config.effort`, and a `json_schema` format as Claude's JSON outputs (`output_config.format`, with the bounds and patterns Claude refuses dropped from the schema); measured live on 18 Oct 2026, a prompt-only schema took Haiku 3.5–3.8 s and at low effort it answered WITH the schema, while JSON outputs answered valid JSON in 1.9–2.2 s. A 400 that names `output_config` or refuses the schema is resent once without it, and that model + schema pair is then sent plain for the life of the process (the CV reader's 50 nullable fields were refused on 18 Oct 2026 with "Schemas contains too many parameters with union types"). A refusal, a JSON answer cut off at `max_tokens` and a schema repeated back all fail as errors instead of reaching the caller as an empty answer. With only this key set, Anthropic answers everything. Tiers: `claude-haiku-5-5` for the nano/mini asks, `claude-sonnet-5-5` for the rest; `ANTHROPIC_MODEL` forces one model, `ANTHROPIC_FAST_MODEL` / `ANTHROPIC_STRONG_MODEL` move a tier. `AI_PROVIDER=openai` or `anthropic` pins one provider. Set it on Railway directly: it is NOT in the GitHub-to-Railway sync list. The three sales AI paths (the normalizer's AI suggest and header explainer, the weekly AI verify; `src/lib/sales/**`) make their own raw calls and fail over the same way through `planSalesAi` in `src/lib/sales/ai/provider.ts`: they read the OpenAI-compatible variables first (OpenAI, Groq, OpenRouter or `AI_API_KEY` + `AI_BASE_URL`), share the same "OpenAI is unavailable" back-off (an OpenAI answer on a sales path resets it too), and ask Claude's strong tier for AI suggest (`gpt-4o`) and the fast tier for the rest. `AI_MODEL` overrides the OpenAI-compatible side only. A sales path posts to a chat endpoint only inside `runWithSalesAiFailover`; `tests/sales-ai-failover.test.ts` fails a file that does not. |
| ANTHROPIC_API_KEY_2 | **The second Anthropic account (2026-10-24), optional.** The order is OpenAI → Anthropic account 1 (`ANTHROPIC_API_KEY`) → Anthropic account 2 (this key), for every caller of `callAnthropicMessages` (`src/lib/ai/anthropic-fallback.ts`: the shared client and the three sales paths). A call moves to this account only when account 1 answers `quota_exceeded` (out of credit, or the workspace spend limit) or `auth_failed`; a timeout or a rate limit stays on account 1. The second account gets what is LEFT of the caller's timeout (at least one second), never a fresh one. The refusing account is then tried LAST for ten minutes, so calls stop paying its round trip; the same key in both variables counts as one account. The leg is recorded as `failed_over` with provider `anthropic` and `failedOverTo: anthropic_backup`, and the out-of-credit alarm pages once a Cairo day per account ("Anthropic backup account is out of credit" for this one). `AI_PROVIDER=anthropic` skips OpenAI and still keeps both Anthropic accounts in order. Set it by hand on Railway on BOTH `phoenix-people-workforce` and `phoenix-workforce-worker`, the two services that hold `ANTHROPIC_API_KEY`; it is NOT in the GitHub-to-Railway sync list, and `.railway/railway.ts` picks it up at the next `railway config pull`. A key created with no workspace answers 400 on every call, so pick a workspace when creating it. `scripts/secret-shape-rules.mjs` refuses a masked paste. |
| GROQ_API_KEY | **Not OpenAI, deliberately.** Writes a Phoenix CRM visit voice note out as Arabic text for a browser with **no speech engine of its own** — Firefox, on every platform. Chrome, Edge, Safari and Android use the browser's own free engine and never reach it, so only the Firefox share of visits is charged, and a recording is capped at one minute. The owner's cost ruling, 2026-09-25. Unset is a **supported** state, not a broken one: the control asks the server (`GET /api/phoenix-crm/voice/transcribe`) and stops promising Firefox reps their words will be written. Keys are `gsk_…`, and `scripts/secret-shape-rules.mjs` refuses a masked paste of one — the failure OPENAI_API_KEY shipped in 2026-09-02. Railway production only; **not** in `sync-railway-production-secrets.yml`, so it is set on Railway directly and no GitHub secret overwrites it. |

**The out-of-credit alarm names the account that ran out (code review, 19 Oct 2026).**
`src/lib/notifications/ai-quota-alert.ts` pages the system-health audience in-app and on Telegram when an
AI call comes back `quota_exceeded`. Since the Anthropic failover one feature reaches two accounts — the
signboard read asks Claude first, everything else asks OpenAI first — so every `recordAiCall` says which
account it billed (`provider`), and the alarm, its title and its billing page name that one. Before, it
guessed from the feature, and a Claude account out of credit would have sent him to top up OpenAI. It is
sent once a Cairo day for EACH account, so Claude running dry the afternoon after an OpenAI alarm is still
told; the OpenAI alarm keeps the idempotency key it was always sent under, so the day this shipped did not
page twice. Anthropic's workspace spend limit answers HTTP 400 ("You have reached your specified API usage
limits"), not 429: `anthropicErrorCodeFor` reads it as `quota_exceeded`, so it fails over and pages like
an empty balance, and the Anthropic alarm says to add credit or raise the spend limit.

**A leg the next account is asked to cover is reported as failed over, not as an AI failure (owner,
23 Oct 2026).** Until then every leg recorded `status: "error"`, so a dead OpenAI account wrote both halves
of a healthy call to the error board: 520 `openai_request_failed` rows in the seven days to 23 Oct — the
deliberate hourly re-test that lets a top-up be noticed with no deploy — and 21 "AI call failed — Shared
OpenAI client: account out of credit" rows against CV extraction. They read as an outage. They were not:
`ats_candidate_cv_extractions` shows all 58 AI-read CVs from 18 Oct to 22 Oct answered by
`claude-haiku-5-5+rules` and `claude-sonnet-5-5+rules`, and OpenAI reading none since 18 Oct 00:50, so a
session asked to fix dead CV extraction found nothing to fix. `AiCallStatus` now has a third member,
`failed_over`, set by `legOutcome` (shared client) and `salesLegOutcome` (the three sales paths) only when
there IS a next account AND `shouldFailOverToNextProvider` says the code moves to it — a timeout or a rate
limit stays a failure with the account that gave it. Such a leg writes its row under its own route
(`/ai/<component>/<purpose>/failed-over`) and its own log event (`openai_failed_over`,
`anthropic_failed_over`), so a by-design failover can never group with a real outage of the same feature;
it still pages the out-of-credit alarm, because the account is just as empty and only a top-up ends it; and
`failureThrottleKey` carries the status so the hourly rescued leg cannot suppress the real failure for five
minutes. Pinned by `tests/ai-failure-visibility.test.ts` and `tests/ai-provider-failover.test.ts`.

### Feature flags
| Secret | Purpose |
|---|---|
| NEXT_PUBLIC_SMI_USE_FACT_TABLES | Sales-marketing-intelligence fact-table toggle |

### Infra & ops
| Secret | Purpose |
|---|---|
| RAILWAY_TOKEN | Auth for `sync-railway-production-secrets.yml`'s Railway CLI calls |
| CLOUDFLARE_API_TOKEN | Not currently consumed by any workflow or app code — held for future Cloudflare DNS/cache automation |
| SENTRY_AUTH_TOKEN | Build-time Sentry token for source-map upload and release creation. `next.config.ts` runs the Sentry build plugin only when it is non-empty; the Dockerfile declares it as a build argument in the build stage only. Empty means a plain build (see docs/observability.md, "Sentry") |

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
