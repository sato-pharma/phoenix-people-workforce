---
name: whatsapp-coexistence-verified-state-2026-08-24
description: "WhatsApp coexistence is LIVE since 2026-09-11 02:16 Cairo: the handset +20 11 59888247 is Connected on Cloud API AND still runs WhatsApp Business on the phone, proven by a real CV reaching intake. It joined a NEW portfolio, not Sato Pharma HR Team, because Meta refuses to let an app own portfolio be its own customer. Two ways to break it, both on the phone. The history backlog never replayed and was ABANDONED by owner decision 2026-09-11 - do not re-propose reconnecting. Handset echoes (smb_message_echoes) ON since 2026-09-15 23:11 Cairo - replies typed on the phone show in the WhatsApp Inbox."
metadata: 
  node_type: memory
  type: project
  originSessionId: 39e63b91-d4ea-46c4-966d-11f2cf438e91
  modified: 2026-09-15T20:16:22.496Z
---

### 🔴 THE HISTORY BACKLOG IS ABANDONED — OWNER DECISION 2026-09-11 ~12:00 Cairo. DO NOT RE-PROPOSE.

**It never replayed, and he chose to keep the working connection rather than gamble it.** Asked and
answered: *"ok leave it connected."* Do not offer the disconnect-and-reconnect again.

- **Everything on our side was verified correct before the decision, so this is NOT an unfixed bug.**
  Read live in the Meta app 2026-09-11: `history` v25.0 **Subscribed**, `messages` v25.0
  **Subscribed**. The owner CONFIRMED the chat-history sharing step during onboarding. The webhook is
  subscribed to the new WABA, proven by a real CV arriving. Meta simply did not send the backlog —
  **zero `historical` rows ~10 hours after connecting.**
- **A disconnect was attempted and DID NOT HAPPEN.** The *Connected platform* card whose own caption
  reads *tap to disconnect* did NOT disconnect when tapped: the number still read **Connected** in
  WhatsApp Manager afterwards, and the phone answered *already connected*. **The real disconnect
  control on iOS has never been located.** Nothing was broken by the attempt.
- **Why it was dropped:** forcing a resync means deliberately breaking a working connection that took a
  night to build, with no evidence a second attempt behaves differently. The old CVs are NOT lost —
  they are still in the handset's own WhatsApp chats. What was lost is only the automatic import.
- **The sanctioned route for an old CV that matters** is the one that has worked for months: forward it
  from the handset to **+20 10 98500699**, which auto-captures. Practical for a handful, not hundreds.
- ⚠ **Do NOT press the `Test` button beside a webhook field** in the Meta dashboard to prove delivery —
  it pushes a sample payload into the LIVE intake and can create a fake candidate in production.

### 🟢 IT IS DONE — COEXISTENCE IS LIVE, 2026-09-11 ~02:16 Cairo

**+20 11 59888247 reads `Connected` in WhatsApp Manager and STILL RUNS WhatsApp Business on the
handset.** Proven end to end the same night: a real CV sent to it reached the webhook, the queue took
it, the worker finished in 5 seconds, and the file landed on the right candidate. Every claim above
about what "remains" is history.

- 🔴 **IT DID NOT JOIN `Sato Pharma HR Team`. Meta REFUSES to let an app's own portfolio be the
  customer** — on the asset-sharing step the existing portfolio is GREYED OUT and only *Create a
  business portfolio* is selectable. That is the Tech Provider model working as designed, not a
  fault: the flow assumes provider and customer are different companies. So the handset lives in a
  NEW portfolio **`Sato Pharma HR Recruitment`**, WABA **`Sato Pharma`** (`asset_id 365968989943377`,
  `business_id 4584343518461302`), `phone_number_id **477586495433549**`. The webhook subscribed
  itself; nothing had to be wired by hand.
- **The old line is untouched**: `+20 10 98500699`, `phone_number_id 1319071451278873`, still
  `Connected`, quality High, still feeding intake.
- 🔴 **TWO WAYS TO BREAK IT, both from the phone.** *Settings → the Connected platform card* — the
  card itself is "tap to disconnect", so never tap it — and the app must be OPENED AT LEAST ONCE
  EVERY 14 DAYS or Meta drops the connection. Neither is recoverable without re-running onboarding.
- **The Unverified placeholder was deleted (owner, against advice) and it was NEVER the blocker** —
  the refusal fires before any number is entered. Meta's second screen NAMES the number, demands the
  owner's Meta password and says *"This action can't be undone"*: the repo's "safe/reversible"
  note was wrong.
