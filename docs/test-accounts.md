# Test accounts

**Owner, 2026-09-27:** a login the Super Admin makes in **production** that lives inside a real
employee's employee portal — her screens, her data — with its own password, and whose work is never
saved as hers. He makes one for a rep and one for the rep's manager, and the two work a plan through
together.

## What one is

| Piece | Where |
| --- | --- |
| The row | `app_auth_users` with `is_test_persona = true`, a `TEST-…` login id, **no `hr_id` of its own**, and `test_persona_of_hr_id` naming the real employee it mirrors. Two check constraints hold that shape (`supabase/migrations/20260927235452_app_auth_users_test_accounts.sql`). |
| The session | `resolveSessionState` (`src/lib/auth/server.ts`) turns it into the MIRRORED person: `hrId` and `role` are hers, and `access.testPersona` is set. A test row with no mirror, with an HR id of its own, or pointed at an admin-shell role is **refused**, never downgraded. |
| The write guard | Phoenix CRM and `/api/auth/` write for real. Since 2026-11-06 every other write **runs fully and saves nothing** — see "Every other save runs fully and saves nothing" below. A write the proxy could not mark, or with the fence not live, is still refused, before the route runs. |
| Phoenix CRM | Every read and save is forced into the `is_test` world (`src/lib/phoenix-crm/server/access.ts`), with the mirrored person's own territories, scope and authority. A test manager decides **test** entries only, as the reviewer he mirrors — never a real one, never the SFE step. A test entry notifies the **test accounts** and nobody else (see below). |
| The shell | Only an employee-portal role can be mirrored (`canBeMirrored`), so a test account always lands in the portal. Every portal page carries a "Test account" banner. |
| The screen | `/admin/test-accounts`, Super Admin only: make one, point it at somebody else, switch it off, and copy its one-time set-password link. The link is never emailed; the Super Admin opens it in a private window and chooses the password himself. |

## Rules that follow from it

- **Never widen `TEST_ACCOUNT_WRITABLE_PREFIXES`** (`src/lib/auth/test-persona.ts`). That list WRITES FOR
  REAL; a module joins it only after it has a test world of its own, the way Phoenix CRM has `is_test`.
  Every other module already works for a test account through the dry run below.
- **A Phoenix CRM test row carries the REAL person's HR id** (`rep_hr_id`, `issued_to_hr_id`, `hr_id`),
  because a test account works as her. Every `phoenix_crm_*` read keyed by a person or a seat must filter
  `is_test`, or test work leaks into her real figures. The behaviour verdict's place read was the one
  that did not (fixed with this change); the hourly photo, voice and time-check allowances now count per
  world.
- **Reports** read real AND test entries for a test account (its own work beside the real team's),
  except the exceptions and adoption boards, which read test entries only.
- **My map** reads real AND test entries for a test account too, and draws each customer ONCE
  (`mergeTestWorld`, `src/lib/phoenix-crm/my-map-rules.ts`). Its twin is the same territory, list and
  `normalizeContactName` fold. A test copy with a place of its own stands in for its real twin; a copy
  with no place gives way to it; visits and today's plan follow the copy shown. Why: on 2026-10-27 the
  test world held 1,031 active customers, 1,029 with no place at all and 995 of those copies of real
  ones, so the district manager test account read alone drew 0 pins (13 test customers against 267 real on
  that team). Read both ways it draws 267 customers on 269 pins. An empty My map card names the
  validated customers with no pin (`withoutPin`, per list), and says "No validated customer" only when
  there is none.
- A test account stops working the day the person it mirrors leaves: the lifecycle gate reads the
  mirror's employment, at sign-in and on every request.
- **What is read per LOGIN rather than per person is copied or not shared.** The three sales-scope
  overrides (`sales_scope_override`, `line_scope_override`, `product_scope_override`) are copied from
  the mirrored person's account when a test account is made or repointed, so the sales screens reach
  exactly what hers do. A temporary module lock is per login and is NOT copied: a lock on her does not
  reach her test account.

## The risk review's holes (2026-09-28), and the rule they teach

The write guard sees only non-read requests, so the review hunted what else could still change her
data. Each is closed and pinned:

- **A write that trusts a stored row's world.** Submitting or reopening a weekly plan took `is_test`
  from the plan row and threw the gate's answer away, so a test login replaying a REAL plan's id could
  move her real plan and notify her real manager. The gate's answer is now compared with the row's.
  **Rule: never call a `territoryFor*` gate for its side effect alone — use or compare what it returns.**
- **Push identity.** `/api/notifications/push/context` gives a test login no HR id, or `OneSignal.login`
  would move the device onto HER push user.
- **Reads that write** (a GET or a page load writing under her HR id): the bell's stale-approval
  archive, the interview-calendar feed token (a lasting link to her calendar — refused), the ROI export
  audit's "exported by" row (skipped), and her residence geocode on the expense pages (answered, not
  saved). A new GET that writes keyed on `access.hrId` must skip the write for `access.testPersona`.
