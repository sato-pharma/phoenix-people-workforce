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

## Producing an installable APK

Expo Go runs the JavaScript but is not the app. A real `.apk` is built by **EAS Build**, on Expo's
servers. That is not a preference: an Android build needs a JDK, the Android SDK and Gradle, none of
which are installed on this machine, and a Gradle build wants several GB of RAM that a 16 GB box
running a dozen sessions does not have.

`eas.json` in this folder is already configured. Two profiles, matching the two ways the app can
reach employees:

| Profile | Produces | For |
| --- | --- | --- |
| `preview` | `.apk`, internal distribution | **Direct install** — a link or file sent to a handset |
| `production` | `.aab`, store distribution | Play Store, if that is ever chosen |

### The direct-install APK

One thing has to happen first, and only the owner can do it: **an Expo account**. It is free, and
`eas` will prompt for it.

```bash
cd mobile
npx eas-cli@latest login     # or `register` — Expo account, not a Phoenix one
npx eas-cli@latest init      # writes extra.eas.projectId into app.json — commit that
npm run build:apk
```

The build runs on Expo's servers and finishes with a download link and a QR code. Opening that link
on the handset installs it; Android will ask to allow installs from an unknown source, because the
app does not come from the Play Store.

**The signing key is generated and held by EAS, not by this repository.** That is deliberate — a
keystore must never be committed, and `.gitignore` here refuses `*.jks`, `*.p12`, `*.key` and
`*.p8` so it cannot happen by accident. Keep the Expo account; losing it means losing the key, and
an APK signed with a different key cannot upgrade one already installed on a handset.

### Installing a newer build over an older one

`appVersionSource` is `local`, so the version lives in `app.json` where it can be read in a diff
rather than in a service. Android refuses to install an APK whose `versionCode` is not higher than
the installed one, so bump `expo.android.versionCode` before each build you intend to replace an
existing install with. `expo.version` (`0.1.0`) is the human-readable one and is what people will
quote back to you.

### What the APK talks to

Production (`https://phoenix-hr.satopharma.com`), so signing in signs a real employee into the real
system with their own permissions. To build one pointed elsewhere, set
`EXPO_PUBLIC_PHOENIX_API_URL` in the build profile's `env` block in `eas.json` — any non-production
target is labelled on the login screen and on Profile.

### Over-the-air updates — not set up, and the one thing to get right if they are

**There is no update pipeline today.** `eas.json` has no `channel` and `expo-updates` is not a
dependency, deliberately, so that nothing here implies a capability that does not exist.

It is worth knowing what it would buy, because it changes how a distribution route reads. EAS Update
ships the non-native parts of the app — JavaScript, styling, images — over the air to an
already-installed APK, internal distribution included. This app is almost entirely those parts:
screens, business rules, API calls, copy. A new binary is needed only for a change to native code or
native dependencies, a change to app permissions, or an Expo SDK upgrade. So "sideloaded means every
tablet by hand, every release" is not true; it is by hand only for that smaller set.

🔴 **If you wire it, pin the runtime-version policy deliberately — do not take a default.** The
runtime version is what ties a JS bundle to the native binary that can run it. Publish a bundle to a
binary whose runtime does not match and the app may misbehave or crash on launch. On a sideloaded
fleet that is materially worse than it sounds: there is no store channel to push a recall through,
so a bad bundle means reaching every affected tablet physically, in the field, one at a time.

It is the same shape as the signing-key note above — cheap to get right at setup, expensive to
discover later. Both are recorded here rather than left to be rediscovered.

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
