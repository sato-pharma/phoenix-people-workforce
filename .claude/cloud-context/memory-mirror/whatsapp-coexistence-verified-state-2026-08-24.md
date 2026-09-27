---
name: whatsapp-coexistence-verified-state-2026-08-24
description: "WhatsApp coexistence is LIVE since 2026-09-11 02:16 Cairo: the handset +20 11 59888247 is Connected on Cloud API AND still runs WhatsApp Business on the phone, proven by a real CV reaching intake. It joined a NEW portfolio 'Sato Pharma HR Recruitment' (phone_number_id 477586495433549), NOT 'Sato Pharma HR Team', because Meta refuses to let an app's own portfolio be its own customer. TWO WAYS TO BREAK IT, both on the phone: never tap the Settings 'Connected platform' card (it is tap-to-disconnect and the real iOS disconnect control was never found), and the app must be opened at least once every 14 days or Meta drops the connection - neither recovers without re-running onboarding. The history backlog never replayed and was ABANDONED by owner decision 2026-09-11 - do not re-propose reconnecting/resync. Handset echoes (smb_message_echoes) ON since 2026-09-15 23:11 Cairo. The advertised apply number on PRODUCTION is the automated 010 line (01098500699), not the handset. Tech Provider status is granted and App Review approved; the whole 08-24 to 08-28 App Review/screencast saga is history."
metadata: 
  node_type: memory
  type: project
  originSessionId: 39e63b91-d4ea-46c4-966d-11f2cf438e91
  modified: 2026-09-25T22:47:22.595Z
---

**Coexistence is LIVE since 2026-09-11 ~02:16 Cairo** — CVs sent to the handset flow into recruitment
intake automatically *without* losing WhatsApp on the phone (the owner chose coexistence, rejecting
migration outright). Proven end to end that night: a real CV reached the webhook, the queue took it,
the worker finished in ~5 s, the file landed on the right candidate. Everything below is the settled
operational state; the long App Review / Tech Provider onboarding saga (2026-08-24 → 09-06) is history
and has been cut. See [[recruitment-cv-received-is-in-app-and-telegram-never-email]].

## The live wiring

- **Handset `+20 11 59888247`** reads **`Connected`** in WhatsApp Manager AND still runs the WhatsApp
  Business app on the phone. It lives in a **NEW portfolio `Sato Pharma HR Recruitment`**, WABA
  `Sato Pharma` (`asset_id 365968989943377`, `business_id 4584343518461302`,
  **`phone_number_id 477586495433549`**). 🔴 **It did NOT join `Sato Pharma HR Team`** — on the
  asset-sharing step Meta **greys out** the existing portfolio and offers only *Create a business
  portfolio*, because the Tech Provider model assumes provider and customer are different companies.
  That is by design, not a fault. The webhook subscribed itself; nothing was wired by hand.
- **The old line `+20 10 98500699`** (`phone_number_id 1319071451278873`) is untouched — still
  `Connected`, quality High, still the Track-B funnel: a CV **forwarded** from the handset to it
  auto-captures (proven: a real forward completed the whole chain in 64 s). So coexistence only buys
  the **011** number; the capture side already worked.
