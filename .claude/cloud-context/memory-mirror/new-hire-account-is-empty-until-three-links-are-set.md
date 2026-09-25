---
name: new-hire-account-is-empty-until-three-links-are-set
description: "A newly created employee account looks \"buggy and empty\" because role, AU seat, and manager links are all set separately — and a predecessor missing from the seat model silently breaks the auto-hire trigger"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69b89bd8-fa99-43f0-8771-f554f26bcd1a
  modified: 2026-08-02T12:38:38.029Z
---

Diagnosed 2026-08-02 for **Mahmoud Eldaly (AI-0007)**, District Sales Manager, Giza / Anti
Infective, created that morning. Owner reported "account empty, everything buggy". Nothing was
broken — three independent links were unset, and each is set in a different place.

**1. Login role always starts at `Employee`.** `resolveEmployeeAccessRole()`
(`src/lib/employees/access-role.ts`) deliberately ignores job title and returns `"Employee"` for
every auto-provisioned account — a job title is never a permission source. An admin must set
`app_auth_users.role` explicitly (here: `District Manager`). This alone makes the portal look empty.

**2. 🔴 The session caches the role — changing `app_auth_users.role` does NOT affect a live
session.** `app_sessions` stores its own `role` column and `validateAppSession()`
(`src/lib/auth/app-sessions.ts:141`) compares it to the cookie payload, not to `app_auth_users`.
Both match, so the old role survives. **Revoke `app_sessions` rows after any role change** or the
user keeps seeing the old portal and it reads as "the fix did nothing".

**3. Brand-new headcount gets NO AU seat.** The auto seat-hire trigger
(`phx_hire_into_seat_on_vacancy_filled`) only fires for a **replacement** hire and resolves the seat
via `au.f_last_occupied_seat_by_hr_id(predecessor)`. Fix by hand:
`select au.hire_into_seat('<SEAT-ID>','<HR_ID>', date '<YYYY-MM-DD>','<actor>');`

**4. 🔴 The trap that actually broke this one: the PREDECESSOR was missing from the seat model.**
The vacancy chain was perfect — `VAC-B28-PJG`, status `filled`, `replacement_for_hr_id='B-28'`,
`filled_by_hr_id='AI-0007'`. But **B-28 (Heba Abdelbaset, Giza AIF DSM, resigned 2026-07-31) has
ZERO rows in `au.occupancy_history`** — the 2026-07-13 seed left `SEAT-AIF-DM-GZ` as a
`vacant_placeholder` even though a real person held that job. So the trigger hit its
"predecessor never held an au seat — not an error" branch and silently no-opped. **A correct
replacement flow still produces no seat if the person who left was never seeded.** Suspect this
whenever a replacement hire lands seatless.

**5. Sales attribution has TWO paths — check both before saying "no data".**
`sales_records.manager_hr_id` is **stamped at import time**, not a live join, so re-pointing
`employees.manager_hr_id` never restamps history. Direct query
(`hr_id or manager_hr_id = <him>`) returned **0**. But the portal also runs a *continuity* pass:
`fetchPreviousSeatHrIdsForReplacement()` reads `position_vacancies.replacement_for_hr_id` for the
filled vacancy, and `salesRecordMatchesSeatContinuity()` accepts any record whose `manager_hr_id`
is the predecessor's. That returned **140 rows / 464,632 EGP / Jan–May 2026**. **Reporting the
direct count alone understates it — I did this once and had to correct it.**

**6. The manager link is stored TWICE.** `employees.manager_hr_id` *and*
`app_auth_users.manager_hr_id`. `app_auth_users` takes precedence
(`src/lib/employee-portal/service.ts:1083` falls back to employees only when null), so updating
only `employees` leaves the rep's own session pointing at the old manager. Update both.

**Applied for AI-0007 (owner-approved):** role → `District Manager`; `au.hire_into_seat` →
occupancy 155 on `SEAT-AIF-DM-GZ`; `team_id`=41, `area_name`='Giza'; revoked 2 stale sessions;
moved reps **B-105 Mariem Hany** and **B-65 Nourhan Fawzy** from `AA` to `AI-0007` in *both* tables.
His 3 other rep seats (GZ2/GZ4/GZ5) are genuinely vacant headcount, not a data fault.

**AI-0005 / AI-0006 — RESOLVED 2026-08-02.** Both (Medical Reps, created 2026-08-01) had **no
`app_auth_users` row at all** and could not log in. Provisioned as `Medical Rep` (71 of 74 peers
use that role) via the new `scripts/provision-missing-employee-accounts.ts` →
`pnpm run ops:provision-accounts`. 🔴 **Two traps that script now guards:**
`password_setup_tokens.created_by_login_id` is a **FK to `app_auth_users.login_id`**, so the
default actor `"system"` fails — but only *after* the account row is written, leaving a real
account with no way to set a password (this happened to AI-0005; use
`PHOENIX_ACCOUNT_PROVISION_ACTOR=admin-HR`). And an existing account matches **both** the
`login_id` and `hr_id` lookups, so an un-deduped count reads one healthy row as a duplicate.

**AI-0006's seat — DONE 2026-08-02.** `SEAT-AIF-REP-D14` (occupancy 156, effective 2026-08-01).
Resolved *without guessing*: `au.line_area_map` gives D14 the area name **"Gharbia 1 (Tanta)"**,
identical to his `employees.area_id` 1103; region `D1`; manager B-12 is the Delta (1) AIF DM. That
name-match against `au.canonical_areas` is the reliable way to pick a rep seat — the codebase
forbids inferring one from job_title. 🟢 **`au.hire_into_seat` also flips
`au.line_area_map.area_state` `vacant_will_hire` → `occupied` by itself** (via
`au.sync_area_state_for_seat`) — never hand-update that column. D14 carries a 2026-07 target of
590 units / 50,458.50 EGP, which now attributes to him.

**All three 08-01/08-02 hires are now complete:** AI-0005 → `SEAT-AIF-REP-CA6` (Medical Rep),
AI-0006 → `SEAT-AIF-REP-D14` (Medical Rep), AI-0007 → `SEAT-AIF-DM-GZ` (District Manager).
Note `employees.hire_date` was NULL for AI-0006 — the seat date came from his row's creation date.

`employees.area_name` being NULL is a red herring — the directory derives the name by joining
`areas` on `area_id`, so the legacy column is cosmetic. Related: [[resignation-vacancy-opened-by-db-trigger]],
[[organogram-vacancy-occupancy-truth]], [[app-visibility-is-application-scoped-not-rls]].
