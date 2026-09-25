---
name: telegram-reaches-only-two-accounts
description: "Telegram delivers to exactly 2 accounts company-wide and ZERO managers — \"send it to Telegram\" reaches almost nobody"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e2a5a44-09c1-4b95-8b3b-ec6446552f83
  modified: 2026-08-09T09:42:47.900Z
---

Measured live in production on **2026-08-09**: `telegram_connections` holds **2 rows with
`status = 'connected'`** — `a-9` (Hossam, Marketing Manager) and `phx-1` (Phoenix System
Administrator). Six more sit at `status = 'pending'` with **no `telegram_chat_id`**, so they deliver
nothing.

**Zero District Managers, zero NSMs, zero RMs, zero reps have Telegram linked.**

Telegram *is* globally enabled (`notification_channel_settings.enabled_globally = true`, phase
`notification_only`), and the module governance layer works — so nothing looks broken. The channel
simply has no audience.

**Why:** shipping a notification "to in-app and Telegram" sounds like two channels and is one.
If a rule also removes email (as the Early Birds rule does — see
[[early-birds-is-in-app-and-telegram-never-email]]), the surviving reach is **in-app only**, and
saying "it now goes to Telegram" is a confidently-wrong statement to the owner.

**How to apply:** before promising Telegram delivery for any module, run

```sql
select status, count(*), count(*) filter (where telegram_chat_id is not null)
from public.telegram_connections group by status;
```

and say plainly who it will actually reach today. The config can still be correct and worth shipping
— each person starts receiving the moment they link — but report reach separately from
configuration. Related: [[verify-notification-deliveries-before-claiming-a-send]].
