# Phoenix Workforce — Android app

The employee portal as a native Android app (Expo / React Native). Phase 1: sign in against the
live Phoenix API, and the portal home screen.

## Seeing it on a phone, without building anything

1. Install **Expo Go** from the Play Store on the handset.
2. On this machine, from `mobile/`:

```bash
npm install && npx expo start --tunnel
```

3. Scan the QR code the terminal prints with Expo Go.

`--tunnel` rather than a LAN address on purpose: the phone and the laptop do not have to be on the
same network, which they usually are not. It is slower to load and that is the only difference.

The app talks to **production** (`https://phoenix-hr.satopharma.com`) unless told otherwise, so
signing in signs you into the real system with your own HR ID and your own permissions. To point a
build somewhere else, put this in `mobile/.env.local`:

```
EXPO_PUBLIC_PHOENIX_API_URL=https://phoenix-people-workforce-staging.up.railway.app
```

Any non-production target is labelled on the login screen and on Profile — staging holds real names
and real payroll, so which system is answering is never left implicit.

## How the app reaches employees

**Decided 2026-09-18: managed Google Play.** The app is published as a private app to the company's
own managed Play store and the tablets install it from there. Direct install — sending an `.apk` to
each handset — was weighed the same day and rejected.

The deciding argument was not update effort. A managed fleet blocks installs from unknown sources by
default, so sideloading would have meant deliberately weakening that policy on every tablet, and a
sideloaded app has no channel to pull a bad build back through. Managed Play keeps the fleet locked
and makes a bad release withdrawable centrally.

**What it costs: nothing.** An earlier version of this section said it needed a Google Play Console
developer account and **US$25** — corrected the same day. Publishing a private app through the
managed Google Play iframe creates the developer account automatically and waives the registration
fee, in Google's own words: *"You don't need to pay a registration fee for this account."* There is
no fee, no card, no identity verification and no D-U-N-S number on this route.

What it does need is the company's **managed Google Play enterprise**, which is free and does not
exist yet — the same one the managed-tablet web app already waits on.

**[PUBLISHING.md](PUBLISHING.md) is the order to do it in** — the one free prerequisite, which Google
account to use and why that choice is permanent, and the upload limits and one-way doors worth
knowing before the first release.

`eas.json` carries both profiles, and `production` is now the live one:

| Profile | Produces | Route | Status |
| --- | --- | --- | --- |
| `production` | `.aab`, store distribution | Managed Google Play | **The chosen route** |
| `preview` | `.apk`, internal distribution | Direct install to one handset | Testing only — rejected as the way employees get the app |

`preview` keeps its place: it is how a build gets onto a phone for a look before anything is
published. It is no longer a distribution plan.

### Building

Expo Go runs the JavaScript but is not the app. A real binary is built by **EAS Build**, on Expo's
servers. That is not a preference: an Android build needs a JDK, the Android SDK and Gradle, none of
which are installed on this machine, and a Gradle build wants several GB of RAM that a 16 GB box
running a dozen sessions does not have.

One thing has to happen first, and only the owner can do it: **an Expo account**. It is free, and
`eas` will prompt for it.

```bash
cd mobile
npx eas-cli@latest login     # or `register` — Expo account, not a Phoenix one
npx eas-cli@latest init      # writes extra.eas.projectId into app.json — commit that
npm run build:aab            # the store artifact — the chosen route
npm run build:apk            # a test install for a single handset
```

### Publishing without living in the Play Console

A private app does not go through public store review. Releases go out through the **managed Google
Play iframe's Private apps page**, embedded in Phoenix — so Phoenix stays the place a release is made
from, instead of the Play Console becoming a manual step in every ship. A private app auto-approves
for the organisation and is typically ready to distribute **within about ten minutes**.

It is reachable from the **Android Management API** this repo already calls: `enterprises.webTokens`
takes an `enabledFeatures` list, and `PRIVATE_APPS` is one of its values.

🔴 **Not the Custom App Publishing API.** An earlier version of this section pointed at it. That API
belongs to the paid Play Console route and wants a developer account behind it — the iframe replaces
it, and building against it would re-introduce the fee this project does not need to pay.

Not wired up. The enterprise has to exist first — the order is in [PUBLISHING.md](PUBLISHING.md).

