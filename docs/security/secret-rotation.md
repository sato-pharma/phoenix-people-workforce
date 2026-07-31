# Rotating a secret

Applies to every secret this service reads from Secret Manager — not just the one that
broke. Enforced by `pnpm run check:secret-pins`, which runs in the production deploy
before traffic is promoted.

## The rule

**Cloud Run must always reference `:latest`. Never a version number.**

```
--update-secrets=MY_SECRET=MY_SECRET:latest      # correct
--update-secrets=MY_SECRET=MY_SECRET:4          # breaks on the next rotation
```

A pinned version cannot pick up a rotation, and stops resolving altogether the moment
that version is disabled. Pinning buys nothing: Secret Manager versions are immutable,
so `:latest` is exactly as reproducible as `:4` until someone deliberately rotates —
which is the case you want the service to follow, not ignore.

## Both halves rotate together

The value lives in **two** places. Rotating one alone guarantees an outage.

1. **Secret Manager** — read by Cloud Run.
2. **The consumer.** For `CRON_SECRET` that is the `Authorization: Bearer` header of the
   8 Cloud Scheduler jobs, which live in **`us-central1`**, not the service's
   `europe-west3` (`jobs describe --location=europe-west3` returns NOT_FOUND and reads
   as "no such job"). Other secrets have their own second half — a webhook registered
   with Brevo/Resend, the attendance agent's config, and so on.

## Sequence

```bash
# 1. Write the new version WITHOUT ever printing it.
openssl rand -hex 32 | gcloud secrets versions add MY_SECRET --data-file=- --project=phoenix-workforce-498619

# 2. Point Cloud Run at :latest. Skip if it already says latest — it should.
gcloud run services update phoenix-hr --region=europe-west3 --project=phoenix-workforce-498619 \
  --update-secrets=MY_SECRET=MY_SECRET:latest

# 3. Update the OTHER half (scheduler job, webhook registration, agent config).

# 4. Verify by HASH, never by printing the value. Compare raw bytes — piping through
#    `tr -d '\r\n'` produced a false mismatch once and sent someone chasing a phantom
#    fourth secret.

# 5. Only now disable the old version, and only after traffic has been healthy for a
#    while. This is the step that converts a latent mismatch into an outage, so it is
#    the step to do last and slowly.
```

Rotating several secrets? Do them in **one** `services update` call. Each call creates a
Cloud Run revision.

## Never print a secret

- `gcloud run services describe --format=json` dumps every env var **value**. It exposed
  a service-role JWT on 2026-07-31. Project only the fields you need instead.
- `gcloud services api-keys create` prints `keyString` regardless of `--format`. There is
  no safe automated form — create API keys in the Console.
- Prefer pipe-never-print (`openssl rand … | gcloud secrets versions add --data-file=-`)
  over capturing a value into a shell variable.

## What this is guarding against

**2026-07-31, ~20:58–21:12Z: all 8 cron jobs returned 401.** A `CRON_SECRET` rotation
churned four versions in 13 minutes; v2 and v3 were then disabled and v4 became good. The
Cloud Run revision deployed at 20:56 carried `secretKeyRef: {key: "2"}` — a hard pin to a
version that was disabled minutes later — while the schedulers already carried v4. The
previously-working revision had used `latest`.

It was caught by the Healthchecks dead-man's-switch within the 10-minute grace, not by
anything in the request path. Sentry could not have caught it: those monitors had been
muted hours earlier and there was never a `background-jobs` monitor at all.

In the 40 minutes **after** that fix, the same rotate-then-pin sequence was repeated on
four more secrets — `NOTIFICATION_WEBHOOK_SECRET`, `BREVO_WEBHOOK_SECRET`,
`PHOENIX_AUTH_SECRET`, `ATTENDANCE_AGENT_TOKEN`. None of them fired, only because nobody
had disabled the older versions yet. That is the reason this is a check and not a
paragraph of advice: the lesson was learned, written down for one secret, and then
immediately not applied to the next four.

`PHOENIX_AUTH_SECRET` is the one to be most careful with. It signs session cookies, so a
rotation while pinned does not degrade a background job — it signs out every user at once.
Before repointing any pinned secret, confirm the pinned version **is** the newest enabled
one (`gcloud secrets versions list <NAME>`). If it is, the switch is value-neutral. If it
is not, repointing changes the live value.
