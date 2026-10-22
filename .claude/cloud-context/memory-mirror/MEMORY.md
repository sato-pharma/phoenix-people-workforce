# Memory Index

**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.

**Hooks only - the FILE is the fact. Rules: `AGENTS.md` §2.2.**
- [ARCHIVE](MEMORY-ARCHIVE.md) - the pre-2026-10-02 archive; every note in it is now filed in a module.

## 🥇 RULE #1 - never trim, never forget
- 🔴 [**`B-10` is the OWNER himself**](b-10-is-the-owner-himself.md) - sole Super Admin, so EVERY `decided_by` is his. Never advise him to "tell B-10" or notify him of his own decisions.
- 🔴 [**Monthly Closing** = the ONLY sales+target truth](sos-monthly-closing-is-the-only-sales-truth.md) - every surface reads ITS sales AND target (targets confirmed 2026-09-27); Weekly excluded; Marketing ROI the ONE exception.
- 🔒 [Head Office is in NEITHER weekly NOR monthly - unmapped is CORRECT](head-office-products-are-not-tracked-weekly-golden-rule.md) - tracked = **CNS · Anti Infective · Pedia** ONLY; HO is **90% of weekly VALUE**. NEVER flag or map it; ALWAYS filter before quoting a number.
- 🔒 [Lacto: family NAMES split; family_code still shared](lacto-advanced-and-basic-share-family-and-family-code.md) - `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); no bare `Lacto`. **Both keep family_code=`LA` DELIBERATELY** - the direct-order basket allow-list; tidying it un-combines the order.
- 🔴 [NEVER add units of different products/concentrations](units-of-different-products-are-never-added.md) - a unit total is valid for ONE product_code only; above that aggregate by **VALUE**. Same for TARGET units.
- 🔴 [Head Office is ABSENT from `phx_monthly_achievement`](head-office-sales-are-absent-from-phx-monthly-achievement.md) - no rows ≠ zero: it rendered real July units as 0. Royanoxicam DOES return (line NULL), Lacto Basic and Satoslim do not. `direct_value` is NOT the sales value; HO has NO price, units only.
- 🔴 Pre-July: [reconcile per customer×product](closing-reconcile-per-customer-product-not-area-pre-july.md)·[CURRENT price + backfill targets](closing-pre-july-revalue-and-backfill-targets-at-phoenix-price.md)
- 🔴 [a price fix RESTATES every published month](a-price-fix-silently-restates-every-published-closing.md) - INTENDED; drift sees VALUE now, price outside the lock. **July AI stays as published (owner).**·🔒 [the matrix can NEVER fit; summary ships BESIDE it](monthly-closing-matrix-cannot-fit.md) - leave the scroll.

## In flight
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → Yasmeena, cc B-10**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here

















Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.




























- [the Headwind sync endpoint is public and feeds the custody register](headwind-sync-endpoint-is-public-and-feeds-the-custody-register.md) - 2026-10-22: any tablet's config (incl. admin-password MD5) reads with no login; createNewDevices=false, so an unknown number does NOT create a device; the custody auto-register was removed by #6238 (a person confirms each tablet).
- [Headwind uploaded APKs vanish on redeploy; MQTT push is dead](headwind-uploaded-apks-vanish-on-redeploy-and-mqtt-push-is-dead.md) - Telegram/WPS/WhatsApp answer 404 (only RustDesk + launcher are re-provisioned); MQTT (port 31000) never arrived, so config 3 moved to polling over 443 on 22 Oct 04:10 Cairo (owner's word), the three 404 apps set to remove until their files exist.
- [PHX-TAB-0007 is the first rep-held tablet; 0003-0006 are fake](phx-tab-0007-is-the-first-rep-held-tablet.md) - issued 2026-10-11 to Gannatullah Amer (DEC-2026-0001); four Samsung rows from a 2026-09-25 dev.preview run are test data in production.
- [the worker's 21 Oct "Deploy failed" is Railway's security-incident pause](railway-security-incident-2026-10-21-pauses-every-deploy.md) - no build behind it; SUPERSEDED 22 Oct 03:38 Cairo — jobs run on the Fly worker, Railway's worker is stopped on purpose; never deploy it as a fix.
- [what should be done = Claude's work, not his](what-should-be-done-means-claudes-work-not-his.md) - after a finding, "what should be done" asks what CLAUDE builds; listing his HR clicks drew "I'm asking you about your work" (2026-10-22). Do the work in the turn.
- [a declined offer can follow real working days](a-declined-offer-can-follow-real-working-days.md) - the shortcut defaults "Include in payroll" to NO and the last day to the hire day; Shimaa Ibrahim worked 7 days (owner, 2026-10-22) but reads declined_offer, last day 2 Sep, unpaid. Read CRM first.
- [a line move then a backdated resignation erases the new seat](a-line-move-then-a-backdated-resignation-erases-the-new-seat.md) - Ahmed Nabil moved Anti-Infective to Pedia 1 Oct (owner, 2026-10-22), kept the old CRM account, and a resignation dated 30 Sep left his Pedia seat at zero days although he worked 1-6 Oct with the Pedia DM.
- [the background worker runs on Fly while Railway is down](the-background-worker-runs-on-fly-while-railway-is-down.md) - since 22 Oct 03:38 Cairo: Fly app phoenix-worker-standby runs the jobs (role worker, RAILWAY_ENVIRONMENT_NAME=production on purpose); Railway's worker stopped + set to role web; 4 worker cron jobs call its fly.dev address; every rotation and standby deploy must reach it too; ONE worker only.
- [the 22 Oct secret rotation keeps old values until 22 Nov](the-2026-10-22-secret-rotation-keeps-old-values-until-22-nov.md) - PHOENIX_AUTH_SECRET_PREVIOUS (old links only) and CRON_SECRET_PREVIOUS stay until 22 Nov, then remove both and src/lib/auth/previous-secret.ts in one PR; never touch anything in Resend, API keys or webhook secrets (owner, many accounts) or revoke the careers@/hr.mailbox@ app passwords, or change any Turbify password (owner, 22 Oct).
- [the fallback route is unproven: Railway pauses deploys too](the-repo-railway-token-is-dead-and-the-fallback-needs-an-account-token.md) - 2026-10-21: new RAILWAY_API_TOKEN works, but the rehearsal got "Deploys have been paused temporarily"; production never switched; rerun the rehearsal when the pause lifts, then `deploy=production`.
- [the live sheet script ids and the sheet-owner clasp login](the-live-sheet-script-ids-and-the-sheet-owner-clasp-login.md) - Master Map / Direct Orders / Marketing / CV Lifecycle ids proven 22 Oct by byte-compare; `clasp -u sheet-owner` = achieverrr303; list-scripts cannot see bound projects; a temporary HEAD push whose timer sets a Script Property rotates a secret; Direct Orders' web app runs an OLDER version that crashes after the secret check.
- [the Future Talents Portal is offline; its relay secret waits for its next deploy](the-future-talents-portal-is-offline-and-its-relay-secret-waits-for-its-next-deploy.md) - ftp-portal/web has no live deployment since 18 Sep (Railway fallback 404), last video claim 13 Sep, one waiting since 5 Oct; 22 Oct PHOENIX_VIDEO_RELAY_SECRET stored with --skip-deploys to match Phoenix's new FTP_VIDEO_HANDOFF_SECRET.
- [an editor moving a shared Apps Script web app breaks its /exec URL](an-editor-moving-a-shared-apps-script-web-app-breaks-its-exec-url.md) - /exec runs a saved version, not HEAD; moving the Direct Orders web app as achieverrr303 (editor, not owner) made it 403 for every caller on 22 Oct 2026 and moving back did not undo it — only the owning account can redeploy; PR #6244.
- [back-to-railway checks only that Railway answers, not its revision](back-to-railway-checks-only-that-railway-answers-not-its-revision.md) - the button flips to whatever Railway serves; on 22 Oct Railway still ran ed7797a85 (pre-rotation), so flip only after Railway serves main's released commit with readyz 200; owner's word ~05:30 Cairo: point production back at Railway when its deploys resume.
- [the mdm host split is merged but unbuilt while Railway is paused](headwind-host-split-merged-but-not-built-railway-paused.md) - #6250 merged 22 Oct 05:24 Cairo; Fly apps already use mdm-console; verify per runbook §8.10 when phoenix-headwind rebuilds, then his Access app + PHX_ACCESS_* vars.
- [a stalled enrolment run never sends the hardware report](a-stalled-enrolment-run-never-sends-the-tablets-hardware-report.md) - a new tablet long-polling with lastUpdate "never" stalled its first run (lost install-complete broadcast); the hourly update never sends the serial/IMEI report, only a restart or the agent's own home screen does — so Add to custody stays hidden until it is restarted (PHX-TAB-0008, 22 Oct).
- [config 3 restrictions + the six rep apps now install from Fly](config-3-restrictions-no-uninstall-no-location-toggle.md) - TRACKING ON 08:30 22 Oct (requestUpdates=GPS enum, never lowercase); 22 Oct to the shared rep ruleset: no_config_location + no_uninstall_apps applied; the six apps (Outlook/LinkedIn/Facebook/Waze/ChatGPT/TapScanner) served from phoenix-tablet-apps.fly.dev, action=1, PROVEN installing on 0008 07:33-07:38 Cairo with Railway untouched, old 3 Play apps set action=2 remove so the loop completes; rollout FLEET-WIDE incl Ganna's 0007 (owner "Let it get the apps"); deeper control (RustDesk kept alive, location forced on, reporting) is still the custom launcher.
- [6.41 launcher built + signed — completes location + unattended RustDesk](phoenix-launcher-6-41-built-completes-location-and-unattended-rustdesk.md) - fork branch phoenix/rustdesk-unattended-reporting, CI green 22 Oct, signed APK 6.0 MB; wires the location upload 6.40 left stubbed (0 rows), forces location on, keeps RustDesk alive on boot, reports status; one-time on-device capture/accessibility grant still needed. SHIPPED fleet-wide via Fly 22 Oct ~07:5x (owner "ship 6.41 fleet-wide via Fly now"): app-46 version row 10045 → 6.41/15410 pointed at https://phoenix-tablet-apps.fly.dev/hmdm-phoenix-6.41.apk (in-place version edit, config 3 untouched), verified read-only; same Phoenix key as installed 6.39 so no re-enroll; 0008 picks it up on next sync.
- 🔴 [GOLDEN RULE — until Railway is back, ALL deployments go through Fly.io](all-deployments-through-fly-until-railway-is-back.md) - owner 22 Oct ("ship 6.41 TO FLY.IO AND … ALL DEPLOYMENTS THROUGH FLY.IO"); never wait for Railway / never deploy to Railway while paused. Fly paths: worker=phoenix-worker-standby, web=emergency-host.yml (Frankfurt, his button), tablet apps+launcher=phoenix-tablet-apps.fly.dev. Retires only when he says Railway is back.
- [a launcher self-update leaves the agent dead until a reboot](a-launcher-self-update-leaves-the-agent-dead-until-a-reboot.md) - stock Lenovo home is not HOME, so 6.39→6.41 killed PHX-TAB-0008 at 07:59:30 22 Oct until a restart; 6.42 (fork phoenix/restart-after-self-update) restarts itself via MY_PACKAGE_REPLACED — LIVE on row 10045 via Fly, proven on 0008 08:24:40 (5 s, no restart). Tracking on 08:30 needed 6.43 too (location service now follows the rules at EVERY sync; row 10045 → 6.43).
- [production PostgREST row cap is not 1000](production-postgrest-row-cap-is-not-1000.md) - 22 Oct 2026: one unpaged read returned 143,671 production rows, so an audit finding built on "the 1,000-row cap truncates it" was false on production; probe the real ceiling (read-only select=id on a big table) before reporting such a defect; staging not probed.
- [rotate config-3 agent password on Railway resume](rotate-config-3-agent-password-on-railway-resume.md) - owner chose 22 Oct to rotate the 8-char default 12345678 in the SAME window the lockdown (#6250) reaches the live MDM server (phoenix-headwind rebuild), not now (would strand offline 0007 for no gain while the public leak is still open). Custody register now holds only the live rep tablets 0007 (Ganna) + 0008 (Ahmed); 0001/0002 retired 22 Oct 08:53 Cairo, 0003-0006 already retired.