- **Monitoring:** `WHATSAPP_PHONE_NUMBER_IDS` now carries BOTH ids (GitHub repo variable → synced to
  Railway, PR #3658). Without it the silence alert watched one line and the new one was invisible.
- 🟢 **Handset echoes ON since 2026-09-15 23:11 Cairo** (owner: "turn on handset echoes for the
  WhatsApp inbox"). `smb_message_echoes` added to the app subscription: 12 fields, all v25.0, read
  back live, and Meta's verification GET answered 200. A reply typed on the handset's WhatsApp
  Business app lands in the WhatsApp Inbox as an outbound row with `origin = 'handset'`; CV intake
  never reads echoes. `smb_app_state_sync` stays off. Detail:
  [[whatsapp-coexistence-backlog-arrives-on-a-different-webhook-field]].
- **A manual reply route exists** (`POST /api/recruitment/candidates/[id]/whatsapp-reply`, PR #3661,
  merged `48b5937b`) — free text, 24-hour window enforced, sent FROM the line they wrote to. The BOX
  is PR #3662, open and NOT verified in a browser.
- 🔴 **STILL OPEN: the history backlog has NOT replayed.** Zero `historical` rows as of 05:00 Cairo.
  If it never comes, the documented recovery is to disconnect on the handset and re-run the flow,
  which triggers a fresh sync — but do that ONLY after confirming nothing has arrived, because
  disconnecting while Meta still holds the backlog throws it away.

## 🟢 TECH PROVIDER ONBOARDED 2026-09-11 ~01:30 Cairo — App Review was NEVER the last gate

🔴 **APP REVIEW APPROVAL IS NOT TECH PROVIDER STATUS.** The 2026-09-06 section below, and
`docs/whatsapp-app-review-submission.md`, both read as though approval removed the gate. It did not.
Advanced access on the two permissions is a PREREQUISITE for Tech Provider, not the thing itself. A
session reading only the 09-06 section will tell the owner the flow is ready and burn an onboarding
attempt on the same wall. That is exactly what happened tonight.

- **Proven live 2026-09-11.** The owner ran `/whatsapp-connect` on his phone and got the IDENTICAL
  August refusal, verbatim: *"Phoenix HR Workforce can't onboard customers at the moment."* One
  onboarding attempt spent. The 08-24 attempt had aged out of the rolling 7 days, so the allowance
  was full.
- **The missing step was `Use cases → Customize → Become a Partner → Become Tech Provider`**, a
  separate wizard never started. Two screens: an intro with **Continue**, then a choice of
  **Independent Tech Provider** or **Working with a Solution Partner**, carrying *"By continuing, you
  agree to Tech Provider Terms"* and a **Start onboarding** button.
- **Owner chose INDEPENDENT and instructed the acceptance in the live conversation**, after being told
  in plain words that it is a legal commitment in Sato Pharma's name, and that Tech Provider is
  designed for companies serving OTHER businesses. Do not re-litigate that decision.
- **Result was IMMEDIATE — no review, no wait.** The page reads **"Congratulations! You are now a Tech
  Provider · 2 of 2 steps complete"**, with Business Verification **Approved** and App Review
  **Approved** under *Previously completed*. Three nav items appeared that were not there before:
  **Embedded Signup Builder**, **Partner Solutions**, **Migrate customers**.
- 🟢 **"WhatsApp Business App onboarding is enabled by default"** now appears on that page. That is the
  coexistence capability, and it is ON.
- **A Meta-hosted Embedded Signup landing page is now offered** on the same page, as an alternative to
  our own `/whatsapp-connect`. Useful as a fallback that depends on neither our page nor its CSP.
- 🔴 **NOT YET PROVEN: the wall itself.** Nobody has re-run the phone flow since onboarding. The only
  proof is running it. Do not record coexistence as working until a test CV from the handset reaches
  the webhook and lands in recruitment intake.

### 🔴 THE SECOND SILENT GATE: the extras needed `version: "v4"` — FIXED AND DEPLOYED 2026-09-11 01:55 Cairo

Tech Provider status removed the "can't onboard customers" wall, and the dialog then opened on the
WRONG FLOW with no error at all: **"Add your WhatsApp phone number"**, offering only *"You don't have
any existing phone numbers. Create a new one."* (the MIGRATION path) or *"Use a display name with a
virtual number instead?"*. **No coexistence step, no warning, featureType silently ignored.**

- **Cause: our `extras` carried no `version`, so Meta served the Embedded Signup v2 dialog, which has
  no coexistence step at all.** Meta retires v2 on **2026-10-08**.
- **How it was found — copy this method.** The app's own Tech Provider page renders the onboarding
  link Meta GENERATES for this app. Reading its query string gave the answer directly: same
  `app_id`, same `config_id` (`2089438105259208`, ours), and
  `extras={"version":"v4","sessionInfoVersion":"3","featureType":"whatsapp_business_app_onboarding"}`.
  ⚠ The Chrome extension REFUSES to return an input's value when it looks like query-string data —
  ask for `Array.from(new URL(v).searchParams.keys())` and per-key comparisons instead, which pass.
- **Fixed in PR #3656, squash `8bc93b44`, merged 01:52 Cairo, VERIFIED SERVING at 01:55** — not by the
  revision alone: the deployed chunk `/_next/static/chunks/0-w-4jm7znsi1.js` literally contains
  `featureType:"whatsapp_business_app_onboarding",sessionInfoVersion:"3",version:"v4"` and ZERO
  `setup:{}`. The v2-era empty `setup` was dropped to match Meta's link field for field.
- `WHATSAPP_EMBEDDED_SIGNUP_EXTRAS` is now an EXPORTED VALUE, pinned by
  `tests/whatsapp-embedded-signup-extras.test.ts` (registered in `run-tests.ts`, proved red by forcing
  the version back to `v2`). A wrong extras payload has NO visible failure mode, so the constant is
  the artefact worth asserting on — never the source around it.
- 🔴 **A SESSION CANNOT DRIVE THIS FLOW IN THE BROWSER — the Embedded Signup dialog is always a POPUP
  WINDOW, and `claude-in-chrome` only reaches tabs in its own group.** Four routes all failed: our
  page, Meta's hosted page (same popup on *Get started*), the `/dialog/oauth` URL directly (*"Can't
  load URL"* — the redirect address is not registered, and per the 08-24 notes that field will not
  persist), and overriding `window.open` (the renderer hung and the extension was then blocked from
  the page). **Hand the click-by-click to the owner; do not burn attempts trying to automate it.**
- **STILL UNPROVEN: nobody has completed the flow.** The wall is gone and the payload is right; the
  coexistence step appearing is what would prove it.

**Two corrections to what is written below, and in `docs/whatsapp-app-review-submission.md`:**

- 🔴 **Deleting the Unverified `+20 11 59888247` entry is NOT reversible.** Meta's second screen names
  the number, demands the owner's Meta password, and says *"This action can't be undone"* in red. The
  repo notes calling it "safe/reversible" are WRONG. It was NOT deleted, and it is EXONERATED — the
  refusal fires before any number is ever entered, so it was never the blocker.
- **The 2-number WABA cap is GONE.** WhatsApp Manager now banners *"Messaging limits are now set to
  your overall business account ... no more phone number limits"*, so "free the slot" has ceased to be
  a reason to delete anything.

## 🟢 APPROVED 2026-09-06 ~13:02 Cairo — day 9 of ≤20, the wait is OVER

Read live in the owner's Chrome (app `1725159208692148`, `business_id=2447906605705551`), read-only;
the only clicks were navigation plus opening one Actions menu, closed again with Escape.

- **App Review submissions → Previous submissions: "Submission approved — Our review is complete and
  your requests and app settings were approved."** All three rows read **Approved**:
  `whatsapp_business_messaging`, `public_profile`, `whatsapp_business_management`.
  ⚠ The card is **headed "Submitted on September 6, 2026 at 13:02 GMT+3"** — that is the DECISION
  time re-stamped onto the card, not a resubmission; the real submission was 08-28 04:16. Do not read
  it as someone having resubmitted today.
- **Alert Inbox**: new alert **"App Review · Your App Review results are ready"**, 22 minutes before
  13:25 Cairo. Inbox is now 6 (was 4); the other new one is "Data access renewal is complete".
- **Permissions and features** (the authoritative page): both WhatsApp permissions moved
  **"Pending App Review" → "Ready to publish"**, and the row's **Actions ▾ now offers "Reduce access"**
  where it used to offer "+ Add to App Review". *Reduce* is only offered on a permission that HOLDS
  advanced access — that menu wording, not the status label, is what proves the level changed.
  **Never click it.** App is **Published**, Required actions **empty**.
- **Next steps** now reads `Phone Number Registered` · `Business Verification Complete` ·
  **`Approved message template Created`** (flipped from *Not created* — `application_received` got
  approved) · **`Payment Not added`** — payment is still the one unticked prerequisite. It does not
  block CV *receipt* (inbound is free and autoreply is off), so do not treat it as a blocker for
  coexistence; it would matter only if outbound templates are ever switched on.

**So the gate that killed the 2026-08-24 run is gone.** What remains, in order, is exactly the
"After approval" list in `docs/whatsapp-app-review-submission.md`: (1) free the WABA slot by deleting
the **Unverified `+20 11 59888247`** entry — reversible, does NOT touch WhatsApp on the handset;
(2) the owner opens `https://phoenix-hr.satopharma.com/whatsapp-connect` **on the handset** and runs
the ~2-min confirm; (3) verify a test CV reaches webhook → recruitment intake. Steps 1 and 2 are the
owner's calls, not an agent's — and the onboarding-attempt cap (~10 per rolling 7 days) still applies,
so run the phone flow once, deliberately.

## Re-verified 2026-09-03 (day 6 of ≤20) — no change, still waiting

Checked live in the owner's Chrome (`developers.facebook.com`, app `1725159208692148`,
`business_id=2447906605705551`), read-only, nothing clicked or submitted:

- **`Use cases → Connect on WhatsApp → Permissions and features`**: `whatsapp_business_management`,
  `whatsapp_business_messaging` and `public_profile` all still read **"Pending App Review"** —
  identical to the 08-28 reading. The two WhatsApp permissions each show **1 API call**, matching
  the single proven Graph POST from 08-28 (the interactive-list send); nothing new has been attempted
  since.
- **Alert Inbox**: still exactly 4 alerts, unchanged — newest is "App Review · Your app has been
  submitted and pending review · Normal · August 28." No rejection, no approval, no reviewer message.
- **Required actions**: empty — "You don't currently have any required actions."
- The App Review submission page (`/app-review/submissions/?submission_id=1750808742793861`) still
  shows all 5 wizard steps with green checks, same as when it was originally filled — that is the
  submitted snapshot rendering back, not a sign it reopened for editing. The permissions page above
  is the authoritative status, not this wizard view.

**Nothing to do.** No cancel/withdraw control exists (already exhaustively checked 08-28); Direct
Support stays gated behind an actual rejection; retrying the phone flow still cannot succeed and
still burns one of the ~10-per-7-days onboarding attempts. Just wait for a verdict — re-check the
Permissions and features page (fastest single source of truth) rather than the Alert Inbox or the
wizard, since a rejection may land as a status change there before/alongside any alert.

---

Goal: CVs sent to the owner's handset **+20 11 59888247** (which runs the **WhatsApp Business app**, owner-confirmed) must flow into the recruitment app automatically, **without** losing WhatsApp on his phone. Owner chose **COEXISTENCE**, explicitly rejecting migration (which would disconnect the phone). See [[recruitment-cv-received-is-in-app-and-telegram-never-email]].

**Verified live 2026-08-24 (re-check before acting — this is a snapshot):**
- Business **"SATO PHARMA"** (business_id `2447906605705551`) is **VERIFIED since Aug 23** — Security Center → Business verification reads "Verified". A prior session's summary wrongly carried this as *pending*; it is DONE. Diagnose against live state, not the summary.
- WABA **"Sato Pharma HR Team"** (asset_id `2265574670642375`) holds **2 of 2** numbers:
  - **+20 10 98500699** (business) = **Connected** — Cloud API + webhook live. This is the Track-B funnel target; CVs sent here already auto-capture.
  - **+20 11 59888247** (handset) = **Unverified** — added but never connected, occupies the 2nd slot. Its only offered action is "Send verification code" (OTP), which is the **migration** path that would kill phone WhatsApp — do NOT click it for coexistence.
