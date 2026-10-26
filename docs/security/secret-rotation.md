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
