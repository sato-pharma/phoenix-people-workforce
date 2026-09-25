---
name: local-run-against-prod-db-silently-skips-every-email
description: "A notification script run locally writes to PRODUCTION Supabase but sends NO email — .env.local has RESEND_API_KEY yet no EMAIL_NOTIFICATIONS_ENABLED — and it burns the idempotency key permanently."
metadata: 
  node_type: memory
  type: project
  originSessionId: 55af0704-e4b4-4fdf-bfae-439d4a2433f0
  modified: 2026-08-19T19:32:50.531Z
---

Running a notification script from the laptop against production Supabase **writes real rows but
sends nothing**, and the failure is silent in the console — every line still prints `→ sent`.

`.env.local` points at the production database (see [[local-env-already-points-at-production]]) and
carries `RESEND_API_KEY`, so it *looks* fully wired. It does **not** carry
`EMAIL_NOTIFICATIONS_ENABLED`, which Railway's `production` environment sets to `true`. That flag is
a global kill switch checked at the provider gate, so every email lands as
`notification_deliveries.status='skipped'`, `last_error='EMAIL_NOTIFICATIONS_ENABLED is not true.'`
Push dies the same way on `OneSignal is not configured.`

**The damage is not recoverable by re-running.** `claimDelivery` upserts the idempotency key with
`ignoreDuplicates`, so the failed attempt has *claimed* the key. A re-run finds it taken and skips —
the same dedupe that correctly prevents a retro-blast now blocks the send that never happened. The
`notification_outbox` row is terminal `skipped` too, so the production drain will not pick it up.
Recovery means a **new** key (a `-b` suffix on the date), never a re-run.

Confirmed 2026-08-19 sending six outstation departure-photo nudges: first run 21:42 Cairo, all six
`skipped`; second run at 21:45 with `EMAIL_NOTIFICATIONS_ENABLED=true` prefixed and key suffix
`nudge-2026-08-19b`, all six recorded `sent` with empty `last_error`.

**That second run did NOT reach the provider either, and `status='sent'` is what hid it.** Proven at
22:31 the same night: `provider_message_id` was NULL on all six, `notification_outbox` has no row at
all for 21:45, and `email_delivery_events` holds no webhook receipt. A real send looks completely
different — the same reminder fired from PRODUCTION at 22:31 produced outbox row `1542a279…`
`status='sent'` with `provider_message_id='2b6c8503-8aad-4e5a-a9a0-e6de2593fb92'` and three webhook
rows (`email.sent`/`delivered`/`opened`). **So `notification_deliveries.status` alone proves
nothing** — the only proof an email left the building is a non-NULL `provider_message_id` plus a row
in `email_delivery_events`. A local run cannot produce those, whatever the flags say.

**Why:** the environment and the database are two separate things, and `.env.local` only aligns one
of them. "It wrote to production" does not imply "it behaved like production".

**How to apply:** before any local script that sends notifications, run it dry first, then prefix
`EMAIL_NOTIFICATIONS_ENABLED=true` (verify the real value with
`railway variables --environment production --service phoenix-people-workforce` first — do not
force a switch production has deliberately turned off). Afterwards **verify in
`notification_deliveries`, never from the script's own output** — the script cannot see the skip.
Related: [[never-fire-bulk-emails-ever]], [[railway-token-expired-breaks-all-secret-sync]].