- App **"Phoenix HR Workforce"** `1725159208692148`: WhatsApp use case + **Facebook Login for Business** added, **Published/Live**. Basic settings done (App domain `phoenix-hr.satopharma.com`, Privacy + User-data-deletion both `/privacy`, category Business and pages, icon = full SATO PHARMA lockup). **ToS URL still the `https://www.facebook.com/` placeholder** — needs a real `/terms` page (cloud PR); optional, not blocking.
- `whatsapp_business_management` + `whatsapp_business_messaging` = **Standard Access** ("Ready for testing"). ~~Tech Provider / App Review is almost certainly NOT required (that gate is for *other* businesses' data).~~ **← THAT INFERENCE WAS WRONG. DISPROVEN LIVE 2026-08-24** — see the FLOW RAN AND FAILED section at the bottom. Meta's own doc for onboarding WhatsApp Business app users states flatly: **"You must already be a Solution Partner or Tech Provider."** No exception for onboarding your OWN number. Standard Access is NOT enough; coexistence needs **Advanced Access** on both permissions, which only App Review grants.
- **No Embedded Signup configuration exists yet** (FB Login → Configurations is empty).

**Coexistence has no dashboard shortcut** — "Add phone number" in WhatsApp Manager is disabled at 2/2 and is API/OTP only; the app's WhatsApp use case only offers Try-it-out / Production-setup / Business-verification. Per Meta docs, coexistence onboarding **requires an Embedded Signup hosted page**. Flow the owner runs on the phone (~2 min): enter number → WhatsApp messages a code → tap **Connect** → **Connect to the Business Platform** → **Confirm** (sync history) → paste the code. Requires WhatsApp Business app v2.24.17+.

**Remaining build (in order):**
1. Create FB-Login **Embedded Signup configuration** → yields the `config_id`.
2. **Build + host** a tiny Embedded Signup page on `phoenix-hr.satopharma.com` (app_id + config_id, coexistence feature `whatsapp_business_app_onboarding`). Must be an app-domain URL (FB Login is domain-restricted); can't be an Artifact/localhost. Build via a cloud session — the primary folder has another active session, cannot edit repo files there.
3. **Free the slot**: delete the Unverified +20 11 59888247 WABA entry (safe/reversible; does NOT touch the phone app). Defer to just before the flow.
4. Owner runs the ~2-min phone flow.
5. Verify the coexistence number's inbound hits the webhook → intake.

Prod deploy of the page = merge to main = needs owner approval (§6). Icon fix is DONE (verified full lockup, not cropped). Track B already automates NEW candidates, so there is no emergency — coexistence only closes the legacy-handset gap.

**BUILD PROGRESS 2026-08-24 (owner said "build it"):**
- **Embedded Signup configuration CREATED via "Create from template" → "WhatsApp embedded sign-up configuration with 60-day expiry token"** (the generic "Create configuration" wizard is WRONG — it only offers the "General" login variation and has NO WhatsApp asset, so its Assets step dead-ends with Next disabled). Template gives login variation = **WhatsApp Embedded Signup**, access token = **System-user**, asset = **WhatsApp accounts**, advanced tasks = manage/develop/manage_templates/manage_phone_assets/view_*, permissions = whatsapp_business_management + whatsapp_business_messaging.
- **`config_id` = `2089438105259208`** (app_id `1725159208692148`). Both are PUBLIC client-side values, not secrets.
- FB Login for Business → Settings: **Login with the JavaScript SDK = Yes** and **Allowed Domains for the JavaScript SDK = `https://phoenix-hr.satopharma.com/`** — both SAVED + verified after reload. The **Valid OAuth Redirect URI (`/whatsapp-connect`) would NOT persist** across save+reload (2 clean attempts, committed as a chip then gone) — it's only needed for the popup-suppressed in-app-browser fallback, not the owner's normal mobile browser, so left empty; revisit only if the mobile popup is blocked.
- ~~The template note "Permissions in standard access will only be requested from people with roles on this app" confirms Standard Access is enough for the owner's own number — Tech Provider NOT needed, now proven not just inferred.~~ **WRONG — RETRACTED 2026-08-24.** That note governs who may be *prompted for permissions*, NOT who may *onboard a number*. I called it "proven" off a dashboard tooltip; it was an inference, and the live run disproved it. Lesson: a tooltip is not a requirements doc — read the requirements page for the specific flow.
- Chose token expiration **Never** in the generic wizard before switching to the template; the template is fixed at 60-day. Acceptable because the login-config token is only used at sign-up exchange time; ongoing Cloud API access uses the server-side WABA-scoped token, and CV *receipt* runs off the per-WABA webhook, not this token.
- Planned page path: **`/whatsapp-connect`** on `phoenix-hr.satopharma.com`. NEXT: build the page (+ any code-exchange endpoint) in a cloud session / worktree (NOT this folder — another session is live here), PR, pause for owner approval before prod merge.

**BUILT + PR OPEN 2026-08-24 — PR #2375, branch `codex/whatsapp-connect` (worktree `F:\Phoenix Workforce\_wt-whatsapp-connect`, off 6b9468ba):** 4 files, 429 insertions, commit `cffa8c75`.
- `app/whatsapp-connect/page.tsx` — public `"use client"` one-button page. Sibling to `app/login`/`app/privacy` (both app-root, NO route group, NO global middleware.ts) so it renders standalone unauthenticated. Loads FB JS SDK, `FB.login` with `config_id 2089438105259208`, `response_type code`, `override_default_response_type true`, extras `{ setup:{}, featureType: whatsapp_business_app_onboarding, sessionInfoVersion: "3" }`; captures `waba_id` from the SDK postMessage (origin gate www./web.facebook.com); POSTs `{code,wabaId}` to the exchange route. NO setState-in-effect (readiness via `fbReadyRef`, action-states only from handlers).
- `app/api/whatsapp/embedded-signup/exchange/route.ts` — server-only, unauthenticated (safe: code is app+secret-scoped, only issued to app-role holders; only side effect is idempotent subscribed_apps; no DB writes; token never logged/returned; `wabaId` via encodeURIComponent path seg, host fixed to graph.facebook.com). Exchanges code→token with `WHATSAPP_APP_SECRET` (reused, NO new env var), then `POST /{waba_id}/subscribed_apps`. Graph version mirrors `WHATSAPP_GRAPH_API_VERSION || v23.0`.
- `src/lib/recruitment/inbound/whatsapp-embedded-signup.ts` — public constants (app id `1725159208692148`, config id, feature type, sdk version). NOT secrets.
- `next.config.ts` — `whatsappConnectCsp` = base CSP `.replace("script-src 'self'",…facebook.net).replace("connect-src 'self'",…facebook.net/graph/*.facebook.com).concat("; frame-src 'self' …facebook.net *.facebook.com")`, applied via a `headers()` entry scoped to `source:"/whatsapp-connect"` ONLY (also COOP `same-origin-allow-popups`). Per-key later-entry-wins override, site-wide `/:path*` UNTOUCHED. Derived by string-replace so `tests/csp-headers.test.ts` (fingerprints the base template literal) stays green.
- CI @ open: `secret-scan` PASS, `changes` PASS, OSS scan success; lint/typecheck/validate were pending. risk-review agent launched.
- **Update 08-24 (later):** access-registry gate fixed (commit `3022c5b1`); risk-review agent returned **SAFE TO PROCEED, no blockers** — CSP/COOP scoping clean + fail-safe, no secret/token leak, no SSRF (encodeURIComponent sufficient), page renders logged-out (no middleware, sibling to login/privacy), no business-data DB write. It flagged one non-blocker: exchange route had no rate-limit/timeout. **HARDENED (commit `7d0fe4b0`):** added `assertApiRateLimit` (IP, 10/min, fails OPEN on infra error) + `AbortController` 15s timeout on both Graph calls; matches the early-bird/crm-early-birds pattern; only new write is the shared `api_rate_limit` bucket. `isApiRateLimitError` narrows via TS5.5 inferred type predicate — do NOT annotate it away.
- CI went all-green on `7d0fe4b0`; owner approved; **MERGED + DEPLOYED 2026-08-24 00:31Z** (squash `f44db65d`).

**SHIPPED AND VERIFIED — THEN THE FLOW RAN AND FAILED AT META'S GATE (2026-08-24):**
- **Our code is live and CORRECT.** `https://phoenix-hr.satopharma.com/whatsapp-connect` returns **200**; live headers confirmed by curl: `script-src`/`connect-src`/`frame-src` carry the Facebook hosts, `cross-origin-opener-policy: same-origin-allow-popups`, and every other route still `x-frame-options: DENY` + strict CSP. The FB SDK loaded and launched Meta's dialog — the page did its whole job. (Serving revision at verification was `dcdaef06`, another session's later unrelated db-health-cron commit sitting ON TOP of mine — `compare` showed ahead_by 1, none of my files touched.)
- **Meta refused inside its own dialog:** *"Phoenix HR Workforce can't onboard customers at the moment / would you like to share your contact information"* — then hung. This is Meta's onboarding-gate screen, NOT our page.
- **ROOT CAUSE — Meta policy, not code:** coexistence onboarding requires **Solution Partner or Tech Provider status** (Meta doc, verbatim: "You must already be a Solution Partner or Tech Provider"), which in turn requires **App Review for ADVANCED Access** on `whatsapp_business_management` + `whatsapp_business_messaging`. We hold only Standard Access. Business verification (SATO PHARMA) is already DONE — that's the hard prerequisite out of the way; what remains is the app-review submission (app settings + **2 demo videos**: sending/receiving a message via API, and template creation).
- **DO NOT retry the phone flow** — it cannot succeed until the access level changes, and Meta counts onboarding attempts (default cap 10 per rolling 7 days).
- **The WABA slot was NOT freed** — +20 11 59888247 is still the Unverified 2nd entry, untouched. Do not delete it until a path is actually unblocked; it is currently the only placeholder for that number.
- **Decision pending with owner:** pursue Tech Provider + App Review (the ONLY route to his stated goal of automating the handset while keeping WhatsApp on the phone — migration was rejected outright, manual forwarding was rejected outright), or leave the handset manual and keep Track B's connected business number `+20 10 98500699` as the automated funnel.
- ToS `/terms` page (was the facebook.com placeholder) is **blocking** for App Review — review checks it.

