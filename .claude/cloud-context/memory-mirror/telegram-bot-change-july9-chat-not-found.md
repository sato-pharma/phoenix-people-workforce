---
name: telegram-bot-change-july9-chat-not-found
description: "Telegram notifications org-wide-dead since ~2026-07-09 — bot changed, every old link returns \"chat not found\" while app still shows \"connected\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e7381a8-f874-41f9-90a2-ec645d0445b9
---

2026-07-13: user reported a manager (CEO Anwar Gaweesh / AA) is "connected to Telegram but receives nothing." Confirmed real and SYSTEMIC, not per-user.

Evidence (prod notification_deliveries, channel=telegram): clean daily deliveries Jun 30–Jul 8 (3–16/day, ZERO "chat not found"), then a hard cliff — **Jul 9: 18 "chat not found"**, Jul 10–11 more, delivery collapses. AA, A-9, and PHX-1 (all previously working) ALL broke with "Bad Request: chat not found" on the SAME day (Jul 9). Only PHX-1 (chat 8726357045) recovered — someone re-linked it; it's the ONLY account receiving Telegram now. Only **2** telegram_connections rows are `status='connected'` in the whole system; AA shows connected (chat 7389018966, updated 13:31 Jul 13) but last actually-delivered was **Jul 9 13:02**, every attempt since = chat not found.

Root cause: a token *regeneration of the same bot* keeps chats valid — "chat not found" for many users at once means the **bot itself was switched** (different `TELEGRAM_BOT_USERNAME`/`TELEGRAM_BOT_TOKEN`) around Jul 9. Old user↔bot chats are with the OLD bot; the NEW bot has never been /start-ed by them → chat not found. Bot is selected by env `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME` (src/lib/notifications/telegram.ts); Cloud Run env is source of truth and has drifted before ([[notification-outages-cloudrun-env-drift-2026-07-11]]).

DECISION (2026-07-13, owner): the bot change was intentional — KEEP the current (new) bot, do NOT revert. Rationale: only ~3 real people ever used Telegram, the current bot is proven healthy (System Admin PHX-1 receives on it), and revert would only auto-restore ONE person (the CEO, the sole intact connected+chat row) while breaking the one working account and needing an old-token+server change. So: affected users re-link to the current bot; no revert.

WHO must re-link (names): Anwar Gaweesh (CEO), Hossam Mohamed Reda (Marketing Manager), Ahmed Sharaf Eldeen (Product Manager). Path: Profile → Notifications → Telegram → Connect → /start the bot. Only ~6 people ever set up Telegram; System Admin already works.

ACTIONS TAKEN 2026-07-13:
- Prod cleanup: reset the CEO's stale `connected` row (old-bot chat 7389018966) to `status='failed'` so the connect flow lets him re-link (it blocks re-link while status='connected' — see telegram-onboarding.ts line ~89). Reversible: reconnect overwrites it.
- Permanent code fix: **PR #1042** (branch codex/telegram-connection-health, commit ade25918) — OPEN, not merged. On permanent Telegram errors (chat not found / bot blocked / user deactivated / peer_id_invalid) it flips the connection to `failed` (keeps chat_id), stops retry churn, still falls back to email/in-app. New dependency-free module `src/lib/notifications/telegram-delivery-errors.ts` + unit test. typecheck/lint/test all green. Deploy is CI-gated AUTO after merge.

Data-integrity bug (now fixed by #1042): a "chat not found" send failure previously did NOT mark the connection broken — it stayed `status='connected'`, so the app lied about reachability and users never knew to re-link.

Separate secondary telegram issue seen same window: 176 telegram deliveries in 48h skipped "no exact authorized recipient resolved" (governance fail-closed on some governed/broadcast send) — distinct from the bot-change problem. Related: [[telegram-template-unification]], [[resend-daily-100-cap-429-outage]] (the same incident's EMAIL half).