- **Every password path** (sign-in, password setup, change password) skips the Supabase bridge.

The copy of role, line and scope overrides is taken when the account is made or repointed; repoint it
(or make it again) if the real person's own account changes. Her departure is checked live.

Pinned by `tests/test-accounts.test.ts`.

## The test world tells the test accounts (owner, 2026-09-28)

Until this date a test entry told nobody at all, which made the manager half impossible to try: the
owner sent a weekly plan as `TEST-AYA` and `TEST-DF` was never pinged, so he had no way to see the
approval arrive as a real manager sees it. His instruction was to make the test world notify the test
accounts.

**The hard part is that a notification is addressed by HR id, and a test account has none.** Its
session carries the MIRRORED person's id, so anything addressed to it is addressed to her — and a
notice landing on Dina Hamdy's real bell, or worse her Telegram, is the one outcome test accounts
exist to prevent. So the notice is still addressed to her, because `employee_hr_id` and
`recipients` are what the bell queries by, and a **marker** decides who may see it:

| Piece | What it does |
| --- | --- |
| `notification_events.test_login_id` | The `TEST-` login allowed to see this row. **NULL on every real notification**, which is why nothing about a real person's bell changes. |
| `metadata.testLoginId` | The same value, written as well as the column. `createNotificationEvent`'s fallback upsert (an old schema, no column) carries metadata but not columns — a marker kept only in the column would write a test notice as a real one. Two carriers keeps that path fail-**closed**. |
| `testLoginMarkerOf` / `testNoticeVisibleToViewer` (`src/lib/notifications/in-app.ts`) | The reader. An unmarked row is everybody's, as before. A marked row belongs to **one** test login: not the employee it is addressed to, not another test login, not a Super Admin. |
| `testAccountsMirroring` (`src/lib/auth/test-persona-directory.ts`) | Turns each real recipient into the ACTIVE test accounts mirroring him. A recipient nobody mirrors — a Super Admin playing in the test world — is **dropped**, never fallen back to the real person. |

**A test notice is in-app and nothing else.** Her Telegram chat id, her push subscription and her
email address are all hers. `notifyPhoenixCrm` asks for `["in_app"]`, and
`createSystemNotificationForRecipient` narrows the resolved channels again from the marker, so
neither a policy nor a channel preference can widen it back.

🔴 **The test notice carries an idempotency key of its own** (`…:test:TEST-DF`). `notification_events`
upserts on `event_key`, so reusing the real notice's key would **overwrite a real person's
notification row** with a test one. That is not a tidiness point; it is the leak the suffix exists to
prevent, and `tests/test-accounts.test.ts` pins it.

Everything here is pinned in `tests/test-accounts.test.ts`, whose headline assertion is the plain
one: **the real person never sees a test-world notice.** Each assertion was proved by breaking the
code and watching that exact line fire.

## The staging test sign-in

