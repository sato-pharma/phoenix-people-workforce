# Getting Phoenix onto employees' phones

**Correction, 2026-09-18.** An earlier version of this file said publishing needed a Google Play
Console developer account, a US$25 registration fee, and a decision between a personal and an
organization account with a D-U-N-S number behind it. **None of that is required.** Publishing a
private app through the managed Google Play iframe creates the developer account automatically and
waives the fee. The fee, the D-U-N-S number, the account-type decision and the identity verification
were all real — for a route this app does not need to take. Nothing was spent finding out.

Google's own wording, from
[Publish private apps from managed Play in your EMM console](https://support.google.com/googleplay/work/answer/9146439):

> "When you publish a private app for the first time, Managed Google Play automatically creates a
> Play Developer account on behalf of your organization. You don't need to pay a registration fee
> for this account."

---

## What actually has to exist

One thing, and it is free:

| Thing | What it is | Cost | Status today |
| --- | --- | --- | --- |
| **The enterprise** | Sato Pharma's own managed Google Play organization. Employees' devices enrol into it, and the app is published to it. | Free | ✅ **Exists since 2026-09-24** — `ANDROID_MANAGEMENT_ENTERPRISE_NAME = enterprises/LC017auv4o` in Railway production, alongside `ANDROID_MANAGEMENT_PROJECT_ID = phoenix-hr-2026` and an `ANDROID_MANAGEMENT_KEY` service-account credential. |

That is the whole prerequisite, and it is **met**. It is the same enterprise
[`src/lib/devices/android-web-app.ts`](../src/lib/devices/android-web-app.ts) already needs, so the
native app and the managed-tablet web app cleared that one free step together.

🔴 **Read this row before concluding anything is blocked on the enterprise.** Until 2026-09-25 it
said "Does not exist", which is how a session came to report the mock-location rollout as waiting on
a step that had already been taken.

🔴 **And do not stop at this row either — EVERY step below is already built.** The first correction on
2026-09-25 fixed this table and still told the reader the iframe was unwritten. It was not: the whole
path shipped on 2026-09-18. **Before reporting any of this as remaining work, open the files named in
the sequence below and look.** Twice in one night a session reported as missing something that was
already in the repository, because it trusted this page over the code.

🔴 **Decided 2026-09-18 by the owner: a SHARED `satopharma.com` account** — not a personal Gmail, and
not an account only one person can reach. Two separate things make that choice hard to undo, and both
are settled at the same sign-in screen:

- **The auto-created developer account is non-transferable.** Whichever account creates the
  enterprise owns publishing for good.
- **A company-domain sign-up creates a MANAGED GOOGLE DOMAIN**, not the older managed Google Play
  Accounts enterprise — in Google's own words, *"From 2024, all new organizations completing this
  process will be provided with a managed Google domain."* That is the path Google now recommends for
  new enrolments, which is why the shared company address is the RIGHT answer rather than merely the
  tidier one. A Gmail sign-up falls back to a managed Google Play Accounts enterprise, which is
  Android-only and forecloses cross-device use later.

A managed Google domain means **verifying `satopharma.com` by DNS** with a `google-site-verification=`
TXT record, and merging any existing email-verified Google accounts already using a `satopharma.com`
address — Google prompts for both.

🔴 **ADD that TXT record; never edit or replace what is already in the zone.** `satopharma.com`
carries the Resend DKIM at `resend._domainkey.satopharma.com` and a DMARC of `p=reject`, and
[`src/config/system-settings.ts`](../src/config/system-settings.ts) records the consequence of losing
that verification: **every Sato Email Composer send is refused.** TXT records coexist, so a new one is
purely additive — disturbing the existing pair is not, and the breakage would show up as mail silently
failing rather than as anything on this page.

---

## How a build reaches employees

Publishing happens through the **managed Google Play iframe's Private apps page**, embedded in
Phoenix rather than in the Play Console.

It is reachable from the **Android Management API** — the same API `android-web-app.ts` already
calls, not a separate legacy integration. `enterprises.webTokens` takes an `enabledFeatures` list,
and `PRIVATE_APPS` is one of its values, described as *"The private apps page"*, alongside
`WEB_APPS`, `PLAY_SEARCH`, `STORE_BUILDER`, `MANAGED_CONFIGURATIONS` and
`ZERO_TOUCH_CUSTOMER_MANAGEMENT`.

So the sequence is:

1. ~~Create the enterprise once, with the company Google account, and set
   `ANDROID_MANAGEMENT_ENTERPRISE_NAME` to the binding it returns (`enterprises/LC…`).~~ **Done** —
   `enterprises/LC017auv4o`.
2. ~~Mint a web token with `PRIVATE_APPS` enabled and embed the iframe in Phoenix.~~ **Done, shipped
   2026-09-18.** The page is **`/devices/managed-play`**
   ([`app/(admin)/devices/managed-play/page.tsx`](<../app/(admin)/devices/managed-play/page.tsx>)),
   drawn by [`managed-play-console.tsx`](../src/components/devices/managed-play-console.tsx), minted
   by `POST /api/devices/managed-play`, over
   [`managed-play-iframe.ts`](../src/lib/devices/managed-play-iframe.ts). Gated on
   `company_devices:approve` — **Super Admin only**, asserted in the route, not just the page. The
   page also carries the one-time enterprise signup, so it works from an unbound state too. Pinned by
   `tests/managed-play-iframe.test.ts`.
3. ~~Upload the `.aab` from `npm run build:aab` on the Private apps page.~~ **The AAB exists** — the
   first one was built 2026-09-25 (`production` profile, `STORE`, versionCode 1). **The upload itself
   is the owner's click and is the ONLY step left.**
   🔴 **`versionCode 2` SHIPPED THE MODULES TAB; 3 IS THE IN-APP WEBVIEW BUILD.** Each of those is a
   separate upload, because each needs its own binary. 🔴 **`versionCode 1` IS ALREADY TAKEN IN THE STORE** (owner, 2026-09-28), so it is now **2** in
   `app.json` and the next upload must be the build made from that. `appVersionSource` is `local`, so
   **EAS never increments it — a rebuild at the same number produces an `.aab` Play refuses**, and the
   refusal comes twenty minutes after the build rather than before it. The bump is safe to make freely:
   `versionCode` is NOT one of the Android config keys the fingerprint hashes (those are `adaptiveIcon`,
   `blockedPermissions`, `package`, `permissions`, `predictiveBackGestureEnabled`), so raising it leaves
   the runtime version alone and does not strand the OTA updates already published against it.
4. It auto-approves for the organization and is **typically ready for distribution within about ten
   minutes**.

**Verified on production 2026-09-25**, against the deployed app rather than the source: the page
answers `307 → /login` unauthenticated, `POST /api/devices/managed-play` answers `403`, and the live
`Content-Security-Policy` on that page carries `https://apis.google.com` in `script-src` and
`https://play.google.com` in `frame-src` — the two entries whose absence makes Google's frame fail
silently with nothing in the console pointing back here.

**Ship an AAB.** Google recommends AABs for private apps; the iframe accepts APKs too, but the
`production` profile already produces the right artifact.

### Limits and one-way doors

- **15 private app uploads per day**, and web apps count toward the same total. Worth knowing before
  a day of rapid iteration — it is a ceiling on *uploads*, not on installs.
- 🔴 **A private app published this way is permanently private.** Google is explicit that these
  cannot be converted to public apps, because they are not subject to the same review. Correct for
  Phoenix, which should never appear on the public store — but it is not reversible.
- 🔴 **The auto-created developer account is non-transferable.** See the account warning above.

---

## The rep tablets take an APK, not the AAB — and through ManageEngine

The rep tablets do **not** enrol through Google. Google gives a new Cloud project a device quota of
**zero** until it approves an application, so the Google QR is refused on the tablet; ManageEngine is
an approved EMM with its own allowance and is how every tablet in this fleet is managed. That makes
its app repository, not managed Play, the channel that puts Phoenix on a rep's tablet today.

🔴 **The AAB cannot be uploaded to ManageEngine.** An `.aab` is a Play-only publishing format: Google
builds the per-device APKs from it. An MDM that sideloads onto a managed device needs the installable
artifact itself. Build with the **`mdm`** profile — `buildType: "apk"`, `distribution: "internal"` —
and upload that `.apk`:

```
eas build --platform android --profile mdm
```

🔴 **`mdm` builds for `arm64-v8a` only, and that is deliberate.** The universal APK carried
native libraries for all four ABIs and reached **152 MB** — which ManageEngine's gateway refused: it
read the whole body and answered `406 Not Acceptable`, twice, after nine minutes of upload. The
profile pins the one architecture the fleet runs (`-PreactNativeArchitectures=arm64-v8a`), which drops
three redundant copies of Hermes and the React Native core.

**The cost is real and belongs in writing: a 32-bit-only tablet cannot install this APK.** Every
arm64 device can, which is every tablet in this fleet and every Android tablet sold since about 2015.
The store `production` profile is untouched and still carries every ABI — Google builds the
per-device APKs from the AAB, so nothing on the public store is narrowed by this.

**Its channel is `production` on purpose, matching the store profile.** An APK built on the `preview`
channel is a working tablet that silently never receives an `eas update` again, and nothing on the
device says so. Both artifacts on one channel means one OTA stream reaches the store build and the
tablets together. Do not "tidy" `mdm` onto its own channel.

**Phoenix does the upload itself now — this page said it could not, for as long as that was true.**
`src/lib/devices/manageengine/apps.ts` lists the repository and installs, removes or refreshes an app
on a device, and since #4391 it also uploads: `uploadManageEngineApp` posts the file to `/emsapi/files`
(part name `fileName`, header `module: MDM_APP_MGMT`) and registers it with `POST /api/v1/mdm/apps` as
an enterprise app. The **Rep Tablets** page carries it, in the company app repository panel.

🔴 **Upload through that page, not from a laptop.** The browser's leg ends at Railway, and Railway
reaches ManageEngine in seconds. A direct upload from this machine put the whole body on the wire for
nine minutes and was refused at the end of it. Contrast **deleting a device**, which the
vendor genuinely does not expose — see `src/lib/devices/manageengine/commands.ts`.

---

## What the Play Console route would have cost

Kept only so nobody re-derives it and reaches the wrong conclusion again. **Do not take this route.**

A Play Console developer account costs **US$25 one time**, a credit or debit card (prepaid refused),
and identity verification. An organization account additionally needs a **D-U-N-S number** — free,
but roughly 30 business days by Dun & Bradstreet's standard service. Personal converts to
organization later; organization does **not** convert back.

The **Custom App Publishing API** belongs to that paid route: it wants a Play Console developer
account behind it. The iframe replaces it. **Do not build against the Custom App Publishing API** on
the assumption that it is the only programmatic way to publish.

---

## Signing — unchanged, and still the thing to get right

None of the above touches signing. **No keystore lives in this repository**; `.gitignore` in
`mobile/` refuses `*.jks`, `*.p12`, `*.key` and `*.p8`, and EAS generates and holds the key.

Under Play App Signing, EAS holds the **upload** key and Google holds the **app signing** key. A lost
upload key is recoverable — request a reset. That safety net is a property of Play App Signing
itself, not of which door created the developer account, so it holds on this route too.

🔴 **The fingerprint to register with any API provider is the APP SIGNING key's, never the upload
key's.** Google re-signs the delivered artifact, so a Maps, Firebase or OAuth integration registered
against the upload key's fingerprint will fail on every installed copy while working perfectly in
testing.

**Push notifications do not depend on it** — an earlier version of this line said they gated the push
phase, and they do not. Firebase asks for a certificate fingerprint only for features such as Google
sign-in and phone-number sign-in; Cloud Messaging is not one of them, and OneSignal delivers through
Cloud Messaging.

🔴 **Every upload needs a higher `versionCode` than the one before it**, and the refusal comes after
the build, not before.

🔴 **And the version NAME moves with it: `version` is `0.<versionCode>.0`.** Only the code is forced to
change — Play refuses a lower one and says nothing whatever about the name — so on 2026-09-28 codes 1,
2 and 3 all shipped as `0.1.0` and the company repository listed three different binaries under one
string. Both fields live in `app.json` (`appVersionSource` is `local`, so EAS increments neither), and
neither is part of the runtime fingerprint, so raising them strands no OTA and no installed build.
Pinned by `tests/mobile-version-names.test.ts`.

---

## What the app reads from the phone

In one place, because a store form or a device policy may ask:

| Permission | Used for | When |
| --- | --- | --- |
| Camera | The profile photo, and evidence photos — today the outstation departure photo | Only while the person is taking a photo |
| Precise and approximate location | Where an evidence photo was taken: stamped on the photo and sent to Phoenix with it | Only while an evidence photo is being taken — never in the background |
| Notifications | Showing the notifications Phoenix already sends to the web portal — approvals, requests, reminders | Asked once per install, the first time the app opens signed in with notifications ready; after that only when the person presses "Turn on notifications" on Profile |

The Phoenix server sends the coordinates to Google's geocoding service to word the address, exactly
as it does for the portal's own departure photo. Background location is not merely unused:
`app.json` blocks `ACCESS_BACKGROUND_LOCATION` and `FOREGROUND_SERVICE_LOCATION` from the manifest,
so no library can add them back.

The notification library, OneSignal, can collect location too. It is built without its location
module (`disableLocation: true` in `app.json`), so notifications add no location reading.

🔴 **OneSignal is a native module too**, so notifications also reach a phone only in a new binary.

🔴 **The departure photo added native modules** (`expo-location`, `@shopify/react-native-skia`), so
it reaches a phone only in a new binary with a higher `versionCode` — there is no over-the-air path.

**But reading MORE from a module already installed does not need a binary, and assuming otherwise
costs a wasted build.** `runtimeVersion` is `{"policy": "fingerprint"}`, so the test is mechanical:
if the fingerprint is unchanged, `eas update` lands on the binaries already out there. The
mock-location flag (2026-09-25, #4366) reads `LocationObject.mocked` off the object `expo-location`
already returns — no new module, **Android fingerprint `15a5625f…` identical to the 2026-09-23
update**, and `mobile-ota.yml` shipped it to both channels automatically three seconds after the
merge. **Compare the two fingerprints before concluding a rebuild is needed:**
`eas update:list --branch production --json`.

---

## What no session will do

- Create the company Google account.
- Sign the Managed Google Play agreement, or create the enterprise.
- Create the Expo account that EAS builds under. **Done 2026-09-18:** the organization **Phoenix Sato
  CRM** (`@phoenix-sato-crm`) owns the project `@phoenix-sato-crm/phoenix-workforce`, and `app.json`
  carries its `owner` and `extra.eas.projectId`. Expo's sign-up also made an empty starter project,
  **Omar**. It is not this app: never link its id, whatever Expo's "Get started" page suggests.
- **Give OneSignal its Android credentials.** **Done 2026-09-18:** the key came from the Firebase
  project **Phoenix Workforce Push**, which sits outside the Google Cloud organisation, so step 3's
  policy never applied, and OneSignal's Google Android (FCM) platform reads Active. The steps stay
  here for the day the key is replaced. Without the credentials the app is built, installed and
  signed in, and no notification ever arrives:
  1. Create a Firebase project and, under its service accounts, generate the **Cloud Messaging (FCM
     v1) service-account key** — a JSON file.
  2. Upload that file to the **same OneSignal app the web portal already uses**: Settings → Push &
     In-App → Google Android (FCM). A second OneSignal app would split employees across two
     audiences, and Phoenix's one send reaches only the one its server is configured for.
  3. If Google refuses to generate the key, the organisation policy
     `constraints/iam.disableServiceAccountKeyCreation` is on — the same one `android-web-app.ts`
     runs into. An Organization Policy Administrator overrides it for that one project, the key is
     generated, and the policy goes back on. Turning it back on does not disable a key already made.
  4. The key is a credential: it goes into OneSignal and nowhere else, never into this repository.

Each needs the owner's own identity or an account in his name. Everything after them is ordinary work
this repo can do.

## What is not verified here

- **A web token actually minting against the live enterprise.** The code, the gate and the CSP are all
  verified (step 2 above); what no session has watched is Google returning a token for
  `enterprises/LC017auv4o` and the frame rendering. That needs the production credential, so **the
  owner opening `/devices/managed-play` is itself the test** — if the private apps page draws, the
  whole chain works. The authentication question `android-web-app.ts` raises is **answered in
  practice**: a long-lived `ANDROID_MANAGEMENT_KEY` service-account credential is present in Railway
  production, so `constraints/iam.disableServiceAccountKeyCreation` was overridden for
  `phoenix-hr-2026` the same way it was for the Firebase key. Do not re-derive it as a blocker.
- **Whether a private app is asked for Google Play's Data safety form.** Public apps must fill it in;
  nothing here confirms whether the managed Play iframe asks for it. If it does, the table above is
  the answer.
- **A notification arriving on a real phone.** The tap rules are tested and the app typechecks in CI,
  but no build carrying OneSignal has run on a handset yet. The Firebase key is in place since
  2026-09-18, so what remains is installing a first EAS build. The first check, once one is on a phone: sign in on the phone, allow notifications, see Profile
  read "On", then press the push test in the web portal's notification settings, which sends only to
  whoever presses it. Its link is the portal profile, so tapping it should open the app's Profile
  screen.
- **Force logout silencing a real phone.** The server side is tested with OneSignal stubbed out and
  has never run against a handset. Once a build delivers notifications, use a phone signed in as
  someone who can be logged out: Force logout from the Activity dashboard should report one phone
  stopped, and the push test pressed in a browser signed in as that person should no longer reach
  the phone. After they sign in on the phone again, Profile should read "On" and the push test
  should arrive.

---

## Automating the upload (draft only — the release click stays the owner's)

Step 3 above — dragging the `.aab` onto the Private apps page — is the owner's click. It can be
automated **up to, but not including, the release**, so nobody hand-drags a file again while the
decision to distribute stays a human one. Owner decision, 2026-09-29: *"wire it as a draft upload
and I'll press release."*

**What is wired (this PR).** `mobile/eas.json` now carries a `submit.production.android` profile:

```json
"submit": {
  "production": {
    "android": {
      "serviceAccountKeyPath": "./google-play-service-account.json",
      "track": "production",
      "releaseStatus": "draft"
    }
  }
}
```

`releaseStatus: "draft"` is the whole point: `eas submit` uploads the bundle to the production
track as a **draft**, so it appears in the Play Console staged and un-released. It goes to nobody
until the owner opens the release and presses **Release**. It is NOT `completed` — a `completed`
submit publishes to the org with no human step, which the safety classifier blocks and the owner
declined.

**The one thing only the owner can provision — a Play service-account key.** `eas submit` talks to
Google's Play Developer API (`androidpublisher` edits) as a service account, not as a person. That
key does not exist yet and cannot be created from a session (it lives in the owner's Google
console):

1. In the Play Console → **Setup → API access** (or the linked Google Cloud project), create a
   **service account** and grant it permission to **manage releases** for this app.
2. Download its **JSON key**.
3. Place it at `mobile/google-play-service-account.json` (gitignored — it is a publishing
   credential and is never committed). For an EAS-hosted submit instead of a local one, store it as
   an EAS secret rather than a file.

Until that key is in place, `eas submit` cannot run; the build step still produces the `.aab` and
hands over its link, exactly as before.

**How it runs.** After the store build finishes:

```
eas submit --platform android --profile production --id <buildId>
```

(or `--path <the .aab>`). It uploads the draft; the owner then presses Release in the Play Console.
🔴 **The FIRST such submit must be watched once** before it is trusted unattended — a private
managed-Play app's exact track/edit behaviour has not been exercised through the Developer API here,
only through the iframe. The Oct 1 delivery task will attempt this draft submit **only if the key
file is present**, and otherwise falls back to handing over the `.aab` link.

**versionCode still climbs by hand-safe rule.** `appVersionSource` stays `local`, so `app.json`'s
`versionCode` is the source of truth and Play refuses a re-used code — see the versionCode note
under step 3 above. A draft that Play refused for a duplicate code surfaces ~20 minutes after the
build, not before it.
