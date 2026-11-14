# The second sign-in step, and the leaked-password check

Integration audit INT-005 and INT-006. Built 13 Nov 2026 on the owner's choices, made that evening.

Before this, a password alone opened every account: 0 of the sign-in accounts had a second factor, so one
stolen Super Admin password opened payroll, permissions and every record.

## His choices, word for word

| Question | His answer |
| --- | --- |
| Who is asked | "Super Admin accounts only" |
| What the second step is | "Authenticator app, passkey counts" |
| How often | "Once per device, 30 days" |
| A lost phone | "Recovery codes plus your reset" |
| A password found in a leak | "Refuse it when chosen" |

On production that evening there were two Super Admin accounts: Omar Gawish (one passkey) and the Phoenix
System Administrator account (no passkey, no person behind it).

## What a Super Admin sees

1. **The first password sign-in after this ships.** The password is accepted, and instead of the home page
   the sign-in screen shows a key to add to an authenticator app (Google Authenticator, Microsoft
   Authenticator, 1Password and the like all work). The key can be typed, or opened by a link on a phone.
   Typing the app's 6-digit code finishes the set-up.
2. **Ten recovery codes, shown once.** They are on the screen right after the set-up and never again. Each
   works once, in place of a code from the app. Keep them somewhere that is not the phone.
3. **Every later password sign-in** on a browser that has not passed the step in the last 30 days asks for
   the 6-digit code. "Do not ask on this browser for 30 days" is ticked by default.
4. **A passkey sign-in is not asked.** A passkey already proves the device and the person (the passkey
   routes demand the fingerprint, face or PIN), so it is both steps at once.
5. **The profile's Devices tab** has a "Second sign-in step" card: set it up without signing out (it asks
   the password first), make ten new recovery codes, forget the remembered browsers, reset it, or reset the
   other Super Admin account. If the card cannot read its status (signed out, refused, too many requests, a
   server error or a dropped connection) it says so in its error line, with the server's own message when
   there is one, and offers "Try again"; it never stays on "Loading" (14 Nov 2026, 9 breaks).
6. **Adding a passkey asks the password.** On the "Biometric sign-in" card beside it, "Set up on this
   device" asks the account's current password before the device is asked for its fingerprint, face or PIN.
   The same card lists every passkey on the account, with when it was added and last used, and removes one.

Nobody else sees anything: every other role signs in exactly as before.

## Where it is decided

One place: `app/api/auth/login/route.ts`, after the password and the temporary-password gates and before
the Supabase bridge and `createAppSession`. Only two routes open a session, this one and the passkey verify
route, so there is no second door.

| Answer | When | What the screen does |
| --- | --- | --- |
| 403 `second_step_required` | set up, browser not remembered, no code sent | asks for the code |
| 403 `second_step_setup_required` | not set up | shows the key (JSON only, `no-store`) |
| 401 `second_step_invalid` | wrong, used or expired code | says so; counted as a failed sign-in |
| 200 | the step passed | signs in; a set-up finished here also carries the ten codes, once |

- **It runs for every caller.** "I am the native app" is a header anyone can send, so it excuses nothing.
  Only CI smoke mode is left out: its one hardcoded account is a National Sales Manager, and that mode
  makes no database call.
- **A read that fails refuses the sign-in.** `second-step-store.ts` throws on every failed read and the
  route answers 500 with no session. Nothing turns "could not read" into "not set up" or "remembered".
- **A wrong code is counted with the wrong passwords** (`registerFailedLoginAttempt`), so guessing codes
  locks the account on the same clock: 10 in 15 minutes, for 30 minutes.
- **A form posted with no script may not finish a set-up**, because it could not show the recovery codes.
  It is told to set up and the page signs in again with its script.
- **A set-up finished by a request whose sign-in then failed is undone**, so codes nobody saw are not left
  behind. So is a set-up whose recovery codes could not be made: the account goes back to "not set up",
  never "set up with no codes".

The rules and the arithmetic are in `src/lib/auth/second-step.ts` (no database, no network). The rows are
in `src/lib/auth/second-step-store.ts`. The account's own screen is `app/api/auth/second-step/route.ts`
with `src/components/auth/second-step-card.tsx`.