### Signing — which key, and which one can be replaced

**No keystore lives in this repository.** `.gitignore` here refuses `*.jks`, `*.p12`, `*.key` and
`*.p8` so one cannot be committed by accident, and EAS generates and holds the key instead. That is
true on both routes: `eas build` signs with the keystore attached to the project either way, and
from the build's point of view an upload certificate and an app signing key are the same thing.

What differs is what that key *is*, and it decides how bad losing it is:

| Route | EAS holds | Google holds | If that key is lost |
| --- | --- | --- | --- |
| Managed Play (`.aab`) | the **upload** key | the **app signing** key | Recoverable — request an upload key reset in the Play Console. The app signing key never changes, so installed apps keep updating. |
| Direct install (`.apk`) | the app signing key itself | nothing | Terminal — an APK signed with a different key cannot upgrade one already installed. |

So on the chosen route, losing the Expo account is an inconvenience rather than a wall. That warning
is real, but it belongs to the route that was rejected — do not carry it across.

🔴 **The fingerprint to register with any API provider is the APP SIGNING key's, never the upload
key's.** Google re-signs the artifact users actually receive, so a service keyed on a certificate
fingerprint — Maps, Firebase, OAuth, anything of that shape — will reject the installed app if it
was registered against the upload certificate. Both fingerprints sit on the Play Console's app
signing page; take the app signing one. This is a failure that shows up late, in a feature that
worked perfectly in testing.

### Installing a newer build over an older one

`appVersionSource` is `local`, so the version lives in `app.json` where it can be read in a diff
rather than in a service. Bump `expo.android.versionCode` before every build meant to replace an
existing one: Android refuses to install an APK whose code is not higher than the installed one, and
managed Play refuses the upload outright — the friendlier of the two failures, because it happens
before anyone has the build. `expo.version` (`0.1.0`) is the human-readable one and is what people
will quote back to you.

### What the app talks to

Production (`https://phoenix-hr.satopharma.com`), so signing in signs a real employee into the real
system with their own permissions. To build one pointed elsewhere, set
`EXPO_PUBLIC_PHOENIX_API_URL` in the build profile's `env` block in `eas.json` — any non-production
target is labelled on the login screen and on Profile.

### Over-the-air updates — not set up, and the one thing to get right if they are

**There is no update pipeline today.** `eas.json` has no `channel` and `expo-updates` is not a
dependency, deliberately, so that nothing here implies a capability that does not exist.

It is worth knowing what it would buy. EAS Update ships the non-native parts of the app —
JavaScript, styling, images — over the air to an already-installed app. This app is almost entirely
those parts: screens, business rules, API calls, copy. A new binary, and so a new store release, is
needed only for a change to native code or native dependencies, a change to app permissions, or an
Expo SDK upgrade.

🔴 **If you wire it, pin the runtime-version policy deliberately — do not take a default.** The
runtime version is what ties a JS bundle to the native binary that can run it. Publish a bundle to a
binary whose runtime does not match and the app may misbehave or crash on launch. Managed Play can
withdraw a bad *binary*, but an over-the-air bundle never travels through the store at all — it goes
from EAS straight to the installed app. So the recall path the chosen route buys does not cover the
one channel that can reach every tablet at once.

It is the same shape as the signing note above — cheap to get right at setup, expensive to discover
later. Both are recorded here rather than left to be rediscovered.

## Why npm here, and pnpm in the repo root

React Native's Metro bundler resolves modules by walking `node_modules` directly, and pnpm's
symlinked store breaks that in ways that surface as missing-module errors at runtime rather than at
install time. Expo supports npm and yarn; this folder uses npm and keeps its own
`package-lock.json`. **Never run `pnpm` in here**, and never run it in the repo root from a
worktree — §5 of `AGENTS.md` has the account of what that costs.

`mobile/` is excluded from the root `tsconfig.json` and `eslint.config.mjs`: React Native's JSX and
DOM-free type set are incompatible with the Next.js project's, so the two typecheck separately.

```bash
npm run typecheck      # tsc for this app only
```

## The `overrides` block in `package.json`

