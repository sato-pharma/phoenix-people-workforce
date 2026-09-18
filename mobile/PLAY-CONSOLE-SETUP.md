# Getting Phoenix onto employees' phones — the Play Console setup

Every step here is the owner's own. Creating a Google Play developer account needs identity details
and a payment card, so no session does it on his behalf and none will ask to. This file exists so
that when he sits down to do it, nothing is a surprise and nothing is done in the wrong order.

The route itself was decided on 2026-09-18 and is recorded in [README.md](README.md): **managed
Google Play**, a private app, visible only to Sato Pharma.

---

## Read this first — one Google account decides everything

🔴 **Register the Play Console with the same Google account that administers the company's managed
Google Play enterprise.** Google's own Custom App Publishing guide states that the owner account of
the developer account should also be an admin of the enterprise the private app is published to.

This is the one thing here that is genuinely painful to undo. A developer account cannot be moved to
a different Google account — apps can be transferred between accounts, but that is a separate
process with its own requirements, and the US$25 is not refunded. Ten seconds picking the right
account at the sign-in screen is worth more than every other step in this file.

Use a company account (`something@satopharma.com`), not a personal Gmail, and not an account only
one person can reach. If that person leaves, the app leaves with them.

---

## Before paying anything — the free half is not done yet

Managed Google Play needs **an enterprise** as well as a developer account, and they are two
different things:

| Thing | What it is | Cost | Status today |
| --- | --- | --- | --- |
| **The enterprise** | Sato Pharma's own managed Google Play organization. It is what employees' devices enrol into, and what the app is published *to*. | Free | **Does not exist.** `ANDROID_MANAGEMENT_ENTERPRISE_NAME` is set nowhere — not in the environment, not in the docs. |
| **The developer account** | The Play Console identity that *publishes*. | US$25, one time | Does not exist. |

**The enterprise comes first**, for two reasons. It is free, so nothing is risked by doing it first.
And the **Organization ID** that the private app is published to is read out of the managed Google
Play (EMM) console — *Open the EMM iframe → settings icon → copy the Organization ID from the
Organization details box* — not out of the Play Console. Registering and paying before the
enterprise exists buys an account with nothing to publish to.

The enterprise is also what [`src/lib/devices/android-web-app.ts`](../src/lib/devices/android-web-app.ts)
already needs. Both tracks wait on the same free step.

### 🔴 The fee is buying *native*, not *distribution*

This is worth saying plainly before the card comes out, because a session recorded the opposite
constraint on the same day the Play route was chosen.

`android-web-app.ts` distributes a Phoenix app through managed Google Play **for nothing** — no
developer account, no fee, no signing key. Google's Android Management API builds an installable app
from a title, a URL and an icon, and force-installs it. That file records the owner's constraint of
2026-09-18 as *"that this cost nothing"*.

That route is real and it works, but it wraps the existing website. It cannot give offline working,
push notifications, the camera or GPS, and it cannot distribute the Expo app in `mobile/`. **The
US$25 is what buys a genuinely native app.** Free distribution already exists for the web wrapper.
If the native capabilities are not wanted after all, the fee is not needed at all.

---

## The one decision — personal or organization

Both types publish private apps and both cost the same US$25. Google states plainly that *personal
and organization accounts have access to the same functionality*. A private app does **not** require
an organization account.

What separates them is verification, and which direction you can travel afterwards:

| | Personal | Organization |
| --- | --- | --- |
| What Google asks for | Developer name, legal name, address, contact details | All of that, plus organization name, address, phone, **website**, and a **D-U-N-S number** |
| How long | Same day | Gated on the D-U-N-S number |
| Publicly shown | A developer email and phone | A developer email and phone |
| Afterwards | **Can be converted to organization** | 🔴 **Cannot be converted back.** Google: *"we do not support changing an account from organization to individual"* — it needs a whole new account and a second US$25 |

A **D-U-N-S number** is Dun & Bradstreet's nine-digit business identifier. It is free, and the
company may already have one — it is worth looking up before requesting a new one. Google's own
pages do not cover how to obtain it and point at `service.dnb.com/home`.

**Recommendation: register Personal today, and request the D-U-N-S number in parallel.** Personal is
the direction that can still be changed; organization is the one-way door. It costs nothing to
convert later, and the conversion keeps the same account — the apps, reviews and history stay put.
Nothing about the app is worse in the meantime, because a private app is never listed on the public
store where a developer name is read.

