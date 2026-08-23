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

## What pages, and what does not (rewritten 2026-08-23, later the same day)

**Read this before changing any alert here.** Everything in this section exists because on
2026-08-23 every check in this module passed while the WhatsApp channel had been shut to the public
for 25 days.

### The shape of the channel decides what silence means

There are **two** numbers, and only one of them is on the Cloud API:

| Number | What it is |
| --- | --- |
| `01159888247` | The **advertised** HR handset — a normal WhatsApp Business app phone, **not** on the Cloud API |
| `+20 10 98500699` | The Cloud API line (`WHATSAPP_PHONE_NUMBER_ID`) that this webhook actually receives on |

So an applicant's CV lands on the handset and enters the ATS **only when a human forwards a batch**
to the Cloud API line. This was a deliberate decision on 2026-07-27, when Meta Coexistence was not
offered in the dashboard. **Under that design a WhatsApp intake event measures HR's forwarding
activity, not applicant demand** — which is why 371 of 390 events are bulk forwards and why the
2026-08-23 gap was never a quiet channel: it was CVs piling up unread on a phone.

### The four statuses

| Status | What it means | Pages? |
| --- | --- | --- |
| `api_unreachable` | Meta rejects our credentials (the 2026-07-26 block) | **yes** — Telegram + push |
| `webhook_misrouted` | Meta is configured to deliver somewhere that is not us | **yes** — Telegram + push |
| `public_channel_dead` | Applicants are provably applying by email, and **none** reached WhatsApp | **yes** — Telegram + push |
| `silent` | Nothing has arrived at all for longer than the threshold | **yes** — Telegram + push |
| `ok` / `not_configured` | — | no |

Precedence is deliberate and one incident raises one alert: a credential block outranks everything
(it explains the rest), a named misconfiguration outranks the measurement (it explains why nobody got
through), and the measurement outranks bare silence (it is the more specific statement).

### `webhook_misrouted` — configuration, checked directly

Checked against Graph on every 10-minute tick using credentials the app already holds (the app id is
read back from `debug_token`, so there is no extra env var to drift):

1. `GET /{app-id}/subscriptions` — the `whatsapp_business_account` entry must be `active`, must
   include the **`messages`** field, and its `callback_url` must equal the production webhook URL.
2. `GET /{phone-number-id}?fields=webhook_configuration` — a **per-number override beats the
   app-level URL**, so a stale one silently reroutes every message while everything else looks right.

An unanswerable check (no `WHATSAPP_APP_SECRET`, or Graph unreachable) yields `ok: null` — never
`false`. A network blip must not page anyone with a fake misconfiguration.

### `public_channel_dead` — the only check that can see an outage the config cannot

`measurePublicReach` counts, over the same window as the silence threshold:

- **`outsideSenders`** — distinct WhatsApp senders, excluding the forwarding handsets. The split is
  on `raw_metadata.bulkImport` (stamped by the webhook whenever the sender is in
  `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`), **and** on the import list directly, so an unstamped
  handset message cannot pass as an applicant. Counting forwards here is exactly what hid the outage.
- **`emailSenders`** — distinct people whose CV arrived by **email** in the same window, counting
  only `candidate_created` / `candidate_matched` so newsletters and bounces cannot inflate it.

Email is the control group: an independent transport with no Meta dependency. It answers the one
question configuration never can — *are people applying at all right now?* The status fires only
when `outsideSenders === 0` **and** `emailSenders >= 5`, so a hiring pause, Eid, or a national
holiday reads as a quiet week rather than a broken channel.

**It only pages when `RECRUITMENT_WHATSAPP_DIRECT_INTAKE=true`.** Set that once the advertised
number itself delivers into the Cloud API (Coexistence). Until then zero outside senders is the
designed behaviour, so the numbers are still measured and returned in the cron payload — they are
what makes the channel's true state visible — but they cannot page. This is an explicit switch
rather than something inferred from the number count, because the two architectures disagree about
what silence means and guessing that wrong is the entire bug.

### Why `silent` pages again (reversing PR #2327)

PR #2327 removed `silent` from the paging set on 2026-08-23, reasoning that the channel's normal
inbound gap had measured **333 hours** against a 96-hour threshold, so the alert fired for ~10
consecutive days in early August "with nothing wrong". **That reasoning was wrong and was reversed
hours later.** Given the forwarding architecture above, those 333 hours were not a quiet channel —
they were nearly two weeks of applicants' CVs sitting unread on the handset. Silence was the right
signal all along; what it needed was the correct *explanation* attached to it, not switching off.

The message now names which of the two situations the gap describes — "nobody has forwarded a CV
batch from the HR handset, so CVs are accumulating there unread" under forwarding, or "no applicant
has messaged the line" once direct intake is on — instead of restating the number of hours.

`RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS` (96 in Railway) sets both the paging threshold and the
reach window. Once Coexistence is live, applicants arrive continuously and this stops firing on its
own; until then it firing means real work is queued on a phone.

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
