---
name: railway-migration-live-topology-and-cli
description: "Railway prod topology after the 2026-08-01 GCP cutover — two services, a hand-rolled cron, and the Railway CLI recipe that automates variable restores"
metadata: 
  node_type: memory
  type: project
  originSessionId: c097bbcb-19f6-4795-ac45-d0d8b0bed451
  modified: 2026-08-04T15:33:35.624Z
---

Verified live 2026-08-02. Production is Railway, **not** Cloud Run. GCP billing account
`01BDEA-A20B4C-CC568F` is closed; every billable API returns `BILLING_DISABLED`.

**Topology (AGENTS.md records this wrong).** Project is **`Phoenix-HR-Workforce`**
(`dc218ad3-99b7-4aff-be38-953a57524a71`), NOT "creative-serenity". Environment `production` =
`cd5600e6-99dd-4b1c-80b2-16af8770abef`. **Two** services:
- `phoenix-people-workforce` = `30356676-116b-4886-ac6e-89041d80185e` (the app, US West, 1 replica)
- `phoenix-cron` = `179e6a73-d891-4fbc-a89e-ac53ef461821` — a hand-rolled scheduler someone built
  2026-08-01 22:51 GMT+3. `alpine:3`, `*/5 * * * *`, start command `apk add --no-cache curl …;
  M=$(date -u +%M); H=$(…` — one 5-min tick that fans out to different jobs by minute/hour.
  🔴🔴 **BIGGEST CORRECTION 2026-08-02: GOOGLE CLOUD SCHEDULER IS STILL ALIVE AND FIRING.**
  `railway logs --http --json` shows every `/api/cron/*` request carries
  `"clientUa":"Google-Cloud-Scheduler"`, `srcIp` in 34.116.x.x, on the ORIGINAL Cairo schedules
  (inbound-intake every 2 min, recruitment-email-intake every 10 min). `BILLING_DISABLED` blocks
  the scheduler MANAGEMENT api (list/describe) but does NOT stop execution — the audit, and I,
  read "cannot list the jobs" as "the jobs are dead". They reach Railway because the job URLs use
  the custom domain, which now resolves here. **They all 401: the secret in the GCP job
  definitions does not match Railway's `CRON_SECRET`.** Fixing that one value would restore all 8
  jobs instantly with correct Cairo timing — but it re-adopts a credential sitting in cleartext in
  an abandoned project, and GCP reclaims that project ~2026-08-31, so it buys ~4 weeks at best.
  🔴 **Hazard: if anyone ever makes those secrets match AND an external scheduler is live, every
  job double-fires** — the outbox overlap guard is an in-process lock, not a DB lock.
  🔴 **The Railway `phoenix-cron` service NEVER reached the app — zero requests, ever.** Its
  `apk add curl` ran 288x/day and the curl never landed. Disabled 2026-08-02 via
  `serviceInstanceUpdate {cronSchedule: null}` + `railway down`; note the null ALONE did not stop
  it (the running deployment keeps its own schedule) — and neither did, because it was never the
  caller. Old value was `*/5 * * * *` if it ever needs restoring.

  Earlier finding, still true of that service's own behaviour:
  `railway logs --http` on the APP service shows `GET /api/cron/inbound-intake 401`. Its own logs
  show only the apk install, and green runs prove nothing — a curl without `--fail` exits 0 on a
  401, so the cron dashboard reads "Last run succeeded" through a total outage.
  **It is NOT a secret mismatch**: both services' `CRON_SECRET` hash identically (len 64), and the
  same endpoint returns `200 {"success":true}` when called with a correctly-formed
  `Authorization: Bearer <secret>` header. The fault is in the `phoenix-cron` START COMMAND —
  the header is not reaching the app, most likely `$CRON_SECRET` inside single quotes so it never
  expands. Railway's CLI cannot edit a start command; fix it in the UI or replace the service.
  Diagnosing this needs `railway link` first (`logs` has no `-p` flag, unlike `variables`) — link
  from a scratch dir so no `.railway` file lands in the repo.

**`cloud-run-env.yaml` is a stale 9-July snapshot: 31 keys vs the live service's 52.** Railway was
seeded from it, which is why ~21 vars were missing. The dead GCP project still answers
`gcloud run services describe` (32 plaintext recoverable, 20 Secret Manager refs are NOT —
Secret Manager itself returns BILLING_DISABLED).

🔴 **`NOTIFICATION_EMAIL_FROM` has NO default on the outbox path.**
`src/lib/notifications/email.ts:1425-1428` returns `{skipped: true}` without it, and `skipped` is
TERMINAL — the drain only re-reads `pending`/`failed`. The fallback at
`send-phoenix-email.ts:204` covers direct sends ONLY. This variable, not just
`EMAIL_NOTIFICATIONS_ENABLED`, is what destroyed 66 notifications. Canonical value:
`Phoenix Workforce <phoenix@send.satopharma.com>`. See [[outbox-drain-verified-working-dual-caller-401]].

**Railway CLI is the automation path — far better than the browser.** Installed and authed.
No `railway link` needed; pass IDs per call, which also avoids writing a `.railway` file into the
repo. Values over stdin never hit a command line or transcript:

    printf '%s' "$VALUE" | railway variables set NAME --stdin \
      -p <project> -e <env> -s <service> --skip-deploys

Then `railway redeploy -y -p … -e … -s …`. Gotchas: use `printf` not `echo` (a trailing `\n`
silently breaks token matches); from Python use `shutil.which("railway")` — the bare name fails on
Windows because npm installs `railway.cmd`; `--from-source` REBUILDS (needed for any
`NEXT_PUBLIC_*`, which is inlined at build) but also ships whatever landed on `main`, so it is a
code deploy needing its own approval.

🔴 **CORRECTION 2026-08-02: plain `railway redeploy` is NOT a config-only restart — it rebuilds
from `main` HEAD and ships whatever has merged since.** Verified the hard way: redeploying only to
pick up a new `ONESIGNAL_REST_API_KEY` moved `/api/healthz` `revision` from `1af48312` to
`6369c6a5`, shipping two commits that had not yet gone live (`41031de1` biometric passkey sign-in
#1630, `6369c6a5` #1632). The `--from-source` caveat above reads as if the bare command does not
rebuild. **It does.** Treat EVERY `railway redeploy` as a production code deploy needing its own
approval, and always record `/api/healthz` `revision` before and after so an unintended ship is
visible. (Mitigating: both commits were already merged to `main`, which is itself the ship
decision here — Railway auto-deploys on push — so the redeploy mostly just got there first.)

**Driving Railway's web UI by coordinate clicks is unreliable** — two clicks aimed at Cancel/other
buttons landed on "New Variable" and staged blank variables. Railway also renders *staged* variable
values UNMASKED (saved ones are masked), so opening the changes panel can dump secrets into a
transcript. Prefer the CLI.

Verification endpoints that actually prove state:
`/api/health/email` (200 = healthy; also reports `deliveryMode` and `forceTesting`),
`/api/readyz` (`warnings: []`), and
`GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x` →
**403 = configured, 500 = env missing**. That last check would have caught the WhatsApp outage on
cutover night.