**Owner, 2026-11-03:** a Claude session could not rehearse a flow as a test account — the password is
his alone, and no session types a password on production — so the Sohag → Assiut stop rehearsal
stopped twice at the sign-in. On **staging only**, a test account now signs in through the ordinary
login form with a shared key in place of its own password.

| Half | Refuses when |
| --- | --- |
| `APP_ENV` | it is anything but exactly `staging` (unset and mistyped open nothing) |
| `PHOENIX_STAGING_TEST_SIGNIN_KEY` | it is missing or shorter than 32 characters |
| `NEXT_PUBLIC_SUPABASE_URL` | it names the production project (`ozucdzovmcqvepbozvqf`) |
| The account | it is not a test account (`is_test_persona`) — a real login never signs in with the key |

All four are required. The account's own password is tried first; the departure check on the mirrored
person still applies; failed attempts count against the same rate limit as any wrong password.

**What the owner does, once:** set `PHOENIX_STAGING_TEST_SIGNIN_KEY` (32+ random characters) on the
**staging** Railway service only, and make a test account on staging from `/admin/test-accounts` there.
A session is then given the key in its own chat by him, never pasted into a shared one. **Never set
the key on production.** Code: `src/lib/auth/staging-test-sign-in.ts`; pinned by
`tests/staging-test-sign-in.test.ts`.

## Every other save runs fully and saves nothing (owner, 2026-11-06)

**His words:** "make the test account everything in it as the real … never I see you are blocked
because the test was made for Phoenix CRM; now everything, every export, anything, but on the test
data". Asked how a save outside Phoenix CRM should behave, he chose **"Runs fully, saves nothing"** —
the rule the expense form has had since 2026-10-28, now everywhere.

| Piece | What it does |
| --- | --- |
| `proxy.ts` | Deletes any `x-phoenix-test-dry-run` the browser sent, then sets it on a write whose signed session cookie is a `TEST-` login and whose path is not one a test account writes to for real (Phoenix CRM, `/api/auth/`, the expense dry run). The response carries the same header. |
| `resolveAccessContext` / `resolveAccessContextFromPage` | Let a marked test-account write (API route or server action) run — only when `testDryRunFenceIsLive()` proves the fence is the fetch in use. Anything else is refused as before. |
| The fence (`src/lib/auth/test-dry-run.ts`, installed first in `instrumentation.ts`) | While a marked request is served, no write leaves the server: a PostgREST insert/upsert answers with the rows sent plus an id; an update or delete reads the matching rows for real and answers with the change laid on; a STABLE function runs as it is; a VOLATILE function runs through `phx_test_dry_run_rpc` (migration `20261106183517`), which calls it exactly as PostgREST would inside a sub-transaction, keeps its answer and rolls back every row it wrote — so its checks, refusals and answer are real. Storage uploads, moves and removals answer "done"; signing a link passes. Every other host — email, Telegram, OneSignal, WhatsApp, Google, Phoenix itself — answers "done" and nothing is sent; only POSTs that are reads (AI, Google routes/places/maps, the Google token, Sentry) go out. |
| Mail that is not fetch | `sendComposedMessage` (SMTP) and `ensureCopyInSent` (IMAP) answer a dry run themselves. |
| Modules that refused on their own | The coaching skills survey and the HR operations report call `assertTestAccountWriteIsDryRun`. |
| The page | `TestDryRunNotice` (mounted with the portal's test-account banner) shows "Test account — every check ran on the real data. Nothing was saved and nobody was told." after each such save. |

**What it cannot do:** a flow that saves a row and then reads that same row back (to show it, or to
build on it) finds nothing, because nothing was kept — that screen can show an error or an empty
result. A browser upload straight to storage through a signed upload link is not a server write, so
its file is stored (nothing points at it). The interview-calendar feed link stays refused: it is a
lasting link to the real person's calendar, not a save.

Pinned by `tests/test-account-dry-run.test.ts` (each headline assertion was proved by breaking the
fence and watching it fire).
