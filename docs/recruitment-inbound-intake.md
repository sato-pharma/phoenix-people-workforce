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

## What pages, and what does not (changed 2026-08-23)

**Only a deterministic fault pages.** `checkWhatsAppIntakeHealth` now returns two statuses that
reach a phone, and one that does not:

| Status | What it means | Pages? |
| --- | --- | --- |
| `api_unreachable` | Meta rejects our credentials (the 2026-07-26 block) | **yes** — Telegram + push |
| `webhook_misrouted` | Meta is configured to deliver somewhere that is not us | **yes** — Telegram + push |
| `silent` | Nothing has arrived for a while, delivery config verified fine | no — WARNING log only |
| `ok` / `not_configured` | — | no |

`webhook_misrouted` is checked directly against Graph on every 10-minute tick, using credentials the
app already holds (the app id is read back from `debug_token`, so there is no extra env var to drift):

1. `GET /{app-id}/subscriptions` — the `whatsapp_business_account` entry must be `active`, must
   include the **`messages`** field, and its `callback_url` must equal the production webhook URL.
2. `GET /{phone-number-id}?fields=webhook_configuration` — a **per-number override beats the
   app-level URL**, so a stale one silently reroutes every message while everything else looks right.

An unanswerable check (no `WHATSAPP_APP_SECRET`, or Graph unreachable) yields `ok: null` — never
`false`. A network blip must not page anyone with a fake misconfiguration.

### Why silence stopped paging

Silence was the primary alert and it did not work. Measured on production 2026-08-23, over the
channel's whole recorded history:

- The normal inbound gap has reached **333 hours** (08-01 → 08-14) against a **96-hour** threshold.
  The alert therefore fired for roughly **ten consecutive days in early August with nothing wrong**,
  and was firing again at the time of this change while every layer verified healthy.
- Organic CVs run at **0–6/day**, and **371 of 390** recorded WhatsApp intake events were bulk
  forward-imports, not applicants. A bulk import also **resets the silence clock**, so a genuine
  applicant drought is masked by an HR forward while an ordinary quiet week trips the alarm.

An alert that is on during normal operation cannot signal an outage — the real 2026-07-26 block
would have been invisible inside that noise. So silence is still computed, still logged, and still
returned in the cron payload; it just no longer pages. The deterministic checks above carry that
duty, and they catch the actual failure mode in one tick instead of after 96 hours.

**`RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS` now only controls when the WARNING appears.** Raising
it reduces log noise; it no longer affects whether anyone is paged.

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
