# Inbound CV Intake — operations & Meta-block hardening

How WhatsApp + email CV intake works, how to keep it alive, and the owner actions that live outside
code. Companion to the reliability queue (`src/lib/recruitment/inbound/`) and the health/alert cron.

## Pipeline (one line)

Receipt → **enqueue** (`ats_inbound_intake_queue`) → **worker** (`/api/cron/inbound-intake`, every
2 min) re-materializes bytes + runs `ingestInboundCv` → candidate. Failures **retry with backoff →
dead-letter** with a Telegram/push alert. The WhatsApp webhook acks in <1s (enqueue only); the email
poll only discovers UIDs and enqueues. Health is probed every 10 min by the
`recruitment-email-intake` cron (per-number API probe + channel-wide + per-line silence).

## Keeping Meta from blocking the number (why the 2026-07-26 outage happened)

1. **Fast webhook ack** — the webhook must return 200 quickly or Meta disables it under load. Do NOT
   move media download / AI back into the webhook; it stays enqueue-only by design.
2. **Complete Meta Business Verification** — an unverified business gets low limits (`TIER_250`,
   `quality_rating: UNKNOWN`) and is far more block-prone. *(Owner action, Meta Business Manager.)*
3. **Permanent System-User token** — the current token has `expires_at: 0` (never). Keep it in
   Secret Manager; rotate by adding a new secret version (the app reads it at runtime — no redeploy).
   Never fall back to a short-lived user token.
4. **Stay inbound-first** — outbound messaging drives quality rating. The applicant acknowledgement
   (below) is off by default and template-only for exactly this reason. Keep bulk forwarding
   human-paced.
5. **Standby number** — inbound is number-agnostic; a second Cloud-API number registered on the same
   WABA is a hot standby. Add its id to `WHATSAPP_PHONE_NUMBER_IDS` (comma-separated) so health +
   per-line silence watch it too.

Email is inherently resilient (IMAP retains messages — a poller outage never loses mail; just
re-poll). WhatsApp Cloud API has **no inbound history API**, so a dropped webhook is gone — which is
why the fast ack, verification, and the 10-minute health alert matter most there.

## Applicant auto-reply (built, OFF by default)

`src/lib/recruitment/inbound/whatsapp-reply.ts` can send a "we received your CV" **approved
template** after a new direct applicant is created. Inert until all of:

- `RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED=true`
- `RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE=<approved template name>` (create + get it approved in
  WhatsApp Manager first)
- `RECRUITMENT_WHATSAPP_AUTOREPLY_LANG=<code>` (optional, default `en`)

It never fires on a bulk import or an existing-candidate match, and a send failure never affects the
captured CV. Turn it on only after the template is approved.

## Data-processing note (S4)

CV bytes are sent to OpenAI for classification + extraction (and vision for photographed CVs),
reusing `OPENAI_API_KEY`. Candidate PII therefore transits OpenAI — confirm the account's
data-processing terms / zero-retention posture meet the org's requirements before scaling volume.

## Environment reference

| Var | Purpose | Default |
| --- | --- | --- |
| `RECRUITMENT_EMAIL_INBOXES_JSON` | IMAP mailboxes (array) — add `careers@` alongside `hr@` | unset = email intake off |
| `RECRUITMENT_EMAIL_IMPORT_SENDERS` | addresses whose mail is a bulk forward-import | unset |
| `RECRUITMENT_EMAIL_BACKFILL_DAYS` | first-run look-back per folder | 7 |
| `RECRUITMENT_EMAIL_MAX_MESSAGES_PER_POLL` | UIDs enqueued per folder per poll | 40 |
| `WHATSAPP_PHONE_NUMBER_IDS` | comma-separated intake lines to health-check | falls back to `WHATSAPP_PHONE_NUMBER_ID` |
| `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` | numbers whose messages are a bulk forward-import | unset |
| `RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS` | silence threshold (business hours only) | 24 |
| `RECRUITMENT_INBOUND_CV_MAX_BYTES` | max accepted CV size (also the WhatsApp media pre-download guard) | 15 MB |
| `RECRUITMENT_INBOUND_QUEUE_MAX_PER_RUN` | queue rows drained per worker tick | 10 |
| `RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED` / `_TEMPLATE` / `_LANG` | applicant acknowledgement (off) | off / unset / `en` |

## Cloud Scheduler

`phoenix-inbound-intake` (every 2 min, `--attempt-deadline=330s`) drains the queue;
`phoenix-recruitment-email-intake` (every 10 min) polls mailboxes + runs the health check. Both in
`scripts/setup-gcp-cron.sh`.