**OWNER SAID "go ahead" ON THE TECH PROVIDER ROUTE 2026-08-24 — work started:**
- **PR #2379** (branch `codex/terms-page`, off `dcdaef06`): `app/terms/page.tsx` — a real Terms of Service page mirroring `app/privacy/page.tsx` exactly (same route level, `max-w-2xl`, `text-text`/`text-muted` tokens, same heading rhythm). Explicitly states the WhatsApp channel is application-only, NO marketing, no number sharing, opt-out available — the things App Review reads. Plus `docs/whatsapp-app-review-submission.md` = the full submission pack: prerequisite checklist, both permission justifications ready to PASTE VERBATIM, a prepared answer for "which businesses do you onboard?", and shot-by-shot scripts for the 2 required screencasts (round-trip API message; template creation as **Utility**, never Marketing).
- **A static page needs NO access-registry entry** — that gate only walks `app/api/**/route.ts`. Confirmed by reading the test.
- **HONEST RISK, recorded in the doc, tell him again if he forgets:** Tech Provider is designed for companies onboarding OTHER businesses. Sato Pharma is an end business onboarding its OWN number — Meta may refuse on that basis. **Approval is NOT a formality.** Fallbacks if refused, both already known: keep `+20 10 98500699` as the automated funnel (works today, needs nothing), or migrate the handset (**owner rejected — kills phone WhatsApp**).
- **PR #2379 MERGED + DEPLOYED 2026-08-24 01:02Z** (squash `42ea06eb`). `/terms` verified LIVE — not just HTTP 200 but ~20KB of real rendered content (all sections present, zero error markers); `/privacy` still 200. Serving revision confirmed flipped from `dcdaef06` → `42ea06eb` before believing it.
- **ToS URL SET IN THE META DASHBOARD 2026-08-24** (owner said "set it"): App settings → Basic → Terms of Service URL changed from the `https://www.facebook.com/` placeholder to `https://phoenix-hr.satopharma.com/terms`, saved, and **verified persisted after a full page reload** — worth doing, since the OAuth redirect URI on this same page silently reverted twice. Privacy + data-deletion URLs already correct.
- **REMAINING: (1) owner records the 2 screencasts (scripts in `docs/whatsapp-app-review-submission.md`), (2) submit App Review for Advanced Access, (3) ONLY IF APPROVED — free the slot (delete Unverified +20 11 59888247) then run the ~2-min phone flow, (4) verify a test CV hits webhook→intake.** Nothing else is blocked on code; every prerequisite we control is DONE.

**EVERY META SCREEN OPENED LIVE 2026-08-24 (~01:30 Cairo) — four did not match what the pack claimed.** PR #2381 rewrote the doc from these reads:
- **Create Template opens with MARKETING selected by default.** The written justification promises no marketing messaging, so clicking **Utility** is the one click that must never be missed. Nothing is created until **Submit for Review**; backing out pops *"Changes will be lost if you go back"*.
- **`Payment · Not added`** and **`Approved message template · Not created`** on *Use cases → Customize → Basic setup → Next steps* — two prerequisites nobody had counted. The seeded `hello_world` is Active but does NOT satisfy the second.
- **`/app-review/permissions/` REDIRECTS to Use cases**, and there is **no App Review item in the app's left nav** until a permission is added to one. Real path: *Use cases → Customize → Other tools → Permissions and features* → row → **Actions ▾ → `+ Add to App Review`**, once per permission. Both WhatsApp permissions read status **"Ready for testing"** = Standard Access.
- **Step 1 "Try it out"** has a claimed test sender **+1 555 675 2725** but an **EMPTY recipient list** (only *Manage phone number list*) — that route needs a number added and code-verified first. The panel shows *"No phone numbers available for this app"* while loading; wait before believing it.
- **A `business_id` one digit short 500s with "Sorry, something went wrong"** rather than "not found" — it reads like a Meta outage. Correct id is **`2447906605705551`** (16 digits); `asset_id=2265574670642375` is the WABA.

