---
name: access-profile-sync-gap-and-ai0007-fix-2026-08-15
description: "Why user_access_profiles goes missing/stale on account-add (auth_user_id NOT NULL key), the AI-0007 prod sync (do NOT undo), and the auto-sync PR in flight"
metadata: 
  node_type: memory
  type: project
  originSessionId: e871ae7f-c99e-4d10-ab4e-d4f8cffd8863
  modified: 2026-08-15T13:16:24.749Z
---

**The non-obvious constraint:** `user_access_profiles.auth_user_id` is **`uuid NOT NULL`** and is the
`onConflict` key. A profile row **cannot exist without a GoTrue `auth_user_id`** — so profile sync
MUST live in the app provisioning code that mints the auth identity; a plain DB trigger can't
synthesize the NOT NULL uuid. Verified prod 2026-08-15 (153 accounts).

**Two failure classes (the whole "profiles drift" family):**
1. **Silent skip.** `upsertAccessUserCore` (`src/lib/admin/access-control.ts` ~L707) writes the
   profile only `if (authUserId)`. An account with NULL `auth_user_id` still gets its `app_auth_users`
   row but the profile write is skipped with NO error/log. → CN-0006 (Adel Srour, active Medical Rep)
   and PD-0007 (Bahaa Gamal, inactive) both have app rows, NULL auth id, and NO profile.
2. **One-table role change** ([[changing-a-user-role-needs-four-writes]]): `app_auth_users.role`
   changed without the profile 2nd write → stale profile. This was **AI-0007**.

**AI-0007 = Mahmoud Eldaly — FIXED in prod 2026-08-15, do NOT undo.** app role was already
District Manager (16 live sessions, runtime correct) but had NO profile row and `auth.users`
metadata read Employee/SELF. Synced in one tx: inserted `user_access_profiles`
(District Manager/`manager`/`TEAM`), merged `auth.users` raw_app/user_meta with `||` (provider
preserved), audit row written. **No session_version bump / no app_sessions revoke** — the primary
role was already correct, so this only heals the secondary tables; it cannot change runtime access.

**CN-0006 + PD-0007 BACKFILLED in prod 2026-08-15 via `ops:backfill-access-profiles --apply
--confirm-production=2` (actor `admin-HR`), do NOT undo.** CN-0006 (Adel Srour, active): identity
minted, profile Medical Rep/employee/SELF, NOT banned, one-time setup link issued (no email — link
in stdout for the owner). PD-0007 (Bahaa Gamal, resigned): identity born banned (`banned_until`
2126), profile written, NO setup link. admin-HR already had its profile. Fleet now 0 missing profiles.

**NEW FINDING — the same dry-run surfaced 5 profiles with stale `manager_hr_id`; held for owner
ruling, NOT applied.** The script treats `app_auth_users` as authoritative for `manager_hr_id`, WRONG
for resigned accounts. 3-table compare (profile vs app_auth_users vs employees): **B-105 (Mariem
Hany) + B-65 (Nourhan Fawzy)** — ACTIVE, profile has stale `AA`, both app_auth_users AND employees
say `AI-0007` → clearly fix. **B-99 (Aya Adel), B-109 (Ahmed Mahmoud), B-160 (Khaled)** — INACTIVE,
profile already matches employees (B-180/B-180/B-101), app_auth_users is the OUTLIER
(A-12/A-12/B-157) → the script would REGRESS them, so held. Lesson: for `manager_hr_id`, sync only
when `employees` agrees with `app_auth_users`.

**PR #2158 MERGED (squash `3e68a96f`) + LIVE in prod 2026-08-15** (`/api/healthz` revision = squash
SHA), do NOT undo. Was branch `codex/auto-sync-access-profiles`.
Makes the profile write observable (`logError` event `access_control_profile_write_skipped_no_auth_user_id`
in `upsertAccessUserCore`, was a silent `if(authUserId)` with no else), adds regression test
`tests/access-profile-sync.test.ts` (source-audit style, registered in run-tests.ts), and authors
`scripts/backfill-missing-access-profiles.ts` (`pnpm run ops:backfill-access-profiles`) — dry-run by
default, `--apply --confirm-production=<plan size>`, mints GoTrue id for NULL-authid accounts, verifies
`employees.hr_id` FK, hard-excludes AI-0007, leaver-safe (inactive → identity born banned + NO setup
link). Run in prod 2026-08-15 (see above). Reviewed by control-tower (all 4 helper signatures + every test regex traced);
subagent ran FULL local validation GREEN (lint, `tsc --incremental false`, test 779 files, build)
+ break-the-fix proof (reverted the `else`, the test failed on its own headline assertion, restored,
green). CI corroborating (typecheck+secret-scan green, validate/lint pending). NOTE: the parent
session and the subagent collided on the same branch+scratchpad — the subagent misread the parent's
PR body as "fabricated/injected"; it was NOT, just two Claudes clobbering one file. Don't run a
subagent on a branch the parent is also touching. When running the backfill later, set
`PHOENIX_ACCOUNT_PROVISION_ACTOR` to a real admin login (default "system" fails the actor-FK guard).
Related: [[nosiba-b1-elevated-to-district-manager-2026-08-15]], [[account-creation-defaults-role-to-employee]].