## The code

RFC 6238 over HMAC-SHA1, 6 digits, 30 seconds: the standard every authenticator app speaks. The test checks
the RFC's own published codes.

- One step either side of now is accepted (a phone clock a little off, or a code typed as it rolls over).
- **A code is good once.** The newest step an account used is stored (`last_used_step`), and only a newer
  step is accepted next. The database decides a race: the step is claimed by an update that still finds
  the row as it was read, so two requests carrying the same code cannot both pass.
- **A set-up key is handed out once.** Every offer makes a new key and the one before it stops working, so
  reloading the set-up screen shows a new key and the old entry must be removed from the app. A key waits
  15 minutes for its first code; a code typed after that is answered with a new key. A wrong code during a
  set-up is refused without sending any key: the screen that was handed it still shows it.

## What is stored, and what is not

Three tables, migration `20261113213439_second_sign_in_step.sql`. All three have row level security on with
no policy, and `public`, `anon` and `authenticated` hold no privilege: only the server reads or writes them.

| Table | Holds | Never holds |
| --- | --- | --- |
| `app_auth_second_step` | the authenticator key **sealed** (AES-256-GCM, `secret-box.ts`), the last used step | the key in plain text |
| `app_auth_second_step_recovery_codes` | a keyed fingerprint (HMAC-SHA256) of each code, and when it was spent | a code |
| `app_auth_trusted_devices` | the SHA-256 fingerprint of a browser's cookie token, and the day it stops counting | the token |

The remembered-browser cookie is `phoenix_trusted_device`: HttpOnly, sent only to `/api/auth`, 30 days, and
never set for the native caller.

**A remembered browser counts only for an account that is set up, and only for its own account.** A cookie
left from before a reset carries nobody past a new set-up.

**Remembered browsers are forgotten** when the password is changed, when a password is set from a link or a
temporary password, when the account resets its second step, and from the card's own button.

## A lost phone

In order, whichever is to hand:

1. **A recovery code**, typed where the 6-digit code is asked.
2. **A passkey.** It signs in without the step; then Profile, Devices, "Move to a new phone" on the card.

**A reset never removes a passkey**, by decision (14 Nov 2026): this path is "sign in with a passkey, then
reset", and a reset that took the passkeys would take the way back in with them. Instead the reset says to
check the "Biometric sign-in" card directly beside it, which already lists every passkey on the account
with when it was added and last used, and removes any that is not recognised. No second list was added. A
reset of the other Super Admin account leaves that account's passkeys too: only that account sees them,
on its own profile. Switching an account off removes all its passkeys, as before.
3. **The other Super Admin** resets the account from their own card. It asks their password and writes an
   audit row naming both accounts.
4. **Break-glass, if both Super Admin accounts are locked out:** delete the account's row from
   `app_auth_second_step` in the database (its codes and remembered browsers go with it). The account is
   back to "not set up" and its next password sign-in is offered a new set-up.

**Why the card asks for the password and not a code.** Every change on the card comes from a session that
already passed the step. The risk left is somebody else using that session (an unlocked laptop, a copied
cookie), and that person does not know the password. Asking for an authenticator code instead would lock
out exactly the person the reset exists for: the one whose phone is gone.

## 🔴 Rotating `PHOENIX_AUTH_SECRET`

The authenticator keys are sealed with it and the recovery-code fingerprints are keyed with it. After a
rotation neither can be read: a Super Admin's **password** sign-in answers 500 until the account's row is
removed. A passkey sign-in still works.

So a rotation of that secret includes one more step: delete every row of `app_auth_second_step` (the
break-glass above, for both accounts), and each Super Admin sets the step up again at their next password
sign-in. `docs/security/secret-rotation.md` says the same beside the secret.

## Leaked passwords

`src/lib/auth/leaked-password.ts`. When a person **chooses** a password (changing it, or setting it from a
link or a temporary password), Phoenix asks Have I Been Pwned's range service whether that password is in a
published leak, and refuses it if it is.

- **What leaves:** the first five characters of the password's SHA-1 fingerprint. The service answers with
  every leaked fingerprint that starts with them (several hundred), and the match is made on the server.
  The password and the rest of its fingerprint never leave. The request carries one header, `Add-Padding`,
  which makes every answer the same rough size; nothing in it names Phoenix or the person.