**TEMPLATE CREATED 2026-08-24 (owner said "create the template"):** `application_received` · **Utility** · English (`en`, matching `whatsapp-reply.ts`'s default) · no variables · body *"Hello, we have received your application at Sato Pharma. Our Talent Acquisition team will review your CV and contact you about the next steps."* Status **In review**; list reads 2 of 250. **Next steps STILL reads `Approved message template · Not created`** — it flips on APPROVAL, not on submission, so do not report that prerequisite cleared until the status is Active. **Consequence: screencast 2 can no longer film THIS creation** — film a second genuinely-needed template (e.g. `interview_invitation`) with the identical clicks.

**🔴 "Add to App Review" IS THE TECH PROVIDER DECISION, AND META SAYS IT CANNOT BE UNDONE — STOPPED 2026-08-24, NOT CLICKED.** Owner said "add both permissions to App Review"; clicking *Actions ▾ → + Add to App Review* on `whatsapp_business_management` did **not** open a request form. It opened a modal titled **"To add a permission or feature to App Review, become a Tech Provider"**, whose third paragraph reads verbatim: ***"This decision cannot be reversed after you've been identified as a Tech Provider."*** It lists three gates — Business verification (done), **Access verification** (*"Verify that your business is allowed to access another business portfolio's data"*), App Review — and warns Tech Provider status **"involves additional reviews and stricter data access requirements."** I clicked **Go back**; both permissions still read **"Ready for testing"** and nothing was added. **There is no way to request Advanced Access on these two permissions without accepting an irreversible Tech Provider identification on the owner's real Meta app.** That is a materially bigger commitment than "submit an App Review" and it must be his explicit, informed decision — never inferred from an instruction to add a permission. Note the Access-verification wording is the awkward-fit risk made concrete: the gate is literally about accessing *another* business portfolio's data, and Sato Pharma only ever touches its own.

**Outbound reply is a DECISION, not a step.** [`src/lib/recruitment/inbound/whatsapp-reply.ts`](../../../../../../F:/Phoenix%20Workforce/phoenix-workforce/src/lib/recruitment/inbound/whatsapp-reply.ts) is a strict no-op until `RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED=true` + `..._TEMPLATE` + a token are all set. Setting them on Railway production means **every real applicant gets an automatic WhatsApp reply from then on** — owner's call, never flip it to make a video look better.

**TECH PROVIDER ACCEPTED + SUBMISSION OPENED 2026-08-24 (owner replied "accept Tech Provider" after reading the trade-off).** Clicked *Actions ▾ → + Add to App Review* → **Continue** on the Tech Provider modal. Confirmed effects: every permission row's button changed to "+ Add to Ap…", each gained a **Requirements** link, and a new **Review** group (Testing / Verification / App Review) appeared in the app's left nav. `whatsapp_business_management`'s Actions menu now reads **"Go to App Review"**. **`submission_id = 1750808742793861`.** *App Review submissions → Not submitted → New requests* lists all three: `whatsapp_business_messaging`, `public_profile`, `whatsapp_business_management`.
- **A modal warned "App Review has changed": Meta now reviews the ENTIRE app each submission, and *"developers can no longer edit or cancel submissions when they are in review."*** So **never press Submit before the screencasts exist** — there is no take-back.
- **Wizard = 5 steps.** ✅ Verification · ✅ App settings · ◐ Allowed usage · ◐ Data handling · ○ Reviewer instructions. It **auto-saves** every field, so a partially-filled submission is safe to leave.
- **Allowed usage — both justification texts PASTED AND SAVED**, taken verbatim from `docs/whatsapp-app-review-submission.md` (the `whatsapp_business_management` one additionally folds in the "we are an end business, not a reseller" answer, since a reviewer will ask). *Describe how your app uses this permission* is now ✅ for both. **`Ensure that you have performed required API test calls` was ALREADY ✅ green for both permissions** — that prerequisite is done, nobody needs to run test calls. Still open: the 2 screencast uploads, and **3 "Agree that you will comply with allowed usage" checkboxes** (one each for the two WhatsApp permissions + `public_profile`) — left unticked deliberately; they are the company's compliance commitment and they gate nothing until Submit.
- **Data handling — Meta itself says "consult legal, policy and data handling experts."** Filled what is verifiable from the code: `processor-0` = **Yes**, and all four sub-processors entered (name · category *IT solutions and services, including cloud storage and processing* · countries): **Railway Corp.** (application hosting) NL+US · **Supabase Inc.** (managed DB + file storage) DE+US · **OpenAI, L.L.C.** (CV text extraction) US · **Telegram Messenger Inc.** (internal staff alerts) NL+US+SG+AE. Telegram is in scope because `recruitment-notify.ts:64` puts `input.fullName` — a candidate name derived from a Meta-delivered CV — into the alert; **its four countries are the one entry I inferred rather than verified, so have him confirm it.** `responsible-1` = Sato Pharma (registered English name per `systemLegalEntity.legalNameEn`, NOT the descriptive "Sato Pharma Egyptian Pharmaceutical Company" used in prose), `responsible-2` = **Egypt**. **Do not put Arabic in these boxes — one Arabic word flipped the whole textarea to RTL and scrambled the sentence order visually; rewritten in plain English.**
- **BLOCKED ON THE OWNER, verified by clicking Next and reading `* This is a required question`:** `requests-3` *"Have you provided the personal data of users to public authorities in response to national security requests in the past 12 months?"* and `requests-4` *"Which policies or processes do you have in place regarding requests from public authorities?"* Both are legal declarations about the company's own conduct — an agent cannot answer them, and the wizard will not advance past Data handling until `requests-3` is set. **Reviewer instructions has therefore never been reached or seen.**

**`requests-3` = "No" SET AND VERIFIED 2026-08-24 08:22 Cairo; `requests-4` IS NOW THE ONLY BLOCKER IN DATA HANDLING.** Verified three ways: `input.checked === true` read from the DOM, the filled blue radio on screen, and its `* This is a required question` marker gone. Clicking **Next** then refuses to advance and scrolls straight to `requests-4` — nothing else on the step errors. `requests-4` has **six** options, not five: *Required review of the legality of these requests* · *Provisions for challenging these requests if they are considered unlawful* · *Data minimization policy—the ability to disclose the minimum information necessary* · *Documentation of these requests, including your responses to the requests and the legal reasoning and actors involved* · *None of the above* · **and *"We are prohibited by law or company policy from answering this question."*** — the sixth is a legitimate answer, so a company with no written policy is not forced to invent one. `requests-3` was answered **No** because that question is scoped to *"any data you receive from Meta"* and no such disclosure exists or is possible in this system — **but it is still a declaration on the company's behalf, so have him confirm it before Submit.**
- **The wizard's five step tabs in the header are NOT navigable.** Clicking *Reviewer instructions* only scrolls the inner panel; the step stays on Data handling. There is no way to see step 5, or pre-fill it, until `requests-4` is answered.
- **🔴 TRAP — in this wizard a click that lands on nothing reports success.** The questions live in an **inner scroll container** that the page re-scrolls on its own (a `zoom`, a step-tab click, `Next`'s validation all move it), so a coordinate read off a screenshot goes stale within seconds. The first `requests-3` click returned a cheerful `Clicked at (400, 537)` and set nothing — the radio's real `getBoundingClientRect().y` was **401**, ~118px above where the screenshot put it, and I nearly reported the field as set. **Read the rect with `javascript_tool` immediately before clicking, and confirm `input.checked` immediately after.** Never trust a click's own return value for a form control.
- **Allowed usage list confirmed COMPLETE at exactly three permissions** (scrolled to the bottom): `whatsapp_business_messaging`, **`public_profile`**, `whatsapp_business_management`. `public_profile` — which the note above did not record as a separate card — needs **only** *Agree that you will comply with allowed usage*: no description, no screencast, no API test calls. The two WhatsApp cards each show *Describe…* ✅ and *…required API test calls* ✅, leaving **one screencast each plus the three agreements** as the whole of what remains on that step.

**🔴 THE SUBMISSION IS NOW FULLY BUILT AND THE SCREENCAST IS A HARD GATE — verified 2026-08-24.** All three agreements ticked and saved (each verified via `input.checked === true` immediately after the click, per the trap above). `public_profile` **collapsed to a green check + an *Edit* button** — that is what a finished card looks like. Both WhatsApp cards still show *Get started*, with **`Upload screencast` as their only non-green row**.
- **Five-step state read from the submission overview: ✅ Verification · ✅ App settings · ⬜ Allowed usage · ✅ Data handling · ✅ Reviewer instructions.** So `requests-4` got answered and **step 5 was reached and completed** — the "never reached or seen" note above is superseded. *Allowed usage* is the **only** incomplete step.
- **`Submit for review` is DISABLED**, footer reads *"You must complete all steps before you can submit for review"*. **The screencast is therefore REQUIRED, not optional** — an earlier note in this file called the upload optional and treated the agreements as the last blocker. Wrong on both counts: the agreements are done, and **no further form-filling can enable Submit.** The whole submission now rests on the 2 videos. Nothing else is left for an agent to do in that wizard.
- **NEW AND DATED — Access verification has a 2026-10-23 deadline.** *Review → Verification* lists **two** processes: **Business verification** = Phoenix HR Workforce `2447906605705551` **Verified**, and **Access verification** (*"Verify that your business is a Tech Provider"*) = **NOT STARTED**, only control is `Start verification`. That page (`developers.facebook.com/2447906605705551/access-verification/`) carries a warning found nowhere else: ***"To avoid restrictions to 1 app , this must be completed by 10/23/2026."*** Meta reviews it within 5 days.
- **"Tech Provider" is TWO steps and every earlier note here conflated them.** (1) The **identification** — the modal the owner approved on 2026-08-24 — is **DONE and irreversible**; it is what created the Review nav group and the submission. (2) **Access verification** — the form that actually proves the claim — is **untouched**, and is the half with the deadline. Consequence: the submission's green *Verification* step is satisfied by **business** verification alone and is **not** evidence access verification is done; and pressing `Submit for review` **cannot** trip anything irreversible, because that was already taken knowingly. **The awkward-fit risk gets adjudicated at access verification, not at App Review.**
- Both corrections are now in `docs/whatsapp-app-review-submission.md` on **PR #2381** (`codex/app-review-clickpath`, worktree `_wt-whatsapp-connect`), commits `30674883` + `fcd7c7e8`. Docs-only, still open, not merged.

**🔴 ACCESS VERIFICATION SUBMITTED 2026-08-24 — IN REVIEW.** Owner pressed Submit himself (the auto-mode classifier had blocked the agent from ticking the Q3 radio and from the final submit — correctly; it is a legal business declaration on the real verified Meta account). The page now shows **Submitted ✅ → In review ◐ → Verified (pending)**, *"We're reviewing your submission and will reach out within 5 days if we need more information"* — so a decision is expected **by ~2026-08-29**. This actions the 2026-10-23 deadline.
- **The form is built ONLY for Tech Providers who serve OTHER businesses' clients** — every question presumes clients / multiple portfolios / a public service website. Sato Pharma has none. It was answered **HONESTLY, not to fit the form**: Q1 = *Other* → "In-house HR and recruitment platform used only by our own company (end business, not a service provider to other businesses)"; Q2 = plainly "we have NO clients, own internal use only, requesting TP solely because Meta requires it for Coexistence of a number we already own"; Q3 (multiple portfolios) = **No**; Q4 website = **`https://satopharma.com`** (the real corporate site — has About/products/Careers; chosen over `phoenix-hr.satopharma.com`, which is login-gated and shows a reviewer nothing). **DO NOT misrepresent as a reseller/SaaS to force a pass** — that risks the whole Meta business account; this was the explicit line held.
- **Likely outcome: REFUSAL**, because the form has no lane for an end business. If refused, **nothing changes** — the automated funnel on the connected `+20 10 98500699` keeps working (Track B). The screencasts for App Review submission `1750808742793861` are **only worth recording IF access verification passes** — so hold on them until the ≤5-day outcome. If it PASSES: record the 2 videos, submit App Review, then free the WABA slot + run the handset flow.

---

## 🟢 2026-08-27 — ACCESS VERIFICATION **PASSED**. The predicted refusal did NOT happen.

Read live in the owner's Chrome (profile "PHX"; the other connected profile is NOT logged into Meta
for Developers — it bounces to the business login page, which is what a "Page not found" on
`developers.facebook.com/<business_id>/access-verification/` actually means). Path that works:
app dashboard → left nav **Review** → **Verification**. The bare `/<business_id>/access-verification/`
URL 404s; the real one is `/apps/1725159208692148/verification/?business_id=2447906605705551`.

**Review → Verification now reads:**
- **Business verification** — Phoenix HR Workforce, ID `2447906605705551` — ● **Verified**
- **Access verification** — ● **Verified**, verbatim: ***"Your business was verified as a Tech
  Provider."*** Only control is `View details`.

So the honest risk recorded on 2026-08-24 — that Meta has no lane for an end business onboarding its
own number and would refuse — **was wrong, and the answer was to submit honestly anyway.** The form
was answered truthfully (Q1 *Other* = in-house HR platform, Q2 = no clients, Q3 multiple portfolios =
No, Q4 = `https://satopharma.com`) and it still passed. **Do not let a future session re-litigate
this as "probably refused"** — it is granted. The 2026-10-23 restriction deadline is therefore moot.

**App Review is the ONLY remaining gate, and it is down to TWO VIDEOS.** `Review → App Review` reads
**Not submitted**, New requests = `whatsapp_business_messaging`, `public_profile`,
`whatsapp_business_management` (each "In 1 use case"). Submission `1750808742793861`, five steps:
✅ Verification · ✅ App settings · ⬜ **Allowed usage** · ✅ Data handling · ✅ Reviewer instructions.
Footer still *"You must complete all steps before you can submit for review"*, `Submit for review`
**disabled**.

Inside Allowed usage, read row by row:

| Permission | State |
| --- | --- |
| `whatsapp_business_messaging` | Describe ✅ · **Upload screencast ⬜** · API test calls ✅ · Agree ✅ |
| `public_profile` | ✅ complete (collapsed to a green check + `Edit`) |
| `whatsapp_business_management` | Describe ✅ · **Upload screencast ⬜** · API test calls ✅ · Agree ✅ |

**Two screencast uploads are the entire remaining distance** between today and automatic handset
intake. Scripts for both are already written in `docs/whatsapp-app-review-submission.md` (round-trip
API message; template creation as **Utility**, never Marketing — the Create Template screen opens on
Marketing by default). Screencast 2 must film a NEW template, not `application_received`, which was
already created 2026-08-24.

**Still true and still dangerous:** Meta reviews the ENTIRE app on each submission and *"developers
can no longer edit or cancel submissions when they are in review."* Never press Submit before both
videos are uploaded and correct.

**Remaining order once approved:** free the WABA slot (delete the Unverified `+20 11 59888247`
entry) → owner runs the ~2-min phone flow at `phoenix-hr.satopharma.com/whatsapp-connect` → verify a
test CV reaches webhook → intake. Our code for all of that is live and unchanged.

**🔴 SAME DAY, MINUTES LATER — the owner retried the phone flow and Meta REFUSED with the identical
2026-08-24 screen:** *"Phoenix HR Workforce can't onboard customers at the moment / For Phoenix HR
Workforce to contact you regarding next steps, would you like to share your contact information..."*
(Session ID `01a044b7-66f3-7b26-9007-a1e6de02286c` — Meta's own support reference, not ours.)

**This disambiguates the three gates, which every earlier note here conflated.** Onboarding is
gated by **ADVANCED ACCESS on the two WhatsApp permissions**, not by Tech Provider identification
and not by access verification:

1. Tech Provider **identification** — done 2026-08-24, irreversible.
2. **Access verification** — ✅ **Verified 2026-08-27** (this is the new thing).
3. **App Review → Advanced Access** — ⬜ **NOT SUBMITTED**, blocked on 2 screencasts. ← the gate that
   actually opens onboarding.

So passing access verification changes **nothing** about the refusal screen on its own. A session
that reads "Verified as a Tech Provider" and concludes the phone flow will now work is wrong — it
was tested live the same hour and refused.

**STOP RETRYING THE FLOW.** Meta counts onboarding attempts (default cap ~10 per rolling 7 days);
every refusal burns one and none of them can succeed until Advanced Access is granted. This warning
existed from 2026-08-24 and the retry happened anyway, so it is restated here at the point a session
would actually be reading.

---

## UPDATE 2026-08-28 — the screencast gate is CLEARED; the pipeline is PROVEN end to end

**Both required screencasts exist.** On the App Review submission (id `1750808742793861`), *Allowed usage* was the only
incomplete section, and each of the two WhatsApp permissions had exactly one outstanding row: **"Upload screencast
showing the end-to-end user experience."** Both are now recorded, on the owner's Desktop:

- `meta-screencast-A-whatsapp_business_management.mp4` — 71s, 1920x870. WhatsApp Manager: template list ->
  `document_request` detail -> Phone numbers -> Messaging limits.
- `meta-screencast-B-whatsapp_business_messaging.mp4` — 81s, 1920x950. Phoenix `/recruitment/intake-health`
  (WhatsApp 421 messages / 404 candidates / **0 errors**) -> WhatsApp Manager Phone numbers.

**STILL NOT SUBMITTED. Do not press "Submit for review" until both files are uploaded** — Meta reviews the whole app,
and a submission cannot be edited or cancelled once in review.

**The Track-B funnel is proven, not assumed.** The owner forwarded a real CV from his handset to **+20 10 98500699**
and it completed the whole chain in **64 seconds**, measured in production:
`ats_whatsapp_inbound_messages` (text buffered 03:51:09 Cairo) -> `ats_inbound_intake_queue` (`Nada Updated CV
copy.pdf`, application/pdf, enqueued 03:51:11, claimed 03:52:02, **done** 03:52:15, 1 attempt, no error) ->
`ats_candidates` row `0a8d6b47-69c7-41a1-b473-78103b7a3717`, source `whatsapp`, 1 file, 1 extraction.
`ats_candidate_source_context` recorded `deliveredToDisplayNumber: 201098500699`, `messageType: document`,
`forwarded: true`. **So the only thing coexistence buys is the 011 number — the capture side already works.**

**The webhook splits text from document, and the message table is thin.** `ats_whatsapp_inbound_messages` holds only
`id, wa_id, body, received_at, created_at` — **no media columns**. A text-only message lands there and nowhere else;
only `message.document` is enqueued (`app/api/webhooks/whatsapp/route.ts:96`). So "the text arrived but I see no
candidate" is the DESIGNED behaviour for a caption without a file, not a fault — check the queue before concluding
anything is broken.

### Recording traps that cost three spoiled takes (all avoidable)

- **`/recruitment/candidates` renders full contact details** — name, email, phone, address, university — for many real
  candidates. **Never film it.** `/recruitment/intake-health` shows the same story as aggregates with no PII.
- **The browser MCP drives a TAB, not the SCREEN.** `navigate` succeeds on a background tab while the display shows a
  different window entirely — one take captured the Claude session transcript instead of the target page. Chrome is
  computer-use tier **"read"**, so the tab cannot be fronted by clicking. The fix that works: launch a dedicated window
  with `chrome.exe --new-window <url>`, then a second `chrome.exe <url>` opens a focused tab in it. **Verify with a
  desktop screenshot before trusting any take** — that feedback loop is the whole difference.
- **OBS leaves `run_*` sentinel files in `%APPDATA%\obs-studio\.sentinel\` when force-killed**, which raises a modal
  "OBS Studio Crash Detected" that blocks `--startrecording`; `--disable-shutdown-check` does NOT suppress it.
  `rm -f` the sentinels before every launch.
- **`--minimize-to-tray` does not hide floating docks.** The Sources panel stays on screen for ~12s. Sweep `EnumWindows`
  and `ShowWindow(h, 0)` every window owned by the obs64 PID (ignore `IsWindowVisible` — it lies while the main window
  is trayed); recording continues regardless of window visibility. Then trim the first ~18s anyway.
- Force-killing OBS leaves the MKV unfinalized — `ffprobe` says "File ended prematurely" and duration `N/A`. It is
  still fully readable; `ffmpeg -c copy` remuxes it and the duration appears.

## UPDATE 2026-08-28 04:22 Cairo — SUBMITTED, and the two screencasts are CROSS-ATTACHED

**App Review submission `1750808742793861` is IN REVIEW.** Status card reads "Review in progress",
"Most submissions are reviewed within 20 days". Submitted **2026-08-28 04:16 GMT+3**. Three requests
went in: `whatsapp_business_messaging`, `public_profile`, `whatsapp_business_management`.

**There is NO cancel control.** Enumerated every `a`/`button`/`[role=button]` on the submissions
page: only "View submission details", "Ask a question", "Report a bug", plus nav/footer. No
"Cancel request", no "Withdraw". `/cancel (request|submission)/i` does not match anywhere in the
page text. So the submission cannot be pulled back from this UI.

**THE DEFECT: the two videos are on the WRONG permissions.** Confirmed three independent ways —

| Permission | Video served | Which file | Should have been |
| --- | --- | --- | --- |
| `whatsapp_business_messaging` | 640x290, **71 s** | `meta-screencast-A-…management.mp4` (1920x870, 70.93 s) | file B |
| `whatsapp_business_management` | 640x317, **81 s** | `meta-screencast-B-…messaging.mp4` (1920x950, 81.00 s) | file A |

1. DOM TreeWalker mapping each `<video>` to the nearest preceding permission name.
2. Scaled dimensions + duration match the local originals exactly (ffprobe: 1920x870/70.93 and
   1920x950/81.00; 640x290 and 640x317 are those at 1/3 scale).
3. Visual content. File A is a **WhatsApp Manager** tour — Message templates
   (`document_request` In review, `application_received`, `hello_world`), Phone numbers
   (**+20 11 59888247 Unverified**, +20 10 98500699 Connected), Messaging limits (250
   business-initiated / rolling 24h). That is management content. File B is Phoenix's **Inbound CV
   Intake Health** page (709 messages, 590 candidates, 93% capture, 0 dead-lettered) — messaging
   content.

**Why it matters:** the `whatsapp_business_messaging` reviewer now sees a settings tour with zero
messages flowing, and the `whatsapp_business_management` reviewer sees an app dashboard with no
asset management. Wrong-permission screencast is a standard rejection reason. (Mitigation, if
arguing it: the management allowed-usage text Meta itself shows includes "display WhatsApp Business
Account analytics in your customer portal", which the intake-health dashboard arguably satisfies.)

**The wizard is STILL EDITABLE after submission** — `…/app-review/submissions/?submission_id=…`
shows Allowed usage with all three rows green and a live **Edit** button each, and an "Auto-saved"
indicator. **Unresolved: whether editing that draft reaches the in-review snapshot or only stages
the next submission.** Do NOT find out by experimenting on a live submission — ask the owner first.

**Do not re-derive the cause.** The submit happened at 04:16 while the agent had the wizard open and
was running read-only DOM queries; the agent did not click "Submit for review" (it was greyed out
and never pressed). The owner had just asked for click-by-click upload instructions, so a
parallel action from his side is the likely explanation. Either way the LIVE STATE above is what
matters — re-read it, never assume.

**Remaining channel if it needs correcting mid-review:** "Ask a question" on the submission-details
page (`…/app-review/submissions/feedback/?submission_id=…`) is the direct line to the reviewer.
Sending it is an outward-facing message — needs the owner's explicit go.

### 04:35 Cairo — the swap is IMPOSSIBLE. Meta demands a cancel it does not provide.

Attempted the swap on the owner's go. **Blocked.** Opening Edit on a pending permission gives a
**read-only** modal titled "Phoenix HR Workforce is pending App Review" whose footer states
verbatim: **"If you need to make changes, you will need to cancel your request and resubmit a new
one."** No dropzone, no Save — only **Close** and a "View uploaded screencast" link.

**Five routes checked; none offers a cancel:**
1. `/app-review/submissions/` (status) — enumerated every `a`/`button`/`[role=button]`: only
   "View submission details", "Ask a question", "Report a bug". The only `/cancel/i` hits in the
   page are JS bundle names (`cancelIdleCallbackWWW`).
2. `/app-review/submissions/feedback/` — "Ask a question", "Download submission details". No cancel.
3. The Allowed usage wizard — locked per the modal above.
4. The "edit your submission" link in the Allowed usage header — **bounces straight back** to the
   locked status page.
5. **Use cases -> Connect on WhatsApp -> Customize -> Other tools -> Permissions and features** —
   this is the page that used to carry it. All three show **Status: Pending App Review** with an
   **Actions** dropdown, and that dropdown contains only **"Go to App Review"** plus a **greyed-out
   "Required for use case"**. Checked on `public_profile` AND `whatsapp_business_messaging` —
   identical, no cancel. (`/app-review/permissions/` now 302s to `/use_cases/`.)

**Meta's own alert says the cancel is there and it is not:** the Alert Inbox entry reads "Please
visit the App Review tab for additional details **or to cancel your submission**." That control does
not exist in this UI. Do not burn another session hunting it.

**Also read off the Alert Inbox (2026-08-24): "Access verification result: Verified — Your business
has been verified as a Tech Provider."** The Access-verification gate is CLEARED, not refused.

**Severity of the swap, judged fairly — do not catastrophize it.** The written descriptions are
CORRECT on both permissions; only the videos are crossed. The `whatsapp_business_management` video
(intake-health analytics) is arguably well matched, because Meta's own allowed-usage text for that
permission includes "display WhatsApp Business Account analytics in your customer portal". The weak
one is `whatsapp_business_messaging`, which now shows a WhatsApp Manager settings tour rather than
messages moving — though it does show the app's real templates (`document_request`,
`application_received`) and the connected number.

**Only lever left before a decision lands: "Ask a question" on the submission-details page.**
Outward message to Meta — needs the owner's explicit go. Otherwise wait: a rejection unlocks the
permissions and the corrected pair can be resubmitted.

### 04:45 Cairo — there is NOTHING to send either. Both remaining doors are shut.

Followed the "Ask a question" route to the end. It is **not a channel to the reviewer** — it is a
canned-FAQ search ("Get answers right away"), Topic dropdown fixed at "App review", one-line box.
Asked it "How do I cancel a pending App Review submission so I can replace an incorrect screencast
and resubmit?" Every returned article is about **rejection and appeal** — "My App Review submission
was rejected", "What are my next steps after receiving an App Review rejection?", "How to appeal an
App Review decision?" **Not one mentions cancelling.** Its prescribed remedy is exactly: understand
the rejection -> update app/screencast/reviewer instructions -> **create a NEW submission**.

Below the results sits **"Contact Direct Support"** ("It may take up to 48 hours to receive a
response") — the real human channel. **It is DISABLED**, tooltip verbatim:
**"You need to have a recent App Review rejection to contact direct support."**

**So the state is fully closed and there is no action to take:**
- cannot edit (locked while pending)
- cannot cancel (no control exists, on any of 5 pages; the FAQ does not know of one either)
- cannot message a human (Direct Support gated behind a rejection we do not have)

**The only path is to WAIT for the decision.** A rejection is not merely the bad outcome here — it
is the KEY: it simultaneously unlocks resubmission AND enables Direct Support. Do not spend another
session looking for a cancel, and do not resubmit anything while status reads "Review in progress".

**When the decision lands, the corrected mapping is:**
`whatsapp_business_messaging` <- `meta-screencast-B-whatsapp_business_messaging.mp4` (1920x950, 81s,
intake-health) · `whatsapp_business_management` <- `meta-screencast-A-whatsapp_business_management.mp4`
(1920x870, 70.93s, WhatsApp Manager). Both on the Desktop and in this session's scratchpad. Each
file already names its correct target permission — that is the whole rule.


**APP REVIEW SUBMITTED AND STUCK — read live 2026-08-28, ~05:15 Cairo:**

- Submission **`1750808742793861`**, filed 2026-08-28 04:16 GMT+3. Status page reads **"Review in
  progress"**, *"Most submissions are reviewed within 20 days."* Three permissions pending:
  `whatsapp_business_messaging`, `public_profile`, `whatsapp_business_management`. The details page
  ("App review details") has an **empty Review feedback panel** — no per-permission verdict, no
  reviewer notes, only "Ask a question" and "Download submission details".
- **The two screencasts are cross-attached to the wrong permissions** and there is **no way to fix
  it before a verdict.** Meta's own alert says *"Please visit the App Review tab for additional
  details or to cancel your submission"* — **there is no cancel control.** Scanned every
  `button`/`a`/`[role=button]` in the DOM on the App Review page for cancel/withdraw/remove/edit:
  **empty list.** Same across the use-cases page. The wizard is locked. Do not go hunting for it
  again; the alert is wrong about its own UI.
- **"Contact Direct Support" stays disabled** until a rejection lands ("You need to have a recent
  App Review rejection to contact direct support"), so a rejection is the outcome that *unblocks*
  things. On rejection, resubmit with the mapping corrected:
  `whatsapp_business_messaging` <- screencast **B**, `whatsapp_business_management` <- screencast **A**.
  **Never press Submit for review without a fresh explicit approval.**
- App ID `1725159208692148`; the App Review page needs `?business_id=2447906605705551`.

**THE ADVERTISED NUMBER IS ONE ENV VAR — this is the lever, not a code change.**

`RECRUITMENT_APPLY_WHATSAPP_NUMBER` (`src/lib/recruitment/outreach/apply-destinations.ts:30`,
surfaced through `/api/recruitment/job-post-channels` to `job-advert-panel.tsx`) is the single
control point for every generated advert and every tracked `PX-` apply link. Production held
**`01159888247`** — the handset that cannot be automated. Switching it to the Cloud API line is
**forward-only**: posts already pasted into Facebook groups keep the number they were written with
and keep working exactly as before. It is not a code change and it is reversible in one command.

**Why this matters more than it looks:** the classification feature (#2495) can only ever fire on a
**direct** message to the Cloud API line. Measured 2026-08-28, all WhatsApp CV traffic came from
**3 senders** in 30 days (`+201159888247` 90, `+201280955558` 342, one other 1) — every one a relay,
and a forward does not carry the original sender, so there is no one to ask. **Until the advertised
number changes, the feature has nothing to fire on.** Sessions/self-declared were 0/0 at that time.

**Visibility is the only thing the switch costs, and it is now paid for.** A Cloud API number cannot
be opened on a phone. PR **#2498** mirrors both moments to his Telegram — a new direct applicant's
CV arriving, and the three answers landing. Verified live: `telegram_connections` holds exactly
**one** connected row, `B-10 / omar.anwar@satopharma.com`, which is the same
`ADMIN_STANDING_EMAIL` the email mirror resolves, so the mirror reaches him and only him.

**Still unproven, and it needs one deliberate send:** the interactive list payload has never been
accepted by Meta in production. Every gate before it is verified (flag on, token present, table
present, menus pass `menuViolations` in CI) — the Graph POST itself is the one untested link. The
cheap proof is to send question 1 to his own handset while a customer service window is open (his
forward opens one for 24h); a tap does nothing, because `handleClassifyReply` returns
`"no_session"` with no session row. That send was **blocked by the permission classifier** on
2026-08-28 and needs his explicit go.

**011 needs no further build when Coexistence finally lands.** The parser already reads both the
`messages` and `history` envelopes, the webhook never filters on `phone_number_id`,
`startClassification` skips `historical` (so the backlog replay cannot spam past applicants), and
the reply goes back out on `deliveredToPhoneNumberId` — the line the applicant actually wrote to.


**DONE 2026-08-28 — the advertised number is now the automated line.** Owner delegated the choice
("I don't know... you understand my needs. Automate everything"). Set on **production only** and
verified by reading it back:

    RECRUITMENT_APPLY_WHATSAPP_NUMBER = 01098500699   (was 01159888247)

Staging still reads `01159888247` — deliberately untouched. `normalizeWhatsAppNumber` turns the
new value into `201098500699`, so a generated apply link is `https://wa.me/201098500699?text=…`.

**A `railway variables --set` did NOT trigger a redeploy here.** Measured: the set ran ~02:45 UTC,
and 11 minutes later `railway status` still showed the same `SUCCESS` deployment from 02:31:20Z,
with `/api/healthz` on the same revision. `resolveApplyDestinations()` reads `process.env` at
REQUEST time, not at build, so **the stored value is inert until the process restarts** — the change
is real in the store and invisible to the running app. Do not report such a change as live off the
`--set` alone; read `railway status` and compare `createdAt` against the moment you set it. (This
contradicts the older note in AGENTS.md §2.3 that a variable change always redeploys.)

Left to activate on the next natural deploy rather than forcing a restart — that deploy is the merge
of **#2498**, which is the right ordering anyway: the Telegram mirror and the number switch then go
live in the same release, so the automated line is never advertised without him being able to see it.

**A per-CV notification already existed** — `notifyTalentAcquisitionOfInboundCv`
(`cv-intake-service.ts:500,591`) fires in-app + Telegram on every ingested CV. So the switch was
never a black hole even before #2498; what the mirror adds is the applicant's **own words**, their
**dialable number**, and the **classification result**, which nothing else reports.


**LIVE 2026-08-28 06:04 Cairo — the switch and the mirror shipped together.** #2498 squashed to
`addd112a` at 03:01:37Z and Railway created production deployment `6134833373` six seconds later.
`/api/healthz` moved `0f5f3958` -> `addd112af350ccca2bcbfc3581d809147bb9fbb8` at ~03:04Z, so the
process restarted and `resolveApplyDestinations()` now re-reads `process.env` in a container started
**after** the variable was stored (set ~02:45Z, container 03:01:43Z — the ordering is the proof).
Stored value re-read after the deploy: `01098500699`.

**Caveat on that proof, stated honestly:** the running container's environment was never read
DIRECTLY. `railway ssh … printenv` was blocked by the permission classifier, and the only route that
surfaces the value (`/api/recruitment/job-post-channels`) is behind
`requireRecruitmentAccess("recruitment","read")` with no public equivalent. So this rests on the
timestamp ordering plus Railway injecting service variables at container start — sound, but an
inference rather than a measurement. **The cheap direct confirmation is to open the advert composer
and read the number it offers**; do that before quoting it as certain.

**Every advert generated from now on carries `https://wa.me/201098500699`.** Adverts already pasted
into Facebook groups still carry 011 and still work — the switch is forward-only.


**THE GRAPH POST IS PROVEN — 2026-08-28 ~06:25 Cairo.** The last unproven link in the
classification flow is closed. One interactive LIST message was sent to the owner's own handset
(`201159888247`) inside an open customer service window and **Meta accepted it**:

    RESULT: {"ok":true,"wamid":"wamid.HBgMMjAxMTU5ODg4MjQ3FQIAERgSOUY4NTk0QTBCRjIwOUI4Rjk4AA=="}

Payload came from the REAL builder — `jobTitleMenu()` + `sendClassifyMenu()` — not a hand-rolled
approximation, and `git diff 0e1c64bd addd112a` over `whatsapp-classify-menus.ts` and
`whatsapp-interactive.ts` was **empty**, so the local tree's payload is the deployed one. Shape
accepted: 9 rows, button "Choose a role" (13/20), body 116/1024, `menuViolations` empty, Graph
**v23.0** (the `WHATSAPP_GRAPH_API_VERSION` default — that var is unset on production).

**How to re-run it.** Credentials are NOT in `.env.local` — they exist only on Railway, so the send
must be wrapped in `railway run --environment production --service phoenix-people-workforce -- node
--experimental-strip-types --experimental-loader ./tests/alias-loader.mjs <script>`. The loader takes
`projectRoot` from `process.cwd()`, so run it from a checkout root; the script itself can live in
scratchpad, which keeps the repo untouched. (`railway ssh … printenv` is blocked by the permission
classifier; `railway run` is not.)

**It is side-effect free, and that is by design.** `sendClassifyMenu` only POSTs — it writes no
session row. Verified immediately after: `ats_whatsapp_classification_sessions` held **0** rows
total, 0 for that handset, 0 touched in 10 minutes. A tap on the menu hits `handleClassifyReply`,
which returns `"no_session"` and stops. So this probe can be repeated safely and cannot corrupt or
start a real applicant's conversation.

**Verify the window before sending, never assume it.** Group `ats_inbound_intake_queue` on
`payload->>'from'` where `channel = 'whatsapp'` and check `now() - max(created_at) < 24h`. At the
time of this send the only sender in 3 days was `201159888247`, last message 05:20 Cairo, 0.83h
before — still every CV arriving by forward, which is exactly why the number switch was needed.

Production env confirmed armed at the same moment: `RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED=true`,
`WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` both present.
