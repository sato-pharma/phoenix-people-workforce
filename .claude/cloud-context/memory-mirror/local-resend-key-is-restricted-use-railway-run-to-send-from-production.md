---
name: local-resend-key-is-restricted-use-railway-run-to-send-from-production
description: "The RESEND_API_KEY in .env.local cannot send at all (restricted key, unverified domain); the working way to send one real email is `railway run` with production's env injected."
metadata:
  node_type: memory
  type: project
---

**The `RESEND_API_KEY` in `.env.local` is DEAD for sending.** Probed live 2026-08-27: a direct
`POST https://api.resend.com/emails` returns **400** *"The associated domain with your API key is not
verified"*, and `GET /domains` returns **401** *"This API key is restricted to only send emails"*. So it
is a restricted send-only key bound to an unverified domain — it can do nothing.

This is a second, independent lock on top of the one in
[[local-run-against-prod-db-silently-skips-every-email]]: that memory says the local app path dies at the
`EMAIL_NOTIFICATIONS_ENABLED` gate, and implies forcing the flag might help. **It would not** — the
provider would reject the key anyway. Both doors are shut; do not burn an idempotency key discovering it.

**The working path — production's own credentials, never handled by you:**

```
railway run --service phoenix-people-workforce -- node <script-in-scratchpad>.mjs
```

`railway status` confirms the CLI is linked to `Phoenix-HR-Workforce` / environment **production**, so
`railway run` injects the real `RESEND_API_KEY` into the child process. The script reads
`process.env.RESEND_API_KEY` and POSTs to Resend; **the secret is never printed, never pasted into a
shell argument, and never lands in a permission allow-rule** (see
[[permission-allowlist-rules-can-embed-a-live-secret]]). Keep the script in the scratchpad, never the repo
tree, and delete it after.

Verified sender: `Phoenix Workforce <phoenix@send.satopharma.com>`
(`systemEmail.defaultFromEmail`, overridable by `NOTIFICATION_EMAIL_FROM`).

**This bypasses the app**, so there is no `notification_events`/`notification_outbox` row and neither the
always-BCC nor the Telegram mirror fires — **add the admin as an explicit `bcc` yourself** to honour
[[every-automated-email-also-mirrors-to-the-admin-telegram]]. Reserve it for a single owner-approved
message; [[never-fire-bulk-emails-ever]] still governs.

**Proof of a real send is unchanged:** a non-NULL provider id plus rows in `email_delivery_events`.
Confirmed 2026-08-27 sending one note to Khaled Bedair — Resend id
`44cc6861-f6a5-4801-a7b5-8cfd0a7f50a4`, HTTP 200, and four webhook rows
(`email.sent` + `email.delivered` for both recipients).
