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


### Which number the adverts point at, and why the owner can still see the conversation

`RECRUITMENT_APPLY_WHATSAPP_NUMBER` is the single control point: every generated advert and every
tracked `PX-` apply link is built from it (`src/lib/recruitment/outreach/apply-destinations.ts`).
It is a **forward-only** switch — posts already pasted into Facebook groups keep the number they
were written with, and keep working exactly as before.

Pointing it at the Cloud API line is what removes the human forward from the loop: the CV arrives
by itself, and the applicant is asked the three classification questions while they are still in
the chat. The one thing it costs is that a Cloud API number **cannot be opened on a phone** — there
is no handset for the owner to read those chats on, and there never can be.

`whatsapp-conversation-mirror.ts` pays that back. Two moments reach his Telegram, which he already
carries:

| When | What he gets |
| --- | --- |
| A new direct applicant's CV is ingested (`intake-worker.ts`) | Their name, their dialable number, the file name, and their own message if they wrote one |
| They finish the three taps (`finishSession`) | Name, number, and the role / region / area **they chose themselves** |

Both are best-effort and can never throw: a Telegram outage must not touch a CV that has already
been captured. Both are gated to a **genuinely new direct applicant** — never an import sender
(that is a forwarder, not the applicant), never a re-match, and never a coexistence history replay,
which would otherwise mirror months of past CVs in a single burst the moment the handset is linked.

So an applicant's CV lands on the handset and enters the ATS **only when a human forwards a batch**
to the Cloud API line. This was a deliberate decision on 2026-07-27, when Meta Coexistence was not
offered in the dashboard. **Under that design a WhatsApp intake event measures HR's forwarding
activity, not applicant demand** — which is why 371 of 390 events are bulk forwards and why the
2026-08-23 gap was never a quiet channel: it was CVs piling up unread on a phone.

### The three questions, and what the applicant is actually asked (owner's list, 2026-08-28)

Question 1 offers **eight** roles, named by the owner in this order: Medical Representative, District
Manager, Regional Manager, Product Manager, National Sales Manager, Human Resources, Finance, Other.

That is deliberately **not** every role family. `sales` and `pharmacist` still exist and still bucket
CVs — they are simply not put to an applicant as a question, and anyone applying for either taps
**Other** and types it. Do not "restore" them to the menu; `tests/whatsapp-self-classification.test.ts`
pins the list and will go red.

**"Other" is a real answer, not a dead end.** Choosing it parks the conversation on a fifth step,
`job_title_other`, and the sender's next plain-text message becomes `applied_for_job_title` verbatim
— the top rung of the applied-for ladder, because a human typed it. The webhook checks for that step
*before* buffering text as CV context, so an answer is never mistaken for a note about a document.
Anything longer than 120 characters is refused with a nudge naming the limit rather than truncated:
text is never cut here.

`national_sales_manager` was added to the family list for this. All seven people in production
carrying that title previously fell into the `sales` catch-all and therefore sorted *below* every
medical rep in the screening queue; they are field force, and `screening-order.ts` now says so.

**Questions 2 and 3 come from the organogram, and nothing is gated on a vacancy.** Regions are the
company's own `au.regions` names; areas are read live from `au_v_canonical_areas`, filtered only on
`is_active`. An applicant may choose an area whose seat is currently filled — that is intended, and
the owner confirmed it on 2026-08-28: the answer is a *preference*, recorded so the person is already
in the pipeline when someone resigns. There is no vacancy check anywhere in this path and none should
be added.

