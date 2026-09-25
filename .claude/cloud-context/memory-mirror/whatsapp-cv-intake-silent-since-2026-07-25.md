---
name: whatsapp-cv-intake-silent-since-2026-07-25
description: "WhatsApp CV intake went silent 2026-07-25 because the Meta app sat in Development mode, where webhooks fire ONLY for listed test numbers — resolved 2026-07-26, and Live mode has since been confirmed (16 distinct senders, well past the 5-test-number cap). DURABLE: a silent intake with a healthy endpoint and no errors is an app-MODE question first, not a code bug — check Meta's mode before reading any code."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4dc462ab-253f-442c-8cc9-11e9e94d98fb
  modified: 2026-07-26T14:31:33.409Z
---

**RESOLUTION (2026-07-26 14:20 UTC):** root cause was the Meta app being in **Development mode**, where WhatsApp webhooks only fire for numbers added as test recipients. Owner added the forwarding number as a test recipient and immediately a CV came through end-to-end: candidate ESRAA HESHAM AHMED created from CV `Esraa_Hesham_Premium_ATS_CV-1.pdf` in ~7s, and — critically — AI extraction produced the FULL 12-field medical_rep set (fullName, university="German University in Cairo (GUC)", faculty="Pharmacy", governorate="Cairo", hasPriorWorkExperience=true, etc.), vs 0 fields for yesterday's pre-pdfjs-fix candidate. So both problems are confirmed fixed. NOTE: the sender number +201159888247 (Omar Gawish) is configured in `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` — the candidate was correctly built from the CV's own identity (Esraa), not the forwarder — i.e. bulk-import mode is active for that number (see [[whatsapp-cv-bulk-import-forwarding]]). STILL PENDING for unlimited/public applicants: switch the Meta app to Live mode (privacy URL https://phoenix-hr.satopharma.com/privacy is ready) + complete Meta Business verification + register a real business number. Until then only the ≤5 test recipients work.

--- Original investigation (kept for the diagnostic method) ---

Owner reported (2026-07-26, ~14:00 UTC) sending CVs to WhatsApp and nothing appearing in the system. Investigated with the app-side pipeline fully instrumented and confirmed healthy, narrowing the problem to Meta's side:

**Confirmed working (ruled out as causes):**
- **[RETARGETED 2026-08-27: the bullet below says these secrets live on the production Cloud Run service. GCP is DEAD (`BILLING_DISABLED` since 2026-08-01). They are now **Railway** variables on service `phoenix-people-workforce`, environment `production` — inspect with `railway variables --environment production`. Note a variable change DOES trigger a deploy here (corrected 2026-08-28 — the opposite claim read a build's latency as an absence); the value is inert only until that deploy reaches `SUCCESS`, which takes minutes. `AGENTS.md` §2.3.]**
- `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` are all set on the production Cloud Run service (`phoenix-hr`, europe-west3) — checked via `gcloud run services describe`.
- The webhook route (`app/api/webhooks/whatsapp/route.ts`) is deployed and reachable — confirmed with a live GET to `https://phoenix-hr.satopharma.com/api/webhooks/whatsapp` (403 as expected for a bad verify token, proving the route executes).
- `parseWhatsAppWebhookPayload` (`src/lib/recruitment/inbound/whatsapp-payload-parser.ts`) does NOT filter by phone_number_id — no code path could silently drop a message tied to the "wrong" business number.
- Sentry structured logging (`src/lib/observability/log.ts`, feeds both GCP Cloud Logging and Sentry's Logs view) is actively receiving other events continuously (cron, Resend webhook rejections, app errors) — so an empty search result is not a logging-pipeline gap.
- `ats_cv_intake_events` (production DB, project `ozucdzovmcqvepbozvqf`) shows exactly 2 rows EVER, both `channel = 'whatsapp'`, both from +201280955558 ("Omar Anwar"), both around 2026-07-25 00:45–00:59 UTC (`candidate_created` then `candidate_matched`) — proof the full pipeline (webhook → parse → media download → AI extraction → candidate creation) works correctly end-to-end when Meta actually calls it.

**The gap (DEFINITIVE — Cloud Run HTTP request logs, not just app logs):** the only WhatsApp webhook POSTs Meta (`facebookexternalua` user-agent) EVER sent were yesterday 2026-07-25 00:17–00:59 UTC. During that window there was a `403 × ~8 → 401(curl) → 200 → 200` sequence: the early 403s were Meta's cross-origin POSTs being blocked by CSRF BEFORE the `/api/webhooks/whatsapp` exemption in `proxy.ts` was deployed; once deployed, Meta's calls returned 200 and created the 2 candidates. **Today (2026-07-26): ZERO POSTs from Meta — only my own GET test.** Meta has stopped calling entirely. Cloud Run logs every HTTP request (my GET today is logged; yesterday's 403s are logged), so if Meta were calling and being blocked it would show — it isn't. This is Meta-side non-delivery, not our code failing silently.

**Strong hypothesis for WHY Meta stopped:** the ~8 consecutive 403 failures yesterday (before the CSRF exemption deployed) may have tripped Meta's auto-disable of the WABA "messages" webhook subscription — Meta degrades/disables a callback after sustained delivery failures. The later 200s may not have re-armed it. OR the app is in Development mode (only whitelisted test numbers like Omar's +201280955558 fire webhooks; a new applicant's number gets nothing). Both are dashboard-only fixes.

**SECONDARY bug, now FIXED: PDF CV field extraction was silently failing.** Omar Anwar's WhatsApp candidate has `extraction_count = 0` despite the CV PDF uploading fine — because yesterday's extraction hit the exact pdfjs "fake worker" bug fixed today in [[pdfjs-worker-tracing-gap-fix]] (PR #1362, deployed ~10:24 UTC). Same bug hit email PDF CVs: only 25 extractions exist for 59 candidates (DOCX via mammoth worked; PDF via pdfjs failed). So even when the webhook is restored, the fix from earlier today is what makes the AI fields actually populate. A successful extraction ran at 10:29 UTC today (post-deploy), consistent with the fix working.

**HEALTHY (ruled out): email intake IS running today.** `ats_cv_intake_events` shows 296 email `ignored_no_attachment` rows, latest 2026-07-26 12:44 UTC — the email poller cron runs and the shared `ingestInboundCv` pipeline is alive. No `error` or stuck `processing` outcomes exist for either channel. So the pipeline code is sound; only WhatsApp webhook DELIVERY is dead.

**Why this needs the owner, not more code changes:** this class of gap lives entirely in Meta's App/Business dashboard (developers.facebook.com → app → WhatsApp → Configuration), which Claude has no access to. Most likely explanations, roughly in order of likelihood:
1. Yesterday's successful test used a different number than what's being messaged today (e.g. Meta's temporary "API Setup" test number vs. the real connected business number) — the two can silently diverge if the business number's own webhook subscription was never separately verified.
2. The webhook subscription/token needs re-verification on Meta's side (Meta auto-unsubscribes after repeated delivery failures, though no failures were logged here).
3. Meta's own webhook delivery log (visible in that same dashboard tab) will show definitively whether Meta even attempted delivery and what response code it got — this is the fastest way to resolve ambiguity, and something only the owner can check.

**How to apply:** before writing any more code for this, get the owner to (a) confirm which WhatsApp number they're texting matches the number connected to `WHATSAPP_PHONE_NUMBER_ID` in this Meta app, and (b) check Meta's webhook delivery log for recent attempts/errors. Related: [[whatsapp-cv-bulk-import-forwarding]], [[whatsapp-business-api-deferred]].

## 2026-09-04 — Live mode is confirmed; the "still pending" line is closed

The description ended **"full Live-mode switch still pending."** It is not pending.

Production `ozucdzovmcqvepbozvqf`, `public.ats_whatsapp_inbound_messages`:

- **16 distinct `wa_id` senders** over the last 30 days (and 16 all-time)
- 23 inbound messages in 30 days
- newest inbound **2026-09-04 19:44 Cairo**

Meta's Development mode delivers webhooks only to a short allow-list of test recipients — five.
Sixteen distinct senders cannot happen under it, so the app is Live. The intake is also receiving
today, which settles the slug's "silent since" framing: **that outage is history, not current
state.**

One thing not to misread while you are here: the ATS is taking **355 candidates in 14 days, 112
in the last 48 hours**, but almost none of that is WhatsApp — it is the `careers@` mailbox
intake. The WhatsApp channel is 23 messages a month. Do not quote the candidate count as
WhatsApp reach; see the standing note that WhatsApp intake counts are not applicant counts.

**The durable lesson, which is why this file is worth keeping:** the endpoint was healthy, the
code was correct, and nothing logged an error — the channel was simply not being delivered to.
When an inbound integration goes quiet with no failures anywhere, check the provider's app mode
before you read a line of code.
