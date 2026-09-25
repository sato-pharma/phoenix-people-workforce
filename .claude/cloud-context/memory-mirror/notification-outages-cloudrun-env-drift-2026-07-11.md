---
name: notification-outages-cloudrun-env-drift-2026-07-11
description: "2026-07-11 — email dead 2 days + Telegram broken on GCP; root causes were dropped/invalid Cloud Run env + Resend key type + webhook secret charset."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5fc35f6d-fde7-4c5d-9ca9-18c04c141b55
---

On 2026-07-11, verifying the Vercel→GCP migration surfaced **three real production notification failures**, all fixed same day. Cloud Run env is the source of truth for these runtime secrets (NOT git), and the migration/cleanup silently dropped several — treat Cloud Run env drift as a recurring risk.

**Email (was dead ~2 days, last real send 2026-07-09 16:42 UTC):**
1. `EMAIL_NOTIFICATIONS_ENABLED` was **absent** from the live Cloud Run service; `envFlag()` fails closed → ALL email silently off. Fix: set `=true`. (Also dropped in the same cleanup: `NOTIFICATION_EMAIL_FROM`, `HR_NOTIFICATION_EMAILS`, etc. — code falls back to `systemEmail.defaultFromEmail` = `phoenix@send.satopharma.com`.)
2. Resend rejected sends: the API key in Cloud Run was **"Sending access"** (domain-locked) → "domain not verified". Fix: owner created a **Full access** key. Domain `send.satopharma.com` is Verified in Resend.
3. Resend delivery webhook returned **401** (`RESEND_WEBHOOK_SECRET` mismatch vs Resend dashboard `whsec_`). Fix: owner synced the signing secret. Endpoint is correct: `https://phoenix-hr.satopharma.com/api/webhooks/resend`.
Verified end-to-end via `email_delivery_events` (email.sent + email.delivered) to omar.anwar@satopharma.com.

**Telegram (pilot, bot `@PhoenixWorkspacePilotBot`, only 3 test users):**
- Inbound webhook 403 → **`NOTIFICATION_WEBHOOK_SECRET` contained characters Telegram forbids** in a `setWebhook` `secret_token` (only `[A-Za-z0-9_-]`, 1-256). Permanent code fix (PR #996, merged): `telegramWebhookSecretToken()` in `src/lib/notifications/telegram.ts` passes a compliant secret through, else SHA-256-hex; used by both `provisionTelegramBot` setWebhook and the inbound webhook validator + `setup-telegram-bot.mjs`.
- Outbound "chat not found" for all 3 users → the stored chat_ids were dead for the current bot (bot changed since June-26 links). Fix: users **re-link** via Profile → Connect Telegram (needs inbound webhook working first; Telegram requires the user to press /start — cannot be automated). Admin `phx-1` re-linked + test `sent` OK. Other 2 pilot users must re-link the same way if wanted.
- Telegram global switch is intentionally meant OFF outside a short admin pilot window (its own pilotHealth warns this).

**Owner decisions this session:** Supabase **PITR left disabled** (too expensive) — accepted ~24h data-loss window on daily backups. GCP alert email channel (achieverrr303@gmail.com) verified. Supabase Auth Site URL confirmed = canonical.

Relates to [[gcp-cloud-run-migration-2026-07]], [[prod-excellence-waves-2026-07]], [[email-template-unification]], [[telegram-template-unification]].