**A forward is an application too (owner's instruction, 2026-08-28).** The questions used to be
skipped whenever Meta set `context.forwarded` on the message, on the reasoning that a forwarded CV is
HR moving a batch rather than a person applying. That reasoning was wrong twice over. Meta sets the
flag on *any* re-sent message, so an applicant forwarding their own CV out of their own chat — which
is how most people send a document they already have on their phone — was silently never asked
anything, and the owner's own end-to-end test failed at exactly this gate. Meanwhile the case the
flag was meant to catch is already caught properly by `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`, which
says *who* sent the message instead of guessing *what* it is. The flag is still written to the intake
queue row for the audit trail; it no longer decides anything. **The flow must behave identically
whether the CV arrives attached fresh or forwarded** — that is the owner's requirement, in his words
— so `startClassification` now has exactly one guard on this path: the import-sender list.

**Questions 2 and 3 have a typed escape too (owner's instruction, 2026-08-28).** Question 1 already
ended in **Other**; questions 2 and 3 did not, and that is a dead end the moment the organogram is
ahead of the menu. The owner hit it himself: he was hiring a District Manager into **Delta (3)** on
the day the region did not appear in the list, so the applicant for that seat could not name where
she was applying and could not type it either. Both questions now end in a row reading **My region is
not listed** / **My area is not listed**, which parks the conversation on a typed step
(`region_other`, `area_other`) exactly as `job_title_other` does. The same rules apply: the answer is
kept verbatim, whitespace collapsed, refused with a nudge naming the limit if it runs past 80
characters, never truncated.

Two details in that are deliberate and should not be tidied away:

- The row says **not listed**, not **Other**. `OT` is already a real selling region whose label is
  *Others* — two rows reading Other and Others would be a coin flip for the applicant.
- A typed region is written to **`preferred_region_name`**, never to `preferred_region_code`. Words
  in a code column is precisely the shape that produced undefined label lookups and NaN sort keys in
  production on 2026-08-24. An area is a name in both cases, so both forms share `preferred_area_name`.

**A region with no areas is now offered, and that inverted a test.** `areaMenu` is built from
`au_v_canonical_areas`, and Delta (3) went live in `au.regions` carrying target with **zero** rows
there. The old rule — every offered region must already have areas — would have kept D3 off the menu
indefinitely; the typed escape is what makes offering it safe, because a region with no areas asks
the applicant to type their area instead of dead-ending them. The escape row also costs one of
WhatsApp's ten list rows, so `areaMenu` slices to nine areas, and the test pins that at `MAX - 1`:
*Others* runs nine areas today and is exactly full.

**Known gap — nothing displays these answers yet.** `applied_for_job_title` is shown in the
recruitment workspace, but `preferred_region_code`, `preferred_region_name` and `preferred_area_name`
are written by this flow and read by **no screen at all** (they were added by #2495 and have never
been surfaced). The owner still sees every completed conversation on Telegram through
`whatsapp-conversation-mirror.ts`, so the answers are not invisible — but anyone looking for them in
the ATS will not find them. Surfacing them is a separate change.

### The bracket under each region and area row (owner's instruction, 2026-08-28)

"Delta (1)" is an **internal sales name**. Nobody outside the company knows which governorates it
covers, and an applicant who guesses wrong is filed against a district that will never call them.
The owner asked for a bracket under each row naming the places inside: *"just add a bracket ... so
the one who is applying, he knows, and don't choose something wrong."*

🔴 **THE HINTS ARE IN ENGLISH, like every other word the bot sends** (owner, 2026-10-04:
*"i want whatsapp replies all to be in english"*). They were Arabic from 2026-08-28, when he
accepted it in advance — *"even if in Arabic"* — because that is how bricks are named in this
database. The later ruling supersedes that. What is stored is unchanged: the bricks keep their
Arabic names in Source of Sales, and the hints are **transliterations** of those names, because
nothing reads a hint back. `tests/whatsapp-auto-replies.test.ts` sweeps every outbound surface and
fails on a single Arabic character.

**The bracket is a hint, never a choice.** The row the applicant taps is still the region or the
area, and `preferred_region_code` / `preferred_area_name` still store exactly what they tapped. The
bracket rides on the WhatsApp row's *description* line, which is display-only. He was explicit about
this: *"you will not change the menu ... you will just add a bracket ... but you will choose the
area, not the brick."*

```
Delta (3)      (Qalyubia · Sharqia · Ismailia · Suez)
Behira 2       (Kafr El-Dawwar · Abu Homs · El Mahmoudia)
```

Data lives in `src/lib/recruitment/inbound/whatsapp-classify-place-hints.ts`; the parentheses are
added by `rowFor` in `whatsapp-classify-menus.ts`, so the data file stays a clean list of names and
one place decides presentation. Three is a **cap, not a quota** — an area with two bricks prints two,
and Delta (3) prints all four of its governorates because four is everything it has and they fit.
A hint that omits a real governorate is worse than no hint: it actively pushes that governorate's
applicants onto the wrong row.

**A region hint follows the RECRUITMENT map, not the sales map.** The two disagree on purpose since
[#2509](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2509), which moved Qalyubia,
Sharqia, Suez and Ismailia onto Delta (3) in `governorateRegions` while deliberately leaving
`au_v_canonical_areas` alone until the August closing is published. The hints follow
`governorateRegions` because that is the vocabulary the Region filter on the CV database and the
recruitment pool search on — it decides whether a candidate is ever found. A registered assertion
pins all eight moves, so the next such change cannot land in only one of the two files.

**The AREA list is overridden to match, so the two questions can no longer disagree.** The area list
in question 3 is read from `au_v_canonical_areas`, which still files those five areas under the old
districts — and carries no Delta (3) row at all, so a bare read would show an EMPTY area list under
Delta (3) while *Qalubeya* still sat under Delta (1). `recruitmentAreaRegionOverrides`
(`candidate-region.ts`) re-files exactly those five areas onto Delta (3) for the apply flow only:
picking Delta (3) now shows Qalubeya, Sharkia 1/2, Suez and Ismailia, and Delta (1)/(2)/Others no
longer offer them, so an applicant can no longer file themselves as Qalyubia-under-D1. This moves
nothing in the database — sales, the closing and every other reader of `au.canonical_areas` are
untouched — and it becomes a no-op the day the sales side finally repoints those areas to Delta (3).
A registered assertion pins the five names. One disagreement is left standing deliberately:
**Matrouh** is Others in the recruitment map, but its bricks sit inside AREA *Alex West*, so Alex-BHR
is the only row whose area list can reach that job — AB therefore keeps Matrouh.

**Regenerating both sets.** Measured against production 2026-08-28: Source of Sales carries a brick
on 316,406 of 317,801 rows (99.6%, 615 distinct bricks). Everything attributes to **today's**
geography — the brick's current area, never the `area_code` frozen on the import row.

```sql
-- AREA hints — the 3 highest-value BRICKS in each area.
select b.area_code, b.brick_name, sum(r.value) as total_value
from source_of_sales_import_rows r
join source_of_sales_bricks b on b.brick_id = r.brick_id
group by b.area_code, b.brick_name
order by b.area_code, total_value desc;

-- REGION hints — the areas of each region by value, named as the GOVERNORATE a person would say.
-- Rank AREAS, never bricks: ranked by brick, Alex-BHR's top three come out Damanhour / Marsa
-- Matrouh / Kafr El-Dawwar with ALEXANDRIA ABSENT, because the city is split across many small
-- bricks and each loses to a single undivided brick elsewhere.
select v.code_region_code, v.area_code, v.area_name, sum(r.value) as total_value
from source_of_sales_import_rows r
join source_of_sales_bricks b on b.brick_id = r.brick_id
join au_v_canonical_areas v on v.area_code = b.area_code
where v.is_active
group by v.code_region_code, v.area_code, v.area_name
order by v.code_region_code, total_value desc;
```

Then map each region's top areas onto governorate names by hand — that step is judgement, not SQL,
because several areas are districts of one governorate (Cairo East 1/2 are both شرق القاهرة) and two
areas can share one (Sharkia 1 + Sharkia 2 are both الشرقية, and their values must be added before
ranking).

### Coexistence — what will change when the handset is linked (NOT LINKED YET)

> 🔴 **`01159888247` is not linked, and never has been.** The 2026-08-23 version of this section
> opened by saying the owner had completed the Meta Coexistence QR scan and that applicant messages
> were from then on delivered to this webhook. **That was wrong on the day it was written**, it was
> disproven the same evening from our own delivery data, and it stood uncorrected here for two
> weeks. Anything built on it — an alert, a report, a decision about where to advertise — was built
> on a link that does not exist.
>
> Measured on production, all time, re-run **2026-09-06**: `ats_cv_intake_events` holds **1,362**
> WhatsApp rows, **every one** delivered to `201098500699` (the Cloud API line) and **zero** to
> `201159888247`; 8 older rows predate the `deliveredToDisplayNumber` field. In WhatsApp Manager
> the handset still reads **Unverified** inside WABA "Sato Pharma HR Team", beside the **Connected**
> Cloud line. Its only role in this pipeline is the opposite one — **110 events arrived FROM**
> `+201159888247`, HR forwarding CVs off that phone by hand, most recently 2026-09-05 17:32 Cairo.
> **Manual forwarding never ended.**
>
> Why it never bound: the onboarding run on 2026-08-24 was refused inside Meta's own dialog
> (*"Phoenix HR Workforce can't onboard customers at the moment"*) because coexistence requires
> Solution Partner or Tech Provider status — Advanced Access on `whatsapp_business_management` and
> `whatsapp_business_messaging`. **App Review approved both on 2026-09-06**, so that gate is gone
> and the linking is now possible; it has still not been done. The remaining steps are in
> [whatsapp-app-review-submission.md](whatsapp-app-review-submission.md) § *After approval*.

Everything below describes what happens **once** the handset is linked. The code is written,
deployed and waiting; none of it is exercised today. Coexistence puts the advertised handset on the
Cloud API **without** taking WhatsApp Business off the phone. From that point:

- **New** applicant messages to the handset are delivered to this webhook on the `messages` field,
  exactly like the existing line. **No code or config change is needed for those** — the webhook has
  never filtered on `phone_number_id`; it records which line a message arrived on and accepts it.
- The **backlog** — every chat already on the handset — is replayed on a *different* webhook field,
  `history`, in a *different* envelope: `entry[].changes[].value.history[].threads[].messages[]`,
  two levels deeper than a live message and containing **both directions** of every conversation.

Two things follow, and both are already handled in code (built 2026-08-23, never yet exercised):

1. **The parser reads both envelopes.** Until this change it read `value.messages` only, so a
   backfill would have been answered `200 OK` and discarded — an entire CV backlog lost with no
   error recorded anywhere. Outgoing messages inside a replayed thread (whose `from` is the
   receiving line) are skipped, so the company is never filed as an applicant to itself.
2. **A replay is not an arrival.** Every replayed message is stamped `raw_metadata.historyImport`
   and excluded from the silence clock, from the public-reach measurement, from the live text
   buffer, and from the applicant auto-reply. Without that, linking the handset would reset every
   freshness measure at once — the same failure as a bulk forward, but with months of messages —
   and would thank every past applicant for a CV they sent weeks ago.

**`history` IS subscribed — re-read live 2026-09-06, and this reverses the 2026-08-23 reading.**
On 2026-08-23 the app's `whatsapp_business_account` subscription carried 10 fields, `messages`
among them but **not** `history`; it now carries 11 and `history` (v25.0) is one of them. The full
subscribed set today: `account_alerts`, `account_review_update`, `account_update`, `calls`,
**`history`**, `message_template_quality_update`, `message_template_status_update`, **`messages`**,
`phone_number_name_update`, `phone_number_quality_update`, `security`. So when the handset links
and the flow's history sync is confirmed, the backlog **will** be delivered and this parser is what
receives it — that path has still never run against real data.

**`smb_message_echoes` IS subscribed — since 2026-09-15 23:11 Cairo, at the owner's request.** It
carries what someone types on the HR handset's own WhatsApp Business app, so those replies show in
the WhatsApp Inbox: `src/lib/whatsapp-inbox/webhook-parse.ts` files each one as an outbound message
with origin `handset`, under the person it was sent to. It was added with one
`POST /v25.0/{app-id}/subscriptions` carrying all 12 fields (the 11 above plus this one) and read
back live: every field still v25.0, the subscription active, the callback unchanged, and Meta's
verification `GET` answered 200. **This parser never reads it** — it reads only `value.messages`
and `value.history` — so an echo cannot create a candidate, start screening or send an auto-reply.
Do not unsubscribe it on the strength of an older note that says echoes are off.

`smb_app_state_sync` stays deliberately **not** subscribed: nothing here reads it and nothing needs
it. Any later change to the subscription must `POST` every field, never the new one alone.

> **The exclusion filter has a NULL trap, measured, not guessed.** `historyImport` is *absent* on a
> live row, and PostgREST `raw_metadata->>historyImport=neq.true` evaluates to NULL — not true — for
> those rows, so it returns **nothing at all**. Against production the naive form matched **0 of 390**
> rows where the correct `or=(…is.null,…neq.true)` form matched **19 of 390** (390 total minus 371
> bulk forwards). A silence clock built on the naive filter would have reported "no inbound message
> ever" forever. Never write this filter as a bare `neq`.

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

`RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS` (**24** in Railway since 2026-08-28, lowered from 96
because over the preceding 45 days only 2 gaps exceeded 96h while 7 exceeded 24h — at 96 the alarm
could sleep four days while CVs piled up on the handset) sets both the paging threshold and the
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
| `RECRUITMENT_EMAIL_IMPORT_SENDERS` | addresses whose mail is a forward-import, not an application — an entry beginning `@` matches the whole domain (`@satopharma.com` covers every colleague). Put **senders** here, never a mailbox the app polls | unset |
| `RECRUITMENT_EMAIL_BACKFILL_DAYS` | first-run look-back per folder | 7 |
| `RECRUITMENT_EMAIL_MAX_MESSAGES_PER_POLL` | UIDs enqueued per folder per poll | 40 |
| `WHATSAPP_PHONE_NUMBER_IDS` | comma-separated intake lines to health-check | falls back to `WHATSAPP_PHONE_NUMBER_ID` |
| `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` | numbers whose messages are a bulk forward-import | unset |
| `RECRUITMENT_WHATSAPP_DIRECT_INTAKE` | `true` once applicants reach a line directly (coexistence live), which arms `public_channel_dead` | unset = forwarding mode |
| `RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS` | silence threshold (business hours only) | 24 |
| `RECRUITMENT_INBOUND_CV_MAX_BYTES` | max accepted CV size (also the WhatsApp media pre-download guard) | 15 MB |
| `RECRUITMENT_INBOUND_QUEUE_MAX_PER_RUN` | queue rows drained per worker tick | 10 |
| `RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED` / `_TEMPLATE` / `_LANG` | applicant acknowledgement (off) | off / unset / `en` |

## Cloud Scheduler

`phoenix-inbound-intake` (every 2 min, `--attempt-deadline=330s`) drains the queue;
`phoenix-recruitment-email-intake` (every 10 min) polls mailboxes + runs the health check. Both in
`scripts/setup-gcp-cron.sh`.
