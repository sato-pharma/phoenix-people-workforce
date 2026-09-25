---
name: git-bash-crlf-corrupts-secrets-written-to-secret-manager
description: "On this Windows machine, piping openssl/any generator into `gcloud secrets versions add --data-file=-` via the Bash tool appends \\r\\n — the stored secret is silently wrong and every consumer 401s. Caused a real ~14-min prod cron outage 2026-07-31. Always strip with tr -d '\\r\\n' and verify the byte length."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2701071e-097f-4d4e-889e-9ca1be40a17f
  modified: 2026-07-31T21:15:09.605Z
---

**Caused a real production outage on 2026-07-31** (~21:00–21:12 UTC): every Cloud Scheduler cron
401'd for ~14 minutes after a `CRON_SECRET` rotation. No data lost (all the affected jobs are
idempotent/retryable outbox drains), but it was self-inflicted and took several wrong diagnostic
turns to find.

## The bug

Running this in the **Bash tool on this Windows machine** (Git Bash):
```
openssl rand -hex 32 | gcloud secrets versions add CRON_SECRET --data-file=-
```
stores **67 bytes**, not 64 — the value ends with `\r\r\n`. `tr -d '\n'` is NOT enough (leaves a
trailing `\r`, 65 bytes). The stored secret is silently corrupt; nothing errors.

Consumers then fail in a way that looks like a rotation/propagation problem but isn't:
- The app reads `process.env.CRON_SECRET` = `"<64 hex>\r\r\n"` and compares
  `header === \`Bearer ${secret}\``.
- Any header value you *set* from `$(gcloud secrets versions access ...)` has the trailing
  whitespace **stripped by command substitution**, so it's `Bearer <64 hex>`.
- They never match → permanent 401 on every cron endpoint.

## Why my verification missed it

I hash-compared the Cloud Scheduler `Authorization` header against `"Bearer " + $(secret access)`
and **the fingerprints matched** — because *both* sides went through `$(...)`, which stripped the
trailing bytes identically. A comparison where both operands get the same corruption applied is not
a comparison. **Compare byte lengths / `od -c` tails, not just hashes of shell-substituted values.**

A second red herring: `curl` with the new secret returned **400**, not 401, which I briefly read as
"auth passed." The 400 came from a layer in front of the route (Next 16 proxy/CSRF,
[[nextjs16-proxy-csrf]]) and the request never reached the handler — it never appeared in Cloud Run
logs at all. **A status code from curl that doesn't appear in the Cloud Run request log did not
reach the app; don't interpret it.**

## The correct form

```
S=$(openssl rand -hex 32 | tr -d '\r\n')
[ ${#S} -eq 64 ] || { echo "ABORT"; exit 1; }
printf '%s' "$S" | gcloud secrets versions add <NAME> --data-file=- --project=<p>
unset S
```
Then **always verify before wiring anything to it**:
```
gcloud secrets versions access <V> --secret=<NAME> --project=<p> | wc -c      # must be exactly 64
gcloud secrets versions access <V> --secret=<NAME> --project=<p> | od -c | tail -2   # no \r or \n
```
Calibrate against a known-good older version of the same secret if unsure what "clean" looks like —
the pre-existing `CRON_SECRET` v1 (written by `scripts/setup-gcp-cron.sh`, not by me) was clean and
made the diff obvious.

## Blast radius to check after any CRON_SECRET rotation

`CRON_SECRET` lives in **two** places that must be updated together, and Secret Manager rotation
does NOT propagate to the second:
1. Cloud Run env (`--update-secrets=CRON_SECRET=CRON_SECRET:<V>`, forces a new revision).
2. **All 8** Cloud Scheduler jobs in **`us-central1`** (not europe-west3 — the jobs deliberately
   live in us-central1 per `scripts/setup-gcp-cron.sh`; the service is in europe-west3):
   `phoenix-background-jobs`, `phoenix-inbound-intake`, `phoenix-process-notifications`,
   `phoenix-notify-daily`, `phoenix-ireports360-sync`, `phoenix-recruitment-email-intake`,
   `phoenix-ireports360-live-sync`, `phoenix-reconcile-visits`.
   Update via `gcloud scheduler jobs update http <job> --location=us-central1
   --update-headers="Authorization=Bearer ${SECRET}"` — **redirect output to /dev/null**, the job
   resource echoes the secret back unredacted.

Verify with a real firing, not an assumption:
`gcloud scheduler jobs run phoenix-process-notifications --location=us-central1`, then read
`gcloud logging read ... httpRequest.status` for `/api/notifications/process` — expect 200.

Related: [[gcloud-commands-that-leak-secrets-into-transcripts]],
[[notifications-cron-timeout-chain-2026-07-16]], [[ai-unavailable-openai-key-rotation]].
