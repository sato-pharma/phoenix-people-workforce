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
| The write guard | `resolveAccessContext` refuses every write from a test account outside `/api/phoenix-crm/` and `/api/auth/`, before the route runs; `resolveAccessContextFromPage` refuses server actions. Fail-closed: a module with no test world does not save for a test account, and says so. |
| Phoenix CRM | Every read and save is forced into the `is_test` world (`src/lib/phoenix-crm/server/access.ts`), with the mirrored person's own territories, scope and authority. A test manager decides **test** entries only, as the reviewer he mirrors — never a real one, never the SFE step. Nobody is notified of a test entry (`notifyPhoenixCrm` returns on `isTest`). |
| The shell | Only an employee-portal role can be mirrored (`canBeMirrored`), so a test account always lands in the portal. Every portal page carries a "Test account" banner. |
| The screen | `/admin/test-accounts`, Super Admin only: make one, point it at somebody else, switch it off, and copy its one-time set-password link. The link is never emailed; the Super Admin opens it in a private window and chooses the password himself. |

## Rules that follow from it

- **Never widen `TEST_ACCOUNT_WRITABLE_PREFIXES`** (`src/lib/auth/test-persona.ts`). A module joins it
  only after it has a test world of its own, the way Phoenix CRM has `is_test` — otherwise a test
  account's save is written as the real person.
- **A Phoenix CRM test row carries the REAL person's HR id** (`rep_hr_id`, `issued_to_hr_id`, `hr_id`),
  because a test account works as her. Every `phoenix_crm_*` read keyed by a person or a seat must filter
  `is_test`, or test work leaks into her real figures. The behaviour verdict's place read was the one
  that did not (fixed with this change); the hourly photo, voice and time-check allowances now count per
  world.
- **Reports** read real AND test entries for a test account (its own work beside the real team's),
  except the exceptions and adoption boards, which read test entries only.
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
