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
in this folder on every pull request that touches it, so a lockfile that only installs behind a
flag now goes red before it reaches `main`.

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

## What is not here yet

Offline, push notifications, camera and GPS. All four exist in the web portal and all four need
native equivalents in this app — they are the next phases, not oversights.