- **No key, no account, no cost.**
- **It fails open, on purpose, and says so.** If the service does not answer within three seconds, or
  answers something that is not a list of fingerprints, the password is accepted on the rules it already
  passed and the audit row of the password change carries `leakedPasswordCheck: "not_checked"`. Failing
  closed would let an outage of somebody else's service stop every new hire from setting a password. This
  check only ever adds a refusal: with it gone, the rules are what they were.
- **It is asked before anything is written**, and before a set-password link is spent, so a refused
  password leaves the link usable.
- **Passwords already in use are not touched**, and nothing is checked at sign-in. That was his choice.

It is on the Integrations page as "Leaked password check" (38 outside services).

## What the risk review found (13 Nov 2026)

A review of the change before it shipped found no way into an account that is already set up with the
password alone, and no failure that passes a sign-in. Four things were changed because of it:

- **A waiting set-up key was handed to every caller for 15 minutes.** Somebody who knew the password could
  keep asking, hold whatever key was waiting, and so hold the key the owner then put in their phone: valid
  codes for good, with nothing to show for it. Now every offer makes a new key and a refusal carries none.
- **The card handed over a set-up key without the password.** A session somebody else was using could put
  their own phone on an account that was not set up. `begin_setup` now asks the password.
- **A set-up whose recovery codes could not be made stayed set up.** It is undone.
- **The reset list matched the role as stored text.** It now reads the role the way sign-in does
  (`normalizeRole`), so an account stored as "super admin" or "admin" can be reset from the card.

What is left, and known:

- 🔴 **Until an account is set up, its password alone still opens it, and whoever signs in first with the
  password chooses the phone.** The step protects an account from the moment it is set up, not from the
  moment this shipped. Set both Super Admin accounts up as soon as it is live. The Phoenix System
  Administrator account has no person and no passkey: somebody must set it up, or it should be switched off.
- **Adding a passkey asked only for a live session**, and a passkey counts as both steps, so a stolen
  session could add a passkey that outlived a reset of the second step and a password change. **Closed 14
  Nov 2026:** for an account the step is asked of, `app/api/auth/biometric/register/options/route.ts` asks
  the account's current password (`checkPasskeyAddPassword`, `second-step-management.ts`) after the session
  and the rate limit and before any challenge exists: none sent answers 403 `password_required`, a wrong one
  403 `wrong_password` with an audit row. The role is the account's own, from its session, read the way
  sign-in reads it. The verify route asks nothing more: only the options route makes a registration
  challenge, and a challenge is used once and only by the login it was made for. Every other role adds a
  passkey with a live session, as before. A passkey added before this shipped stays: check the list.
- **Wrong codes are capped only by the sign-in lock** (10 in 15 minutes, then 30 minutes): about 480
  guesses a day for somebody who already has the password, each with about 3 chances in a million.
- **Two hand-run scripts sign in as a Super Admin with a password** and will now be answered 403:
  `scripts/audit-page-transitions.mjs` and `scripts/phase24-real-auth-rls-api-smoke.ts`. No workflow runs
  either.

## What pins it

- `tests/second-sign-in-step.test.ts`: the RFC's codes; a code good once and only near now; a remembered
  browser honoured only when set up, for its own account, inside 30 days; the full flows on an in-memory
  database; a failed read refusing; the database deciding a race; nothing readable stored; the route's
  order and answers; the card's guards; the tables' access; a set-up key handed out once and never sent
  with a refusal; a half-made set-up undone.
- `tests/leaked-password.test.ts`: what leaves; padded lines; an unreachable service; both doors asking
  before anything is written.
- `tests/passkey-add-asks-password.test.ts`: who is asked and the three answers; the options route asking
  after the session and before any challenge, from the session's own role, with an audit row; only that
  route making a registration challenge; the card sending and asking for the password, square-edged; a
  reset leaving every passkey; the card saying where to check them.

Each was checked by breaking the fix and watching its own assertion fail (28 breaks, 13 Nov 2026; 19 more
for adding a passkey, 14 Nov 2026).