- **Monitoring:** `WHATSAPP_PHONE_NUMBER_IDS` carries **both** ids (GitHub repo var → Railway,
  PR #3658). Without it the silence alert watched one line and the new one was invisible.

## 🔴 Two ways to break it — both from the phone

1. **Never tap the *Connected platform* card** in the handset's WhatsApp Business *Settings* — its own
   caption is *tap to disconnect*. A disconnect was attempted once and did NOT take (still read
   `Connected` afterward); **the real disconnect control on iOS was never located**, so treat the card
   as live.
2. **Open the app at least once every 14 days** or Meta drops the connection.

Neither is recoverable without re-running onboarding, and onboarding is popup-driven (below).

## 🔴 The history backlog is ABANDONED — owner decision 2026-09-11, do not re-propose

It never replayed (zero `historical` rows ~10 h after connecting; Meta simply did not send the
backlog, though our side was verified correct — `history`/`messages` v25.0 Subscribed, chat-history
sharing confirmed at onboarding). Asked and answered: *"ok leave it connected."* **Do not offer the
disconnect-and-reconnect/resync again** — it means deliberately breaking a working connection with no
evidence a retry behaves differently. The old CVs are **not lost** — they sit in the handset's own
WhatsApp chats. The sanctioned route for an old CV that matters is the one that has worked for months:
**forward it from the handset to `+20 10 98500699`**, which auto-captures (practical for a handful,
not hundreds). Detail: [[whatsapp-coexistence-backlog-arrives-on-a-different-webhook-field]].

⚠ **Do NOT press the `Test` button** beside a webhook field in the Meta dashboard — it pushes a
sample payload into the **live** intake and can create a fake candidate in production.

## Handset echoes ON since 2026-09-15 23:11 Cairo

Owner: *"turn on handset echoes for the WhatsApp inbox."* `smb_message_echoes` added to the app
subscription (12 fields, all v25.0, verification GET 200). A reply typed on the handset's WhatsApp
Business app lands in the WhatsApp Inbox as an outbound row with `origin = 'handset'`; **CV intake
never reads echoes**. `smb_app_state_sync` stays off. A manual reply route also exists:
`POST /api/recruitment/candidates/[id]/whatsapp-reply` (free text, 24-hour window enforced, sent from
the line they wrote to).

## The advertised apply number, and classification

- **`RECRUITMENT_APPLY_WHATSAPP_NUMBER` is `01098500699` (the automated 010 line) on PRODUCTION** —
  switched from the handset `01159888247` on 2026-08-28 (owner: *"automate everything"*). Every
  generated advert and tracked `PX-` apply link now carries `https://wa.me/201098500699`; the switch
  is **forward-only** (adverts already pasted into Facebook groups keep 011 and still work). Staging
  is deliberately still `01159888247`. Single control point:
  `src/lib/recruitment/outreach/apply-destinations.ts`, read at REQUEST time — so a `railway
  variables --set` is inert until the process restarts (do not report it live off `--set` alone;
  confirm by opening the advert composer or reading `railway status`).
- **The CV-classification menu (#2495) fires only on a DIRECT message to the Cloud API line** — a
  forward doesn't carry the original sender, so a relayed CV has nobody to ask. The Graph
  interactive-list POST is **proven** (Meta accepted a real `sendClassifyMenu()` payload) and is
  **side-effect-free** (writes no session row; a tap with no session returns `no_session`). To re-run
  the probe: `railway run --environment production` with the alias loader (credentials live only on
  Railway, never `.env.local`); verify the 24-hour window is open first.

## Traps that stay true

- **`extras` must carry `version:"v4"`** — v2 serves the Embedded Signup dialog with **no coexistence
  step at all** and fails silently (Meta retires v2 2026-10-08). `WHATSAPP_EMBEDDED_SIGNUP_EXTRAS` is
  an exported constant pinned by `tests/whatsapp-embedded-signup-extras.test.ts` (proved red by
  forcing `v2`). A wrong extras payload has no visible failure mode — assert on the constant, never
  the source around it.
- **A session cannot drive the Embedded Signup flow in the browser** — it is always a **popup window**,
  and `claude-in-chrome` only reaches tabs in its own group. Hand the click-by-click to the owner and
  **do not burn onboarding attempts** trying to automate it (Meta caps ~10 per rolling 7 days).
- **The inbound message table is thin.** `ats_whatsapp_inbound_messages` holds only
  `id, wa_id, body, received_at, created_at` — **no media columns** — and only `message.document` is
  enqueued (`app/api/webhooks/whatsapp/route.ts`). A text-only caption lands there and nowhere else,
  by design: *"the text arrived but I see no candidate"* is expected for a caption without a file —
  check the queue before concluding anything is broken.
- **Outbound autoreply is a DECISION, not a step.** `src/lib/recruitment/inbound/whatsapp-reply.ts`
  is a no-op until `RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED=true` + `..._TEMPLATE` + a token are all
  set. Setting them on Railway production means **every real applicant gets an automatic WhatsApp
  reply from then on** — the owner's call, never flipped to make a demo look better.

**Status of the gates (all cleared, kept only so a session doesn't re-open them):** Tech Provider
identification is done and **irreversible**; Access verification **Verified 2026-08-27**; App Review
**Approved 2026-09-06** (`whatsapp_business_messaging`, `public_profile`,
`whatsapp_business_management`). Do not re-litigate any of these as "probably refused" or "still
pending" — coexistence running live is the proof they passed.
