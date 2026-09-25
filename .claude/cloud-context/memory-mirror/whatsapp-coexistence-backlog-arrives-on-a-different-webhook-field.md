---
name: whatsapp-coexistence-backlog-arrives-on-a-different-webhook-field
description: "READ THE CORRECTION AT THE TOP: the 2026-08-23 QR scan NEVER bound 01159888247 - proven from delivery data, re-proven 2026-09-06 (1,362 whatsapp events, ALL on the Cloud line 201098500699, ZERO on the handset; 110 events arrived FROM it as a hand-forwarder). Coexistence delivers NEW messages on `messages` and the BACKLOG on `history`, a different envelope two levels deeper - and `history` IS subscribed as of 2026-09-06, reversing the 08-23 reading, so the backlog WILL arrive whenever the handset finally links. `smb_message_echoes` IS subscribed since 2026-09-15 (owner) - replies typed on the handset land in the WhatsApp Inbox as origin=handset; `smb_app_state_sync` still off."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4ea17475-2526-4b6e-a19c-ddc20cc6bb29
  modified: 2026-09-15T20:16:00.188Z
---

> 🔴 **CORRECTION — the sentence below is WRONG and is kept only as the dated record.** The scan did
> NOT bind the handset. Proven from our own delivery data on 2026-08-23 (see *Settled 2026-08-23*
> further down) and **re-proven 2026-09-06**: `ats_cv_intake_events` holds **1,362** whatsapp rows,
> every one delivered to **201098500699** (the Cloud API line), **ZERO** to 201159888247; 8 older
> rows predate the field. The handset's only role is the opposite one — **110 rows arrived FROM
> `+201159888247`**, i.e. HR forwarding CVs off it by hand, most recently 2026-09-05 17:32 Cairo.
> In WhatsApp Manager the number still reads **Unverified**. The same false claim is still
> uncorrected in `docs/recruitment-inbound-intake.md` §"Coexistence — what changes when the handset
> is linked". Manual forwarding never ended. See [[whatsapp-coexistence-verified-state-2026-08-24]]
> — App Review was APPROVED 2026-09-06, so the linking is now possible but has NOT been done.
>
> **Second correction, 2026-09-06: `history` IS subscribed now.** The `whatsapp_business_account`
> object carries 11 fields and `history` (v25.0) is among them; on 08-23 it carried 10 and `history`
> was absent. So the "backlog does not arrive at all" conclusion below is SUPERSEDED — it will arrive
> the moment the handset links and the sync is confirmed, on a path that has never run on real data.
> `smb_app_state_sync` is deliberately still off.
>
> **Third correction, 2026-09-15 23:11 Cairo: `smb_message_echoes` IS subscribed now**, at the
> owner's request ("turn on handset echoes for the WhatsApp inbox"). One `POST /v25.0/{app-id}/subscriptions`
> carrying all 12 fields; read back live: the 11 above unchanged, plus `smb_message_echoes`, all
> v25.0, active, same callback. A reply typed on the HR handset's WhatsApp Business app now lands in
> the WhatsApp Inbox as an outbound row with `origin = 'handset'`; before this, not one such row
> existed (only `contact` and `phoenix`). The CV intake parser reads only `value.messages` and
> `value.history`, so an echo can never create a candidate, start screening or send an auto-reply.
> Do not "fix" it back off because an older line says echoes are off.

The owner completed the Meta Coexistence QR scan for the advertised HR handset `01159888247` on
**2026-08-23**, ending the manual-forwarding architecture in [[whatsapp-silence-alert-is-a-weekend-false-positive]].

**Two envelopes, not one:**

| What | Webhook field | Shape |
| --- | --- | --- |
| A new applicant messaging the handset | `messages` | `value.messages[]` |
| The handset's existing chats, replayed once | `history` | `value.history[].threads[].messages[]` |

- **New CVs need no code or config change.** The webhook has never filtered on `phone_number_id`; it
  records the receiving line and accepts any of them.
- **The backlog needs `history` SUBSCRIBED in the Meta app.** Read live 2026-08-23 the app
  subscription carries 10 fields including `messages` but **not** `history`,
  `smb_message_echoes`, or `smb_app_state_sync`. Adding `history` is what triggers the replay.
