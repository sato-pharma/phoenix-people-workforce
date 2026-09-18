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

🔴 **Use a company Google account to create it** (`something@satopharma.com`), not a personal Gmail,
and not an account only one person can reach. The auto-created developer account is
**non-transferable**, so the account that creates the enterprise is the account that owns publishing
for good. This is the one decision here that is genuinely hard to undo, and it costs ten seconds to
get right at the sign-in screen.

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
testing. This is what gates the push-notifications phase.

🔴 **Every upload needs a higher `versionCode` than the one before it**, and the refusal comes after
the build, not before.

---

## What no session will do

- Create the company Google account.
- Sign the Managed Google Play agreement, or create the enterprise.

Both need the owner's own identity. Everything after them is ordinary work this repo can do.

## What is not verified here

- **The exact iframe embedding flow in Phoenix.** The API surface is confirmed; no code has been
  written against it yet, and `android-web-app.ts` documents an open question about how it
  authenticates in production — the Google Cloud org policy
  (`constraints/iam.disableServiceAccountKeyCreation`) blocks long-lived service-account keys, and
  that applies here too.
