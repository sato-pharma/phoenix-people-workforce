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
| **The enterprise** | Sato Pharma's own managed Google Play organization. Employees' devices enrol into it, and the app is published to it. | Free | **Does not exist.** `ANDROID_MANAGEMENT_ENTERPRISE_NAME` is set nowhere — not in the environment, not in the docs. |

That is the whole prerequisite. It is the same enterprise
[`src/lib/devices/android-web-app.ts`](../src/lib/devices/android-web-app.ts) already needs, so the
native app and the managed-tablet web app wait on one free step between them, not two.

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

1. Create the enterprise once, with the company Google account, and set
   `ANDROID_MANAGEMENT_ENTERPRISE_NAME` to the binding it returns (`enterprises/LC…`).
2. Mint a web token with `PRIVATE_APPS` enabled and embed the iframe in Phoenix.
3. Upload the `.aab` from `npm run build:aab` on the Private apps page.
4. It auto-approves for the organization and is **typically ready for distribution within about ten
   minutes**.

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

---

## What no session will do

- Create the company Google account.
- Sign the Managed Google Play agreement, or create the enterprise.
- Create the Expo account that EAS builds under.
- **Give OneSignal its Android credentials** — without them the app is built, installed and signed in,
  and no notification ever arrives:
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

- **The exact iframe embedding flow in Phoenix.** The API surface is confirmed; no code has been
  written against it yet, and `android-web-app.ts` documents an open question about how it
  authenticates in production — the Google Cloud org policy
  (`constraints/iam.disableServiceAccountKeyCreation`) blocks long-lived service-account keys, and
  that applies here too.
- **Whether a private app is asked for Google Play's Data safety form.** Public apps must fill it in;
  nothing here confirms whether the managed Play iframe asks for it. If it does, the table above is
  the answer.
- **A notification arriving on a real phone.** The tap rules are tested and the app typechecks in CI,
  but no build carrying OneSignal has run on a handset — that waits on the Firebase key and a first
  EAS build. The first check, once both exist: sign in on the phone, allow notifications, see Profile
  read "On", then press the push test in the web portal's notification settings, which sends only to
  whoever presses it. Its link is the portal profile, so tapping it should open the app's Profile
  screen.
