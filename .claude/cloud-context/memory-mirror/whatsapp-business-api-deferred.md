---
name: whatsapp-business-api-deferred
description: "WhatsApp Business API considered as an extra Phoenix notification channel — deferred by owner on 2026-07-23, revisit later"
metadata: 
  node_type: memory
  type: project
  originSessionId: c35c2937-705a-47b4-9331-11b69e2b9d5d
  modified: 2026-07-23T12:03:19.897Z
---

Owner asked (2026-07-23) about adding WhatsApp Business API (Meta) as an additional
notification channel in Phoenix, alongside the existing email + Telegram bot
(`PhoenixWorkspacePilotBot`) system. Explicitly deferred: "mark whatsapp api to be done
later" — not prioritized right now, no code work started.

**Why raised:** field reps in Egypt often prefer WhatsApp over email/Telegram; owner was
scoping it as a possible extra channel for critical notifications (SLA alerts, digests),
not a replacement for the existing channels. Came up during the [[locationiq-geocode-provider]]
"what other free APIs could help elsewhere in Phoenix" conversation.

**Key facts already established, so the next session doesn't re-derive them:**
- Meta's WhatsApp Business Platform (Cloud API) bills/free-tiers by **conversation** (a
  24-hour messaging window per recipient), not per message — unlimited messages inside
  one open window count as a single conversation. Exact current free-tier conversation
  count should be re-verified at meta implementation time (pricing pages change).
- The Cloud API is **1:1 business-to-customer only — it does NOT support WhatsApp
  Groups**. There is no official/free way to post into a WhatsApp Group via API.
- For a company-wide **group/broadcast announcement** use case specifically, the
  existing Telegram bot is the better existing fit (Telegram bots support posting to
  groups/channels natively, free, already integrated) — recommended that route instead
  when the owner wants a "one group, everyone sees it" announcement channel.

**How to apply when this is picked back up:** WhatsApp Business API needs its own Meta
Business/Developer account setup — manual signup only the owner can do (same click-by-click
posture used for the LocationIQ signup, see [[locationiq-geocode-provider]]), not something
to build blind. Scope it as a 1:1 notification channel addition, not a group-broadcast
replacement.