- PR #2336 taught the parser both envelopes. Before it, a backfill was answered `200 OK` and
  **discarded** — a whole CV backlog lost with no error anywhere.

**A replay is not an arrival.** Replayed messages are stamped `raw_metadata.historyImport` and
excluded from the silence clock, public-reach, the live text buffer and the applicant auto-reply.
Without that, linking the handset resets every freshness measure at once (the bulk-forward failure
again, but with months of messages) and thanks every past applicant for a weeks-old CV. The
exclusion filter must use the `is.null` form — see
[[postgrest-neq-on-an-absent-jsonb-key-matches-nothing]].

**Cannot enumerate the WABA with the current token.** Scopes are `whatsapp_business_management` +
`whatsapp_business_messaging` only; `granular_scopes` exposes no `target_ids`,
`me/assigned_whatsapp_business_accounts` is empty, `me/businesses` is `(#100) Missing Permission`,
and `?metadata=1` introspection is off. **The new handset's `phone_number_id` therefore only
reveals itself on the first inbound message**, via `raw_metadata.deliveredToPhoneNumberId`.

**Why the Development-mode theory was wrong:** `GET /{phone-number-id}?fields=account_mode` returns
`LIVE`. Confirmed by a field, not inferred from a 2-of-2 coincidence.

**Still to do once a real inbound proves delivery:** set `RECRUITMENT_WHATSAPP_DIRECT_INTAKE=true`
and add the handset's id to `WHATSAPP_PHONE_NUMBER_IDS` (currently unset; health probes one line).
`RECRUITMENT_WHATSAPP_IMPORT_SENDERS` is `01159888247,201280955558` and stays as is — the handset is
now a receiver, so it never appears as a sender on a direct application.

## Verified 2026-08-23 evening: the scan did NOT take effect

`history` was subscribed via `POST /{app-id}/subscriptions` (11 fields; the endpoint **REPLACES**
the field list, so always send the union — sending `history` alone silently unsubscribes
`messages`). Snapshot of the prior 10 fields kept before the write.

Then a real test message was sent to `01159888247`. **Nothing arrived in 15 minutes** — no buffered
text, no intake event, no queue row, 0 network blips. No history replay either.

Everything on our side proves healthy at that moment: `messages` + `history` subscribed, callback
URL correct, subscription `active`, number `CONNECTED`, `account_mode` `LIVE`, parser deployed
(`c61fc4da`), endpoint answering **403** on a bad verify token and **401** on an unsigned POST, and
no rejection events in the logs.

**So the handset is not bound to the WABA this app is subscribed to.** Most likely the QR was
scanned from a different WhatsApp Business Account, or the phone runs regular WhatsApp rather than
the WhatsApp **Business** app (coexistence requires the Business app). The check is whether
`01159888247` appears in WhatsApp Manager under the SAME account that owns `+20 10 98500699`.

**A text message is the wrong detector unless you know where it lands:** text creates NO intake
event and NO queue row — it goes to `ats_whatsapp_inbound_messages`, which is emptied on
consumption and by a retention sweep, so 0 rows is its normal resting state.

## Verified 2026-08-23 20:00 Cairo — the FORWARDING path is proven working; coexistence still isn't

HR forwarded one CV from the handset. Full chain, measured, no gaps:

| Step | Cairo | Evidence |
| --- | --- | --- |
| Document received | 19:51:17 | queue row, `channel=whatsapp` |
| Worker drained it | 19:54:03 | `outcome=candidate_created`, `attempts=1`, `last_error=null` |
| Candidate live | 19:54:16 | Abdelrahman maher · source `whatsapp` · status `new` |

Captured envelope: `from +201159888247` → `deliveredToDisplayNumber 201098500699`,
`deliveredToPhoneNumberId 1319071451278873`, **`historyImport = false`**.

Two things this settles:

1. **A forward from the handset to the Cloud API line works today and takes ~3 minutes.** That is
   the production path, unchanged by coexistence. `historical:false` confirms it came on the
   `messages` envelope, not `history` — so it is a live forward, NOT a coexistence replay.