The honest argument against it: Google describes personal accounts as being for students, hobbyists
and amateur developers, and organization accounts as being for business use. An internal HR app for
a pharmaceutical company is business use. It is not in any of the four categories Google *mandates*
an organization account for — financial products, health apps, VPNs and government apps — but the
mismatch is real, and it is the owner's call whether to wait for the D-U-N-S number instead.

---

## Step 1 — register the developer account

1. Sign in at [play.google.com/console](https://play.google.com/console) with **the account chosen
   above**. Check the avatar in the corner before going further.
2. Choose the account type decided above.
3. Fill in the identity details. For an organization, the legal name and address must **match the
   Dun & Bradstreet record exactly** — a mismatch is the usual reason verification stalls.
4. Accept the Google Play Developer Distribution Agreement.
5. Pay the **US$25**, one time, not a subscription and not per device. 🔴 **A prepaid card is
   refused** — it must be a normal credit or debit card.
6. Verification. Personal accounts are typically immediate. Organization accounts may be asked for a
   deposit challenge or bank documents, which Google says *can take up to 5 days*.

Nothing below can start until this account exists.

---

## Step 2 — create the app and point it at the company

In the Play Console, with the enterprise already created:

1. **All apps → Create app.**
2. Set the default language and the app title **exactly as it should appear to employees in managed
   Google Play** — this is the name they will see on the phone.
3. Go to **Test and release → Setup → Advanced settings → Managed Google Play**.
4. **Add organization.** Paste the Organization ID from the EMM console and a short description. One
   app can be targeted at up to 1,000 organizations; Phoenix needs exactly one.
5. **Save.**

At this point the app exists and is private to Sato Pharma. It has no binary yet.

---

## Step 3 — the first upload

The artifact is the `.aab` produced by `npm run build:aab` in `mobile/` — the `production` profile.
See [README.md](README.md) for what that build does and which signing key ends up where.

1. **Test and release → Production.**
2. Upload the `.aab`.
3. **Start rollout to Production.**

It reaches the organization's managed Google Play within a few minutes.

🔴 **Every later upload needs a higher `versionCode` than the one before it.** Managed Play refuses
an upload that does not raise it, and the refusal happens after the build, not before.

---

## Later — publishing without opening the Play Console

Google's **Custom App Publishing API** publishes a private app in as little as five minutes, against
more than two hours through the Play Console interface. It is not wired up, and it cannot be until
the account exists. When it is worth doing, the order is:

1. A Google account, a Google Cloud project, and the Play Console developer account — all three.
2. In the API Console library, enable **Google Play Custom App Publishing API**.
3. **IAM & Admin → Service accounts → Create service account**, then furnish a new private key.
   🔴 The key file is a credential: it never enters this repository, and `.gitignore` in `mobile/`
   already refuses the common key extensions.
4. In the Play Console, grant that service account's email address the **create and publish private
   apps** permission.
5. Note the **developer account ID** — the numeric value after `/developers/` in the Play Console
   URL.

One catch worth knowing in advance: the owner's Google Cloud organization policy
(`constraints/iam.disableServiceAccountKeyCreation`) blocks long-lived service-account keys, which is
the same obstacle `android-web-app.ts` already documents for the Android Management API. Whatever is
chosen there — a key exception, impersonation, or workload identity federation — will apply here too.

---

## What no session will do

- Create the Google account, or the developer account.
- Enter identity details, or pay the US$25.
- Accept the Developer Distribution Agreement.
- Obtain the D-U-N-S number.

These need his identity and his card. They are his to do, and a session that offered would be
overstepping.

## What is not verified here

Stated so that nothing in this file is taken for more than it is:

- **The D-U-N-S number in Egypt.** The number is free worldwide, and D&B quotes roughly 30 business
  days as standard with an expedited option for a fee — but those figures and that fee are US
  pricing. Neither the cost nor the timeline for Egypt was confirmed, and Google's pages do not cover
  it at all.
- **The exact in-console conversion path.** That personal converts to organization and organization
  does not convert back is Google's own wording. The specific menu path for starting it
  (*Developer account → About you → Change account type*) comes from Google's developer community
  rather than a Play Console help page, so expect the labels to differ slightly.
