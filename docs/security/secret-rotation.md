# Rotating a secret

> **Infra (2026-08-01 cutover):** secrets are now **Railway service variables** on the
> `phoenix-people-workforce` service, managed with the **Railway CLI/UI** — **not** GCP Secret
> Manager, which died with GCP billing. There are **no secret *versions*** to pin or disable on
> Railway; a variable is a single current value, and changing it deploys a new revision. The
> canonical infra facts (Railway project/service, dead GCP, the cron-job.org scheduler) live in
> **AGENTS.md §3**. The retired Cloud Run `:latest` rule and `gcloud` sequence are kept as history at
> the bottom.

> **Note:** `pnpm run check:secret-pins` (`scripts/check-secret-pins.ts`) enforced the Cloud Run
> `:latest` rule and ran in the (now dead) Cloud Run deploy. It is **not** in the `ci` gate
> (verified 2026-08-04) and Railway has no version pins — so it is a dead no-op. Actually
> retiring the script is a separate chore, not a rotation step.

## Both halves rotate together

The value lives in **two** places. Rotating one alone guarantees an outage.

1. **The Railway service variable** — read by the app at runtime.
2. **The consumer.** For `CRON_SECRET` that is the `Authorization: Bearer` header held by the
   **cron-job.org** jobs — the real production scheduler (a third-party, free-tier account, outside
   the repo, with no config-as-code; see AGENTS.md §3). Rotating `CRON_SECRET` on Railway without
   updating every cron-job.org job's header returns **401 on every cron route**.
   - Note: the dead GCP Cloud Scheduler jobs *also* still carry an old `CRON_SECRET` and already 401
     for exactly this reason. They are **not** the rotation target — the live consumer is
     cron-job.org. (Making the two match would also risk double-firing every job, since the overlap
     guard is an in-process lock, not a DB lock — see AGENTS.md §3.)
   - Other secrets have their own second half — a webhook registered with Resend/Brevo, the
     attendance agent's config, and so on.
   - `BREVO_WEBHOOK_SECRET`: the second half is the transactional webhook registered in Brevo,
     whose authentication must be a **Bearer token** (the `auth: { type: "bearer", token }` field of
     Brevo's webhook API) set to the new value, on a URL with no `?token=` on it. Since 2026-10-26
     (audit point 20) the route reads the secret from `Authorization: Bearer` ONLY: a webhook URL
     that still ends in `?token=…` is refused with 401 even when its Bearer token is right, and the
     old `x-brevo-token` header is ignored. The refusal is logged as `webhook_token_invalid` with
     `reason` = `secret_in_url`, `bearer_missing` or `bearer_mismatch` (never the token itself).
     Since 2026-11-13 (S01, F-COM-017) a bounce, block, invalid address, spam report or unsubscribe
     from this webhook changes the bounce list only once Brevo's own event log, read with
     `BREVO_API_KEY` / `BREVO_API_KEY_2`, holds that event for that address and message; otherwise
     the event is recorded and `brevo_webhook_suppression_unconfirmed` is logged with its `outcome`
     (`not_found` or `unavailable`). A rotated Brevo API key therefore also has to be live for the
     bounce list to keep learning from Brevo.

## Sequence (Railway)

Set the value over stdin so it never lands on a command line or in a transcript (recipe from the
Railway-topology facts in AGENTS.md §3):

```bash
# 1. Write the new value WITHOUT printing it. printf, not echo — a trailing newline silently breaks
#    token matches. --skip-deploys so setting the var does not itself trigger a deploy.
printf '%s' "$NEW_VALUE" | railway variables set CRON_SECRET --stdin \
  -p Phoenix-HR-Workforce -e production -s phoenix-people-workforce --skip-deploys

# 2. Update the OTHER half immediately (each cron-job.org job's Bearer header; or the
#    webhook/agent config for a non-cron secret).

# 3. Roll the value out to the running app. WARNING: `railway redeploy` REBUILDS FROM main HEAD and
#    ships whatever has merged since — treat it as a production code deploy needing its own approval,
#    and record /api/healthz `revision` before and after so an unintended ship is visible.
railway redeploy -y -p Phoenix-HR-Workforce -e production -s phoenix-people-workforce

# 4. Verify by HASH, never by printing the value, and confirm the cron routes now return 200 with the
#    new secret (an authorized call to a cron route, or check the outbox / *_runs tables — NOT the
#    cron-job.org status line, whose curl lacks --fail and reads green through a 401).
```

There is **no "disable the old version" step** on Railway — setting the variable replaces the value
outright, so the only window where old and new disagree is the gap between step 1 and step 2. Keep it
short: do step 2 immediately after step 1.

> **Resolved 2026-08-04 (verified via `railway status`):** project `Phoenix-HR-Workforce`
> (`dc218ad3-99b7-4aff-be38-953a57524a71`), env `production` (`cd5600e6-99dd-4b1c-80b2-16af8770abef`),
> service `phoenix-people-workforce` — the CLI accepts the names used above. `--skip-deploys` is
> deliberate: it stops the *variable set* from triggering its own deploy, so the explicit
> `railway redeploy` in step 3 is the single controlled rollout (and it rebuilds from `main` HEAD —
> see the warning above).

## Where the secrets live — the GitHub Actions copies are in two environments, never repository-wide (18 Nov 2026)

Until the credentials audit of 18 Nov 2026 (finding 1) all 77 Actions secrets were **repository-wide**, and
both GitHub environments held none. A workflow runs from the branch it was started on, so ANY pushed branch
whose workflow was edited could read the production service key, the database password, the session-signing
secret and the Railway key — and three things can push a branch: the owner, the Claude GitHub app (every cloud
session) and the Railway GitHub app. Outside forks never could (no `pull_request_target`, a fork's run needs
approval, the default token is read-only).

**Now:**

| Environment | Branches allowed to use it | Holds |
| --- | --- | --- |
| `main-secrets` | `main` only | every production secret |
| `urgent-deploy` | `urgent-deploy/production`, `urgent-deploy/dry-run` | `RAILWAY_API_TOKEN`, `RAILWAY_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` |

Every job that reads a production secret declares `environment: main-secrets` (urgent-deploy.yml: `urgent-deploy`),
so a branch run of it is refused before it starts. The name avoids the word "production" on purpose:
deploy-failure-alert.yml and `scripts/lib/post-deploy-errors.mjs` treat any environment containing it as a Railway
production deploy. Each such job now also leaves a deployment record on GitHub; that is expected.

**Stays repository-wide:** browser-visible values (`NEXT_PUBLIC_*`, the Supabase URL, anon and publishable keys,
`APP_URL`, `SYNTHETIC_BASE_URL`) and `EXPO_TOKEN`, nothing else. `tests/workflow-secrets-need-environment.test.ts`
holds all of this.

**The three gaps closed on 19 Nov 2026** (the owner's "fix those"):

- **The staging service key and the Telegram alarm pair moved into `main-secrets`.** ci.yml's `validate` runs on every
  branch, so it stands in the environment only when the run is a push or dispatch on `main`
  (`environment: ${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && 'main-secrets' || '' }}`),
  and the staging login smoke runs only there. A pull request's `validate` reads no secret at all and signs with the
  CI-only literal; fallback-image's pull-request build gets no Railway token.
- **deploy-failure-alert.yml hands its message to a job on `main`.** A Railway `deployment_status` run's ref is the
  deployment's full sha, which the environment's branch rule refuses, so the `alert` job reads no secret: it builds the
  message and dispatches the same workflow on `main` with `relay_text`, and the `send` job there stands in
  `main-secrets` and sends it to Telegram. A dispatch carrying `relay_text` never runs `alert`, so it cannot loop.
- **Only admins may create or push an `urgent-deploy/*` branch.** Repository ruleset "urgent-deploy branches: only
  admins create or push" refuses creation, update and force-push on `refs/heads/urgent-deploy/**` for everyone but
  repository admins; deletion stays open so the guard can remove the branch at hand-over. GitHub Actions cannot be a
  bypass actor, so the guard's "regressed" re-push is refused by design (`scripts/urgent-deploy.mjs` says so beside it).

**Setting or rotating a GitHub secret from now on:** `printf '%s' "$NEW_VALUE" | gh secret set NAME --env main-secrets`
(the Railway tokens: also `--env urgent-deploy`). An environment secret outranks a repository secret of the same
name for a job in that environment, so a value set without `--env` after the move is silently NOT the one the
workflows read.

**The one-time move, and its retirement.** `.github/workflows/move-secrets-to-environments.yml` copied each
repository secret into the environments from inside a run (GitHub never shows a value, so nothing else can copy one).
Run 1 (19 Nov 2026, 00:55 Cairo) moved 62 secrets and the repository copies were deleted on the owner's word; run 2
moved the staging key and the Telegram pair. Its work was done, and on 27 Nov 2026 the owner retired it ("Retire it"):
it read every secret at once (`toJSON(secrets)`), which code scanning flagged and GitHub held as "may be malicious" on
every run. The file is in git history (last on `main` at 472485b6b) if a future move ever needs it, and only on his
word. `tests/workflow-secrets-need-environment.test.ts` now refuses any workflow that reads `toJSON(secrets)`.


## Script database connections ask for TLS (19 Nov 2026)

Credentials audit of 18 Nov 2026, finding 2: the production database accepts unencrypted connections until SSL
enforcement is switched on, and postgres.js (3.4.9) connects WITHOUT TLS unless the call names `ssl` — it has no
PGSSLMODE support, and none of the database URLs the scripts read (`.env.local` and the others) carries `sslmode`.
About 17 script connections therefore sent the database password and the rows in clear.

- Every `postgres()` call under `scripts/` and `tests/scripts/` now names `ssl: "require"`, in its own arguments or
  in an options object declared in the same file. `tests/postgres-connections-use-tls.test.ts` fails a call without it
  or with a weaker mode (`false`, `prefer`, `allow`, `disable`).
- psql and pg_dump (the release gate, the code backup) use libpq, whose default `prefer` negotiates TLS; the release
  gate also sets `PGSSLMODE: require` so it can never fall back to plain text.
- The app opens no Postgres connection (it reaches Supabase over HTTPS), and `infra/phoenix-mcp` verifies the
  certificate chain itself.
- Switching SSL enforcement on is the owner's own action on the production project, after this change has merged; it
  may restart the database. **He switched it on at 02:04 Cairo on 19 Nov 2026.** The database's front door refused
  requests for about four seconds, then every outside connection came back over TLS 1.3. A network restriction is
  NOT recommended: Railway, GitHub's runners and the laptop have no fixed addresses, so it would cut off the app's own
  scripts and the release gate.

## What the credentials audit changed on 19 Nov 2026

- **The production database admin password was replaced.** The new one is in the shared local `.env.local` and in
  the GitHub `PHOENIX_PRODUCTION_DATABASE_URL` secret (`main-secrets`). No Railway service holds it, because the app
  reaches the database over HTTPS. The old password is refused. A copy of `.env.local` made before that morning
  holds a dead password and must be refreshed, never "fixed" by loosening anything.
- **The unused production secret key named "default" was revoked.** It had answered no request in the day before.
  The app's own key (`phoenix_server_2026_10_22`) is untouched.
- **Staging's old-format keys are switched off.** CI's `STAGING_SUPABASE_SERVICE_ROLE_KEY` and the local staging
  row-security test file now hold a staging secret key of their own (`ci_and_rls_tests_2026_11_19`), so either can
  be revoked without touching the staging website.
- **`CRON_SECRET_PREVIOUS` and `PHOENIX_AUTH_SECRET_PREVIOUS` leave production on 22 Nov 2026.** The app stops
  accepting them at 00:00 Cairo that day (`src/lib/auth/previous-secret.ts`). A scheduled task on the owner's laptop
  deletes both from the website and worker services from 00:15 that night. It checks that they are gone, then
  removes itself. The code that reads them and their `.env.example` lines go in a later change.

## Never print a secret

- **Railway renders *staged* variable values UNMASKED** in the web UI's changes panel (saved values
  are masked), so opening it can dump a secret into a screenshot or transcript — **prefer the CLI.**
- **Pipe-never-print:** `printf '%s' "$VALUE" | railway variables set … --stdin` beats capturing a
  value into a shell variable or echoing it. On Windows call the resolved `railway.cmd`
  (`shutil.which("railway")` from Python) — the bare name fails.
- Don't dump every variable to inspect one — `railway variables` prints values; project only the one
  you need.

## `PHOENIX_AUTH_SECRET` — the one to be most careful with

It signs session cookies, so rotating it **signs out every user at once** — it is not a background-job
secret whose mismatch merely degrades a cron. Rotate it only when you intend a global sign-out, and
tell the owner first.

🔴 **It also seals the second sign-in step** (13 Nov 2026). Each Super Admin's authenticator key is
sealed with it and the recovery-code fingerprints are keyed with it, so after a rotation neither can be
read and a Super Admin's password sign-in answers 500 (a passkey sign-in still works). A rotation of
this secret therefore includes deleting every row of `app_auth_second_step`; each Super Admin sets the
step up again at their next password sign-in. Account: `docs/security/second-sign-in-step.md`,
"Rotating `PHOENIX_AUTH_SECRET`".

## History — the 2026-07-31 Cloud Run / Secret Manager incident (retired mechanics)

> Kept for the lesson, not the commands — this all ran under the retired GCP setup and no part of it
> is live today.
>
> **The old rule:** Cloud Run referenced Secret Manager and had to **always reference `:latest`,
> never a version number** (`--update-secrets=MY_SECRET=MY_SECRET:latest`). A pinned version can't
> pick up a rotation and stops resolving the moment that version is disabled; Secret Manager versions
> are immutable, so `:latest` was exactly as reproducible as `:4` until a deliberate rotation — which
> is the case you *want* the service to follow.
>
> **What happened — 2026-07-31, ~20:58–21:12Z: all 8 cron jobs returned 401.** A `CRON_SECRET`
> rotation churned four Secret Manager versions in 13 minutes; v2/v3 were disabled and v4 became
> good, but the Cloud Run revision deployed at 20:56 carried a hard pin to `key: "2"` (disabled
> minutes later) while the schedulers already carried v4. It was caught by the Healthchecks
> dead-man's-switch within the 10-minute grace, not by anything in the request path. In the 40
> minutes *after* the fix the same rotate-then-pin sequence was repeated on
> `NOTIFICATION_WEBHOOK_SECRET`, `BREVO_WEBHOOK_SECRET`, `PHOENIX_AUTH_SECRET`, and
> `ATTENDANCE_AGENT_TOKEN`; none fired only because nobody had disabled the older versions yet.
>
> **GCP-era specifics (all retired):** the `CRON_SECRET` consumer was the 8 Cloud Scheduler jobs in
> **`us-central1`** (not the service's `europe-west3`). The "never print" traps were `gcloud run
> services describe --format=json` (dumped every env var value — exposed a service-role JWT on
> 2026-07-31) and `gcloud services api-keys create` (printed `keyString` regardless of `--format`).