`react-dom` is pinned to `$react` — npm's reference to whatever spec the `react` dependency
carries, today `19.2.3`. Nothing in this app imports `react-dom`: it is Android and iOS, and
`app.json` declares no web platform. It arrives as a peer dependency of Expo's web-support tooling
(`@expo/metro-runtime`, `@expo/ui`, and `vaul` and the `@radix-ui` packages under `expo-router`),
none of which name a version, so npm takes the newest release — and `react-dom@19.3.0`, published
after this folder was set up, requires `react@^19.3.0`. Against this app's pinned `react@19.2.3`
that is an `ERESOLVE` conflict, which is why a plain `npm install` here failed and why the lockfile
had to be regenerated with `--legacy-peer-deps`. That flag strips every peer-installed package out
of the lockfile, and the cost showed up one step later: `npm ci` refused to run at all (`EUSAGE`,
29 packages "missing from lock file", `react-dom` and the whole `metro` set among them) and a plain
`npm install` silently rewrote 196 lines of lockfile on every machine that ran it. Pinning the peer
fixes both, and the `$react` form needs no maintenance — react and react-dom move together on the
next Expo SDK bump. Peer checking stays on, which a blanket `legacy-peer-deps=true` in an `.npmrc`
would have switched off for every future conflict as well.

So: **install with a plain `npm install`.** If `--legacy-peer-deps` or `--force` ever looks
necessary again, something real has changed and belongs in this section rather than in somebody's
shell history. The `mobile` job in `.github/workflows/ci.yml` runs `npm ci` and `npm run typecheck`
in this folder on every pull request that touches it, and it became one of `main`'s required
checks on 2026-09-18, so a lockfile that only installs behind a flag now goes red before it
reaches `main`.

`uuid` is pinned to `11.1.1` for a Dependabot advisory on `@expo/config-plugins → xcode →
uuid@^7.0.3` (missing buffer bounds check generating v3/v5/v6 UUIDs, CVSS 7.5). `xcode` only runs
at `expo prebuild` time to edit iOS `.pbxproj` files, and this app is Android-only, so the
vulnerable code never actually executes — but the override is verified safe (`xcode` calls only the
named `uuid.v4()` export, which uuid 11 still ships; a real `.pbxproj` fixture parses, gets mutated,
and re-serialises correctly through it) and closes the alert at no cost.

A second advisory, `expo-router → query-string@7.1.3 → decode-uri-component@^0.2.2` (denial of
service via exponential decoding of malformed percent-encoded input), is **deliberately left open**.
Its only fix, `decode-uri-component@0.5.0`, rewrote the package as ESM-only with no CommonJS build.
`query-string@7.1.3` (the last 7.x release — 8.x is an unrelated breaking rewrite) loads it with a
plain `require()`, which under Node's CJS/ESM interop returns `{ default: fn }` instead of the
function itself, so `query-string.parse()`/`.parseUrl()` throws `TypeError: decodeComponent is not a
function` on every call — breaking deep-link parsing outright. `npm audit fix --force` confirms
there is no in-range fix either: its only suggestion is downgrading `expo-router` to `5.1.11`, an
unrelated Expo SDK generation. Re-open this once `query-string` or `expo-router` ships something
compatible with the fixed `decode-uri-component`.

## How a screen gets its data

The web portal has almost no read API — its pages are server components that call
`src/lib/<domain>/` directly. So each native screen needs a thin JSON route added beside the page
it mirrors, under `/api/employee-portals/` with its eighteen siblings — not a new namespace of
its own. The pattern, and the only pattern:

```ts
// app/api/employee-portals/home/route.ts
const access = await resolveAccessContext(request);
await assertPermission(access, "employee_profile", "read");
return NextResponse.json({ data: await getPortalHomeSnapshot(access), success: true });
```

Resolve access, assert the **same permission the page asserts**, hand back what the domain service
returned. No business logic in the route and none in the app: payroll, leave, expense and sales
rules stay in `src/lib/<domain>/`, computed once, so the app and the browser can never disagree
about a number.

`/api/employee-portals/home` drops `latestPayslip` before answering. No payslip appears on any
overview or landing screen for any role — not the amount, not the month label — and filtering it
server-side means a future home-screen widget cannot leak it by accident.

## Authentication

