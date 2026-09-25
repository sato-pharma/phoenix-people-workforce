---
name: every-automated-email-also-mirrors-to-the-admin-telegram
description: "Every automated email now ALSO fires a Telegram to the standing admin (twin of the always-BCC) — where it lives and how to verify it, since there is no success log."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9e8b1216-66d8-49ed-88cf-b9f92453e937
  modified: 2026-08-26T20:06:56.070Z
---

Owner rule (2026-08-26, live in prod via PR #2431, commit `ec8426e4`): **every automated email
the system sends must ALSO fire a Telegram to the standing admin** — the Telegram twin of the
always-BCC. The admin is `omar.anwar@satopharma.com` (`B-10`), whose Telegram is `connected`.

**Where:** `mirrorEmailToAdminTelegram` in `src/lib/email/admin-telegram-mirror.ts`, called from the
ONE send chokepoint `sendPhoenixEmail` (right after `sendPreparedEmailWithFailover`). `ADMIN_STANDING_EMAIL`
in that module is the single source of truth for BOTH the always-BCC and this mirror. Coverage is
100% (notifications, templated, direct module sends) because every email funnels through that function.

**Why:** the admin's email copies (the always-BCC) land in his Outlook, where Focused-Inbox/Junk bury
them — proven he was receiving 925/925 but not seeing them. Telegram bypasses all mailbox filtering, so
it is how he actually catches direct orders / approvals / requests pending him.

**How to apply / verify:** it is **fire-and-forget and logs NOTHING on success** — so the ONLY proof a
mirror fired is (a) the admin's Telegram, or (b) the ABSENCE of `admin_telegram_mirror_send_failed` /
`admin_telegram_mirror_error` labels in Railway prod logs. It can never throw and never delays email; a
Telegram outage loses only the mirror, never the mail. It is **not retroactive** (owner rule: don't bulk
the neglected history — [[never-fire-bulk-emails-ever]]). Volume is ~30/day; if he calls it noisy, scope
it (approvals/orders only) or batch an hourly digest — one small change, don't rebuild.
