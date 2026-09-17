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

## Producing an installable file

Expo Go runs the JavaScript but is not the app. A real `.apk`/`.aab` needs a signing key and a
cloud build (`eas build -p android`), which needs an Expo account and a decision about how the app
reaches employees — Play Store, unlisted Play, or a file sent directly. That decision is open.

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
