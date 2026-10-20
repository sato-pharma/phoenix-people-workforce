---
name: telegram-connect-links-read-getme-not-the-env-username
description: "A Telegram connect deep link is built from getMe on the live token, never from TELEGRAM_BOT_USERNAME — so a stale env username breaks no link; its only effect is a display label, and the env-based buildTelegramDeepLink() has zero callers."
metadata:
  node_type: memory
  type: project
  originSessionId: ab5fd790-0dde-4d83-b770-150165ef14e7
  modified: 2026-10-20T02:15:00.000Z
---

🔴 **`TELEGRAM_BOT_USERNAME` IS NOT WHAT A CONNECT LINK IS BUILT FROM, SO A STALE VALUE IS NOT A
BROKEN-ONBOARDING DEFECT.** `resolveTelegramBotUsername()` in `src/lib/notifications/telegram.ts`
asks Telegram's **`getMe` with the live token** (cached ~5 min) and returns **null** rather than
falling back to the env value — deliberately, because a connect link is a credential and pointing it
at a possibly-stale bot is worse than failing loudly. `buildTelegramDeepLinkFromToken()` is the only
builder in use. 🔴 **The env-based `buildTelegramDeepLink()` has ZERO callers — it is dead code**, and
`telegramBotUsername()` survives only as a `Boolean(...)` in the config report and as a display
fallback in the provisioning report when `getMe` fails.

**The drift that prompted this (20 Oct 2026, 02:08 Cairo).** Production's two services carried
`TELEGRAM_BOT_USERNAME=PhoenixWorkspacePilotBot` while their `TELEGRAM_BOT_TOKEN` belonged to
**@sato_pharma_hr_bot** (bot id `8873696899`, "Sato Pharma HR - Phoenix Team"). I reported that as a
live defect sending every new connect link to the wrong bot — **that was WRONG**; the code had been
built to make exactly that impossible. The label was still fixed to `sato_pharma_hr_bot` on his word
(*"fix the telegram bot username on production"*) on `phoenix-people-workforce` and
`phoenix-workforce-worker`, both SUCCESS at 02:11 Cairo on the same commit `085d869d…`, healthz and
readyz 200. 🔴 **Read the CONSUMER before calling an env mismatch a defect** — `git grep` the getter,
and check whether the obvious-looking builder has any callers at all.

🔴 **`railway variables --set` REDEPLOYS that service immediately and bypasses the CI wait** — so
before setting one, confirm the serving commit is in `release_gates` (`select sha from release_gates
where sha = <healthz revision>`), or `/api/readyz` answers 503 and the new deployment never goes
healthy ([[the-release-gate-lets-railway-build-while-ci-runs]]). `.env.local` holds a DIFFERENT bot
(`8904947126` = @PhoenixWorkspacePilotBot), so a local script sends from the pilot bot unless it is
given production's token; settle which bot a token owns with `getMe`, never by a username variable,
and note the message-id gap gives it away too (pilot in the hundreds, live in the fourteen thousands).