The app signs in through the ordinary `/api/auth/login` route and stores the resulting session
token in the Android Keystore via `expo-secure-store` — never `AsyncStorage`, which is a plaintext
file inside the app sandbox.

It is the **same signed token** the browser keeps in its `phoenix_session` cookie, carried in an
`Authorization: Bearer` header instead, and validated by the same code: signature, expiry, the
`app_sessions` row (revoked, session_version), and the employee-lifecycle gate. Same 12-hour
absolute lifetime, revoked the same way by "Log out everywhere". `src/lib/auth/native-session.ts`
in the repo root explains the one thing that genuinely differs, and what would harden it.

## Working without a signal

A rep in a pharmacy basement still sees their figures. The last good answer from each endpoint is
kept on the device, and served **only** when the phone could not reach Phoenix at all.

🔴 **The cache is never silent.** Cached data always arrives stamped with when it was taken, and the
screen says so above the numbers — "Showing what was last loaded, at 12:04 today" — before they are
read rather than after scrolling past them. A screen that renders cached data without saying so is a
defect, not a style choice. That notice is deliberately not red: being offline with labelled data is
the app working, not an incident.

Three rules decide when it is used:

| Situation | What happens | Why |
| --- | --- | --- |
| The request never landed (`NetworkError`) | Serve the cache, labelled | The phone is the problem, and the figures were true when taken |
| The server answered and said no (`ApiError`, e.g. a 500) | Show the error, never the cache | Stale figures on top of a live fault hide the fault behind data that looks fine |
| A 401/403 | Sign out and **clear the cache** | The session is over; nothing of that employee's should stay readable on the handset |

It is also dropped on a deliberate sign-out, and anything older than **12 hours** is not served at
all — that is the session's own absolute lifetime, and a KPI from two days ago is not a degraded
version of today's, it is a different number.

**It lives in the OS keystore, not AsyncStorage**, for the same reason the token does: AsyncStorage
is a plaintext file inside the app sandbox. What is cached is not a credential, but it is the
employee's own KPI, leave and sales data, and there is no reason to hold it to a lower standard than
the token sitting beside it. That costs no new dependency — `expo-secure-store` was already here.

The keystore's price is a **2,048-byte ceiling per value** on Android, so `offline-cache.ts` refuses
anything over 1,600 bytes rather than truncating it, and simply does not cache that endpoint. A
portal snapshot is a few hundred bytes of scalars, so this is headroom — but a future screen wanting
to cache a long list needs a different store and must not quietly squeeze into this one.

## Taking a photo

`src/lib/camera.ts` opens the camera and returns what was taken. The first screen to use it is the
profile tab, where an employee sets their own photo — `POST /api/employee-portal/profile-photo`, the
same route and the same `employee_profile:update` permission the web app's profile tab uses.

**The camera only — never the gallery.** `launchImageLibraryAsync` is deliberately not imported, so
a picture this app sends was taken on this phone, now. The web app's live photo capture makes the
same choice for the same reason: an image chosen from a gallery can be any image from any day. A
"choose from library" button added here would retire that property for every future screen at once.

**Every outcome is ordinary, so nothing throws.** A tapped-away camera, a refused permission, an
oversized file: `capturePhoto` returns a discriminated union and the screen says the one true thing.
A refused permission is reported two different ways depending on `canAskAgain`, because "tap again
and allow" and "turn it on in Android Settings" are different instructions and guessing wrong wastes
the person's time.

**The app asks for the camera and nothing else.** `expo-image-picker`'s config plugin adds
`RECORD_AUDIO` to the manifest by default; `microphonePermission: false` in `app.json` blocks it.
This app never records video, and an HR app requesting a microphone it never uses is the kind of
thing an employee is right to distrust.

🔴 **`camera.ts` on its own is still not the evidence camera.** It returns a bare picture — no time,
no place, no stamp — and a profile photo needs nothing more. Evidence goes through
`src/lib/evidence-photo.ts` (next section), which wraps it. Wiring `capturePhoto` straight into venue
validation, a direct-order storefront or any other evidence upload would produce a picture the desk
has no way to trust.

## The departure photo — evidence with a place and a time

