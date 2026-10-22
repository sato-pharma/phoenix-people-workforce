---
name: the-2026-10-22-secret-rotation-keeps-old-values-until-22-nov
description: "After the 21 Oct Railway incident the leaked secrets were replaced on 22 Oct; PHOENIX_AUTH_SECRET_PREVIOUS (old links) and CRON_SECRET_PREVIOUS stay until 22 Nov 2026, then both go with src/lib/auth/previous-secret.ts; owner said never touch anything in Resend (API keys or webhook secrets) or revoke the careers@/hr.mailbox@ app passwords, or change any Turbify password."
metadata:
  node_type: memory
  type: project
  originSessionId: 03486b16-34ba-44b4-af4e-c44a32696de1
  modified: 2026-10-22T03:23:56.597Z
---

On 22 Oct 2026 (about 01:40–03:00 Cairo) the leaked Railway secrets that Claude could replace were rotated: the Supabase server key, PHOENIX_AUTH_SECRET, the attendance agent tokens, NOTIFICATION_WEBHOOK_SECRET and CRON_SECRET. The owner approved all of it ("automate changing everything u can automate i approve ur access").

- **PHOENIX_AUTH_SECRET_PREVIOUS** (Railway website + Fly): old e-mail/signature LINKS keep opening until 22 Nov. Logins, password resets, the native hand-off, seat view and payroll acknowledgment NEVER fall back (PR #6233, commit b1dbc2394).
- **CRON_SECRET_PREVIOUS** (Railway website + worker): all 43 cron-job.org jobs on the production domain were moved to the new secret, and two jobs succeeded after the move. The 4 jobs that called Railway's worker URL were moved at 03:40 Cairo to the Fly worker (`phoenix-worker-standby.fly.dev`) on the NEW secret, so no cron-job.org job uses the old value now.
- **MAILBOX_MONITOR_SECRET** was replaced at 03:10 Cairo, and the 3 stored mailbox app passwords were re-encrypted under it. The live host holds the new value (fingerprint c429af71181b).
- **Later the same night, all proven:**
  - PHOENIX_CLOSING_LOCK_PASSWORD, with the new value in `xlsx/railway-key-rotation/closing-lock-password.txt`.
  - MASTER_MAP_SYNC_TOKEN: the sheet adopted it with no gap.
  - The three `*_SHEET_REFRESH_WEBHOOK_SECRET`s.
  - FTP_VIDEO_HANDOFF_SECRET: the portal's copy was stored with no deploy, since the portal has been offline since 18 Sep.
  - PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD (04:55): a new memorable company pattern, in `xlsx/railway-key-rotation/new-mailbox-first-password.txt`. No mailbox had the old one recorded (all 29 new-joiner tasks pending, none sealed), so nothing was reset.
  - BREVO_WEBHOOK_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN (05:02). Brevo's one transactional webhook (2080303) carries the secret as `?token=` and was switched by API 0.7 s after the site took the new value. Meta's subscription (app 1725159208692148) was re-posted with the same callback and 12 fields and re-verified.
  - HEADWIND_MDM_PASSWORD (05:13 on Headwind). It is Phoenix's own Headwind login `phoenix` (account id 2, role Admin), NOT the owner's admin login, which was never in Railway.
    - It was changed through Headwind's self-change route `PUT /rest/private/users/current` {id, login, oldPassword, newPassword} (upper-case MD5).
    - That route touches only the password and clears the must-change flag. `PUT /rest/private/users`, by contrast, can set the flag when the server's password-reset setting is on.
    - The new value is kept only in Railway and Fly.
  - CLOUDFLARE_API_TOKEN copies are THREE DIFFERENT tokens. Proven 22 Oct by reading each id through the dashboard session, and by watching last-used move during a read-only `emergency-host status` run.
    - Railway's copy is "new": DNS edit on all zones, issued 8 Aug. It is leaked, and the app never reads it.
    - GitHub's copy is "Phoenix emergency host", issued 21 Oct 19:40 Cairo. The standby workflow switches DNS with it.
    - The laptop's `.env.local` holds "Edit zone DNS", issued 10 Oct.
    - No token can roll itself (code 9109). He rolled "new" at 05:31 Cairo; a clipboard WATCHER caught it (a one-shot clipboard read raced something else on the laptop that copies Google People JSON) and put it on Railway; the old value is refused (code 1000).
  - SENTRY_WEBHOOK_SECRET (05:08). It is the client secret of the internal integration "Phoenix Telegram alerts", which Sentry generates, and Claude cannot rotate it. The org token (`sntrys_`) has no access to the integration settings. The Chrome extension blocks reading it off the page, and the classifier refused carrying it out encrypted.
    - What worked: he clicked "Rotate client secret" at phoenix-crm.sentry.io/settings/developer-settings/phoenix-telegram-alerts-9b8b7e/ and copied the new secret.
    - A script then read it from the laptop clipboard (never printed), set it on Railway and Fly, and cleared the clipboard. A signed "not-json" probe answered 400 for the new secret and 401 for the old.
  - GITHUB_ACTIONS_DISPATCH_TOKEN (05:40). Railway's copy is the fine-grained token "phoenix-synthetic-dispatch" (id 17889094), NOT "phoenix-next". It sees hmdm-android, phoenix-people-workforce and sato-anti-infective-releases, and gets a 404 on the phoenix-next repository.
    - GitHub's token pages need his passkey (sudo mode), so Claude cannot read them.
    - He clicked Regenerate and Copy. A clipboard watcher applied the new value only after GitHub refused the old one (401), which is the proof it was the same token.
    - The new value went to Railway (website and worker), the GitHub secret PHOENIX_ACTIONS_DISPATCH_TOKEN and the Fly worker.
    - It was STAGED on phoenix-hr-standby (`flyctl secrets import --stage`, one key) while another session's go-live of 601b637 was building, so that deploy carried it. It is proven inside both Fly machines.

  Method and ids: [[the-live-sheet-script-ids-and-the-sheet-owner-clasp-login]], [[the-future-talents-portal-is-offline-and-its-relay-secret-waits-for-its-next-deploy]].
- 🔴 **Five owner decisions — never raise them again:**
  - **the Google Drive OAuth client secret and refresh token stay as they are** (22 Oct ~06:22 Cairo: "skip google drive").
  - **ACTION1_CLIENT_SECRET stays as it is** (22 Oct ~06:20 Cairo: "leave action1").
  - the careers@ and hr.mailbox@ app passwords are NOT revoked (22 Oct: "They're not important at all");
  - **nothing in Resend is touched: not the six RESEND_API_KEYs, not the six RESEND_WEBHOOK_SECRETs** (22 Oct ~04:25 Cairo: "donoy touch resend because they many accounts").
  - **no Turbify password is changed** (22 Oct ~06:15 Cairo: "i donot want to change turbify pws").
    - This covers PHOENIX_TURBIFY_ADMIN_PASSWORD, the Turbify account login (the achieverrr303 Gmail) that both mailbox robots use.
    - Read as plural, it also covers RECRUITMENT_EMAIL_INBOXES_JSON, the hr@ and careers@ mailbox passwords.
    - Turbify's steps (login.turbify.com/accountinfo → Security and Privacy → Change password) need his own sign-in. Claude never signs in to Turbify.

  Brevo, Sentry, the WhatsApp verify token and the GitHub dispatch token were done.
- The mailbox robots run inside the website's `/api/cron/mailbox-offboarding-sweep` route. cron-job.org calls it once a day at 08:15 Cairo. On 21 Oct its run ended with cron-job.org status 5, a timeout.
- cron-job.org's API allows 100 calls a day. Moving a job costs 2 calls (a GET and a PATCH).
- The per-key status is in `xlsx/railway-key-replacement-plan-2026-10-22-v11.xlsx`; always write a NEW version, never overwrite. The change log (names and fingerprints only) is in `xlsx/railway-key-rotation/replaced-keys-log.csv`.

**Why:** a fallback left in place forever turns the leaked value back into a working key.
**How to apply:** after 22 Nov 2026, check that nothing still sends the old cron secret (cron_unauthorized after removal = something missed). Then delete both *_PREVIOUS variables and the fallback in `src/lib/auth/previous-secret.ts`, in one PR. Related: [[railway-security-incident-2026-10-21-pauses-every-deploy]].