2. **The inbound-intake drain cron is ALIVE.** Its `done` history had sat untouched since 08-22
   22:36, which reads exactly like a dead scheduler — it is not. **An idle queue makes a healthy
   cron look dead; the only honest test is to put a row in and watch it move.** I nearly reported
   the scheduler as broken on the strength of that stale timestamp alone.

Coexistence itself is still NOT active — `is_on_biz_app` reads `false` on `+20 10 98500699`, so the
`history` backfill has never fired. The parser fix (PR #2336, `c61fc4da`) is deployed and waiting.

## Settled 2026-08-23 20:30 Cairo — coexistence has NEVER delivered a single message

Do not re-test this by asking the owner to send anything. The answer is in our own table:

```
delivered_to      events  candidates  first       last
201098500699        383       336     2026-07-27  2026-08-23
(not recorded)        8         2     2026-07-25  2026-07-26   <- before the field existed
201159888247          0         -     -           -
```

**Every WhatsApp message the webhook has ever received arrived on the Cloud API line.** Zero on the
advertised handset. So the QR scan did not bind `01159888247` to the WABA this app is subscribed to
— that is now proven from delivery data, not inferred from `is_on_biz_app`.

**`is_on_biz_app` on `+20 10 98500699` is the WRONG field to judge this by** — it is a pure Cloud API
number (`platform_type: CLOUD_API`), so `false` is its correct, expected value and says nothing about
the handset. I misread it as evidence earlier.

**The WABA id cannot be enumerated with the production token.** It is a permanent `SYSTEM_USER`
token on app `1725159208692148`, scopes `whatsapp_business_management` +
`whatsapp_business_messaging` + `public_profile`, `granular_scopes` with **no `target_ids`**. All of
these fail: `me/assigned_whatsapp_business_accounts` → `{"data":[]}`,
`me/owned_whatsapp_business_accounts` / `{app-id}/whatsapp_business_accounts` → nonexisting field,
`{app-id}/subscriptions` → `(#190) Application Secret required`, `me/businesses` → `(#100)`.
**The only place the WABA id appears is `entry[].id` on an inbound webhook, which the parser does
not record.** Capture it there if it is ever needed.

> 🟢 **But a DIRECT read of the KNOWN WABA id DOES work, and it is the Chrome-free link check.**
> Measured 2026-09-06: `GET /v23.0/2265574670642375/phone_numbers?fields=display_phone_number,status,`
> `platform_type,quality_rating,is_on_biz_app` with that same token returns **200**. Only the
> `me/...` ENUMERATION forms fail — the id itself is not the problem, so never conclude from an empty
> `me/assigned_whatsapp_business_accounts` that the token cannot see the account. Run it as
> `railway run --environment production -- node <script>` (the token is on Railway, never in
> `.env.local`), read it with an `Authorization: Bearer` header, and NEVER print the token.
> Reading 2026-09-06 22:0x Cairo: `+20 10 98500699` **CONNECTED** / CLOUD_API / GREEN
> (`1319071451278873`), `+20 11 59888247` **PENDING** / NOT_APPLICABLE / UNKNOWN
> (`1255408954325385`). **PENDING is what the dashboard calls "Unverified"** — same fact, two words.
> `is_on_biz_app: false` on the CLOUD number is CORRECT and says nothing about the handset.

**Nothing on our side blocks a handset message.** `RECRUITMENT_WHATSAPP_DIRECT_INTAKE` and
`WHATSAPP_PHONE_NUMBER_IDS` are read ONLY by `whatsapp-health.ts` (`:181`, `:243`) — they feed the
health check and gate nothing in the webhook. The webhook never filters on `phone_number_id`. So the
moment coexistence binds, ingestion works with no code change and no env change.

## The intake pipeline itself is 100% healthy — stop suspecting it

```
queue: 628 rows, ALL done. 0 queued / 0 processing / 0 dead, ever. max attempts 2.
events: 391 whatsapp -> 338 candidate_created + 30 candidate_matched
                      + 18 ignored_unsupported_attachment + 5 ignored_no_attachment
```

The 18 are all `messageType: image` from the bulk forwarder — the photo-CVs-are-certificates case
already established in [[whatsapp-import-images-return-nothing-from-vision]]. Correct behaviour, not
loss. **338 WhatsApp candidates are already in the ATS; there is no backlog to re-send.**