An outstation trip does not reach payroll until its departure photo is taken, and it can only be
taken at the destination. The Home tab lists the trips waiting for one — `GET
/api/outstation/departure-photo-due`, the portal's own list from the same server function — and
"Open camera" on a trip runs `captureDeparturePhoto` in `src/lib/evidence-photo.ts`:

1. **Location permission first, then the camera.** Android's permission prompt and its "turn on
   location" dialog are full-screen; landing one on a photo the person has just framed reads as the
   app losing it.
2. **The camera**, at quality 1 — the camera's own file, so the photo is compressed once, at the
   end, as on the web.
3. **A fresh GPS fix**, waited for at most 12 seconds (the portal's own patience) and never a cached
   last-known position. Then **the address**, from `POST /api/outstation/reverse-geocode`: the server
   words the address, brick, area and region, so the app never words a place itself.
4. **The stamp, burned into the pixels** with Skia (`evidence-burn.ts`), the photo shrunk to 1280 px
   on its longest side and saved as a JPEG at quality 0.74.
5. **The upload**, to the portal's own route, `POST /api/outstation/{id}/departure-photo`.

🔴 **The stamp is the portal's stamp, and a test holds it there.** An approver compares the departure
photo with the trip's arrival photo, which the portal stamped. `evidence-stamp.ts` is a copy of the
portal's pure stamp code
([`evidence-watermark.ts`](../src/components/outstation/evidence-watermark.ts) and
[`location-stamp.ts`](../src/lib/evidence/location-stamp.ts)), because the app cannot import a
browser-canvas module. [`tests/mobile-evidence-stamp-parity.test.ts`](../tests/mobile-evidence-stamp-parity.test.ts),
in the web app's required `test` check, runs the two side by side and fails on any difference in
wording, time, wrapping, geometry or draw call. Change the web stamp and that test says to change the
copy in the same PR. Never loosen the test instead.

**A missing position is said, never faked.** With no fix the stamp reads "no GPS fix" and the upload
**leaves the coordinates out** rather than sending null: the route reads them with
`Number(body.latitude)`, `Number(null)` is 0, and the approver would be told the photo was taken
thousands of kilometres from the trip instead of "unknown". After the save, a photo with no position
or only an approximate one says why, and what to change next time.

**Foreground location only.** The `expo-location` plugin runs with background location, the
foreground service and activity recognition all off, and `blockedPermissions` in `app.json` strips
`ACCESS_BACKGROUND_LOCATION` and `FOREGROUND_SERVICE_LOCATION` from the manifest, so no library can
bring them back. The app reads a position only while someone is taking an evidence photo.

**No queue.** A photo that fails to send is not kept for a later retry: a departure photo sent from
somewhere else would carry the right stamp and the wrong journey. The person is told to take it again
while still there. For the same reason the list is **never shown from the offline copy** — a stale
list offers the camera for a trip already photographed, and the approver's summary counts every
retake.

**Why Skia.** The photo is decoded, scaled, stamped and encoded on the phone in one pass. Skia's
decoder applies the JPEG's orientation tag, so a camera file saved sideways comes out upright, and its
paragraph layout shapes Arabic — Google returns the address in Arabic as often as in English — where
drawing with a single typeface prints empty boxes. It adds a few megabytes to the app.

🔴 **Skia and `expo-location` are native modules, so this needs a new build** with a higher
`versionCode`. There are no over-the-air updates (see above), so a phone on an older build simply
does not have the departure photo until it installs the new one.

## What is not here yet

Push notifications. They exist in the web portal and need a native equivalent in this app — the next
phase, not an oversight.

🔴 **Push notifications are gated on the app signing key**, not on code: Firebase has to be
registered with the **app signing** key's fingerprint, never the upload key's. See the signing
section above before starting that phase.

**The other evidence photos are still web-only**: the arrival photo (taken inside the expense
wizard, which this app does not have), direct-order storefronts and marketing venue validation. Each
burns the same stamp, so a native one reuses `evidence-stamp.ts` and `evidence-burn.ts` rather than
inventing a second stamp — and each needs its own list and route checked, as the departure photo did.

**No retake from the app.** The portal's expense submissions page can retake a departure photo while
the trip window is open; the app offers the camera only for a trip that has none yet. A retake is
still made from the portal.
