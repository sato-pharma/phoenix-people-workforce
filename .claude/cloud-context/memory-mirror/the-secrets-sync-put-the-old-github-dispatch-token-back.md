---
name: the-secrets-sync-put-the-old-github-dispatch-token-back
description: "On 13 Nov 2026 the secrets sync overwrote production's working GitHub dispatch token with the stale GitHub secret PHOENIX_ACTIONS_DISPATCH_TOKEN (a 4 Nov personal-account token), stranding the workflow watch and the synthetic journeys; GitHub's 403 named a token-lifetime limit, which was a symptom and sent the first fix to the wrong token."
metadata:
  node_type: memory
  type: project
  originSessionId: 661e96bd-04fa-4b4f-97cc-a593ea9ea6f6
  modified: 2026-11-14T02:01:12.464Z
---

**What happened.** `sync-railway-production-secrets` ran on a push at 17:38 Cairo on 13 Nov 2026 (run 43454705003, PR 325's merge) and logged `synced GITHUB_ACTIONS_DISPATCH_TOKEN` at 17:42. It copies the GitHub secret `PHOENIX_ACTIONS_DISPATCH_TOKEN` over the Railway variable. That secret was last updated 4 Nov, before the move to the `sato-pharma` organization, so it held the personal-account token `phoenix-dispatch` (id 22336216). The token that worked from 7 Nov, named `GITHUB_ACTIONS_DISPATCH_TOKEN` on the owner's token page (id 22544387, granted Actions write on the repository 7 Nov 12:35 Cairo, expires 8 Nov 2027), had been set on Railway only and never in the GitHub secret. Last good read 17:21, first refusal 18:21; `phoenix-github-workflow-watch` and `phoenix-run-synthetic-journeys` stranded.

**The misleading part.** GitHub answered the old token 403 with "The 'sato-pharma-phoenix' enterprise forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days", plus that token's settings link. That is true of the old token (it had no expiry) and is NOT why the jobs stopped. I read it as the cause and had the owner regenerate token 22336216 twice (14 Nov, about 03:10 Cairo); with an expiry it still could not dispatch, because its resource owner is his personal account. Cost: two wasted regenerations.

**Why:** a 403 body names the first rule the presented token breaks, not the reason the working token is gone. The question to ask first is "did the value on Railway change?", and the sync's run list answers it.

**How to apply:**
- A GitHub-token 403 on production: read `gh run list --workflow=sync-railway-production-secrets.yml` against the last good read BEFORE believing GitHub's message. See [[a-railway-variable-is-reverted-by-its-github-secret]].
- A new value for this token goes in the GitHub secret `PHOENIX_ACTIONS_DISPATCH_TOKEN` first, then the Railway variable `GITHUB_ACTIONS_DISPATCH_TOKEN`, in the same turn.
- The repository is public, so a token with no access at all still reads it (200). Only the write proves access: a dispatch to a ref that does not exist starts nothing and answers 422 when allowed, 403 when refused. The laptop's own `gh` login is the control (422).
- To tell which token a store holds without printing it: run a script under `railway run --service phoenix-people-workforce --environment production` that prints statuses only, and compare sha-256 hashes for "same or different".
- Still true on its own: the enterprise refuses any fine-grained token with a lifetime over 366 days, so a new token for `sato-pharma` needs an expiry of a year or less.
- His token page (14 Nov 2026): `phoenix-dispatch` 22336216 (personal, now expires 1 Nov 2027, useless for the organization), `GITHUB_ACTIONS_DISPATCH_TOKEN` 22544387, `ACTIONS_BILLING_READ_TOKEN` 22544020, `phoenix-code-backup` 22337938, `PHAROS dispatch` 22396204 (no expiry, untested).

**Fixed 14 Nov 2026, 03:18 Cairo.** A new token (expires 1 Nov 2027 Cairo) passed the probe (read 200, runs 200, dispatch 422) and was stored in the GitHub secret and the Railway variable in one turn. Both jobs ran on production at 03:21 and `job_heartbeats` shows `success` for each. That token needs replacing before 1 Nov 2027, in both places.

**The other 53 values that run rewrote (checked 14 Nov, his word "check the other 53 variables the sync rewrote").** The sync writes every non-empty secret unconditionally with `--skip-deploys`, so its "updated=54" is a count of writes, not of changes. Method: 52 of the GitHub secrets were dated 4 Nov and had already been written by the 6 Nov syncs, so only a hand change on Railway between 6 Nov 14:10 and 13 Nov 17:42 Cairo could have been reverted; each value was then tested live under `railway run`, printing statuses only. Result: none of the 53 is stale.
- Answered by their own service: Supabase (URL, ref, service role, anon, publishable), Telegram bot, Resend, Brevo, OneSignal, Cloudflare, Google Maps server key, Google Calendar, LocationIQ (`/v1/reverse` 200; its `/v1/balance` answers 403 for a working key, so never test with it), Sentry build token (200 listing releases for `phoenix-crm`; listing organisations answers 403 for a working token), both WhatsApp number ids.
- Proven by production's own traffic after the sync: `RESEND_WEBHOOK_SECRET` (198 delivery events recorded, latest 02:57), `PHOENIX_AUTH_SECRET` (14 sessions opened before the sync still in use after it; no burst of sign-ins), `CRON_SECRET` (cron routes answer 200), `HEALTHCHECKS_PING_KEY` (no "refused by Healthchecks" line in any of the 45 deployments since the sync, with the synthetic-dispatch refusal as the control that the search finds such lines), WhatsApp inbound still arriving (86 webhook POSTs, all 200).
- No real call since the sync, so traffic can neither prove nor fault them: `NOTIFICATION_WEBHOOK_SECRET` (Telegram sent no update; `getWebhookInfo` shows no delivery error; the single 403 on the route at 19:37 was a `curl` from a non-Telegram address), the three sheet webhook secrets (no refusal line logged), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (read only when Meta re-verifies the subscription). No hand change of any of them was found, so nothing suggests they moved.
- `OPENAI_API_KEY` answers 401 `invalid_api_key`, and has since 24 Oct 2026 (`app_error_events`: "OpenAI said auth_failed" from that day). Not the sync, and not in use: `AI_PROVIDER=anthropic` and both Anthropic keys answer 200.
- `ATTENDANCE_AGENT_TOKEN` could not be proven either way: the last punch upload was Wed 11 Nov 18:17 Cairo, before the sync, and none has arrived since (Thursday 12 Nov is missing too, so the gap predates the sync). The gap is the laptop's network, not the token: see [[attendance-agent-needs-the-office-lan]], "14 Nov 2026". The token is proven by the first upload after the laptop is next on the office Wi-Fi.

**Guarded since 14 Nov 2026 (his word "Guard the sync", then "merge 385 when green").** The sync no longer writes unconditionally: it holds a production value that differs from GitHub's until a person releases it by name. Merged as squash `c9eb7cf48`, serving production 04:00 Cairo; the first guarded run on `main` (43543530841) logged `written=0, unchanged=54, held=0, skipped=22`. Not exercised for real: the write of a released value, and the Telegram step. Details: [[a-railway-variable-is-reverted-by-its-github-secret]].

**Tooling traps met while reading Railway's logs from this laptop.**
- `railway logs <deployment-id>` for a REMOVED deployment prints nothing with `-n` alone; it needs `--since` (for example `--since 14h`).
- In Git Bash `--path /api/...` is rewritten into a Windows path and matches nothing; set `MSYS_NO_PATHCONV=1`, or use `--filter "@path:/api/..."`.
- `railway` on PATH is an npm shim; a node script must spawn `%APPDATA%\npm\node_modules\@railway\cli\bin\railway.exe`.
- A zero from a log search is proof only next to a control that is known to have traffic (the Resend webhook's POSTs).

Related: [[github-move-to-omar-3-xx-2026-11-04]].
