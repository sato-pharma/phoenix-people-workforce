---
name: staging-is-now-mock-data-not-a-production-mirror
description: "Staging was re-cloned from production on 2026-08-29 and is now REAL production data - 161 real auth accounts with password hashes, real payroll. Not demo-safe, and storage FILES do not clone so 910 objects 404. A BRANCH CAN be previewed there with `railway up` (environment-scoped, production untouched) - see the top section."
metadata: 
  node_type: memory
  type: project
  originSessionId: 52493c41-8681-4061-aa67-4d730444cc29
  modified: 2026-09-18T10:12:23.013Z
---

## A BRANCH CAN BE PREVIEWED ON STAGING - `railway up`, never `source connect` (2026-09-18, PR 4008)

AGENTS.md §2.3 says a branch "cannot be staged on Railway without shipping it". True of
`railway service source connect` (service-level - it repointed production); FALSE of `railway up`,
which deploys ONE environment's instance. Done live 2026-09-18 when the owner asked
("put 4008 on staging") to press a CV himself before merging:

- Build the would-be merge touching no checkout: `git merge-tree --write-tree origin/main <branch>`,
  then `git archive <tree> | tar -x -C <scratch>`. Prove it differs from main in exactly the PR's
  files (`gh pr view N --json files`). Base on the NEWEST main - staging runs main, so an older base
  rolls other sessions' merges back there.
- Run from that UNLINKED scratch folder with every target as an ID, so a dropped flag errors instead
  of falling to the primary's production link: `railway up . --path-as-root -p dc218ad3-99b7-4aff-be38-953a57524a71
  -e c766d42b-9e0b-4027-b00f-b13a1651b214 -s 30356676-116b-4886-ac6e-89041d80185e --detach -m "PREVIEW ONLY ..."`.
  Never `-y`: with nothing linked it implies `--new`, a new project.
- 🔴 `.railwayignore` reads like .gitignore, NOT .dockerignore: a bare `supabase` also dropped
  `src/lib/supabase` and the build died on 459x `Can't resolve '@/lib/supabase/server'`. Anchor
  every folder with `/` (`/supabase`, `/tests`, `/docs`).
- Proof it stayed on staging: production's deployment list showed no upload and its `/api/healthz`
  kept the main SHA. While the upload serves, STAGING's healthz reads `"revision": null` (no
  `RAILWAY_GIT_COMMIT_SHA`) - that is the "preview is up" signal. The GitHub trigger survived: the
  next main push still auto-deployed staging, which is also what ENDS the preview (main moved 7
  times in 40 min that day). Build took ~2.5 min.
- The auto-mode classifier blocks the upload as "Modify Shared Resources" (then even
  `railway deployment list`) until the owner asks for it in chat.

## REVERSED 2026-08-29 - the mock is gone; read this before anything below

The owner said **"REMOVE THE MOCK DATA AND RECOVER WHAT U DID AND SYNC STAGING WITH MAIN"**. Every
section below this one is a **dated record of what the mock did**, kept for forensics - it is no
longer a description of staging. Restored, row for row, from `mock_backup`, each verified to **zero
differences** against its backup:

| Table | Rows | Key restored on | Verified |
| --- | --- | --- | --- |
| `public.employees` | 171 | `hr_id` | name, work_email, base_salary, crm_id all 0 diffs |
| `public.app_auth_users` | 144 | `hr_id` (login_id itself was mocked - only 5 of 144 matched) | login_id, name, email, **password_hash**, auth_user_id all 0 diffs |
| `public.ats_candidates` | 71 | `id` | full_name, email, phone 0 diffs |
| `public.salary_records` | 691 | `id` | net/gross/base 0 diffs |
| `au.monthly_attribution_rollup` | 4126 | delete+insert | 0 value mismatches |
| `au.monthly_attribution_rollup_meta` | 5 | delete+insert | - |
| `au.monthly_targets` | 270 | delete+insert | - |

**Three unique constraints have to be staged out of the way first or the restore aborts** - a real
value being restored collides with a row that still holds it as mock. On `employees`:
`work_email`, `crm_id`, `crm_username`. On `app_auth_users`: `login_id` (PK **and** a
`lower(login_id)` index) and `auth_email`. On `ats_candidates`: `email_norm`, `phone_norm`,
`national_id_norm`. Set them to a per-row temp value in one statement, then restore in the next.
`salary_records` needs `alter table ... disable trigger user` around the update
(`phx_prevent_closed_salary_records_mutation`); re-enable it and confirm `tgenabled = O`.

**The rollup and targets backups are NOT full snapshots, and that is correct.** Pre-mock, staging
genuinely held a rollup for only 2026-01..04 and 06 (4126 rows) and targets for only 2026-07/08/09
(270 rows). The mock **rebuilt** both to 7064 rows each spanning 2026-01..08 - not a scale factor:
the live/backup value ratio averaged **52x**, and **no target id overlapped in either direction**.
So the restore is delete-all-then-insert, and deleting the 2026-05/07/08 rollup periods loses
nothing real - they were mock-created. A pre-restore snapshot of the mocked state is kept in
`mock_backup.prerestore_rollup_20260829`, `_rollup_meta_`, `_targets_`.

**Do NOT re-stamp the fingerprint.** All 5 restored `monthly_attribution_rollup_meta` rows read
`config_fp <> au.f_attribution_config_fingerprint()` and carry `refreshed_at 2026-08-14` - these
are the exact backed-up values, so the staleness **predates the mock**. Re-stamping would brand the
current config onto rows computed under the old one, which is the precise thing the fingerprint
exists to prevent. The index hook "re-stamp the fingerprint LAST" applied to *applying* the mock,
not to reversing it.

### What could NOT be recovered

These were never backed up, or were wiped in place, and only a **re-clone from production** fixes
them:

- `ireports360_visits.raw_payload` - **116,243 of 116,243** wiped to `{}`.
- `source_of_sales_import_rows.raw_row` - **209,167 of 219,092** wiped to `{}`.
- `email_delivery_events.raw_event` - **7,926 of 7,926** blanked (this mirrored the app's own
  retention job in `src/lib/notifications/email.ts`, so it is the shape the app itself writes).
- `audit_logs.old_values` - 1,205 rows wiped; the rest keep their structure but the **names inside
  them are scrubbed**.
- The jsonb/prose columns scrubbed leaf-by-leaf still carry fake names: `notification_events.metadata`,
  `notification_deliveries.metadata`, `employee_plan_headers.manager_name`/`hierarchy_snapshot`,
  `deduction_candidates.hierarchy_snapshot`, `ats_cv_intake_events.raw_metadata`,
  `field_workforce_compliance_live_snapshots.preview`/`employee_rollup`,
  `admin_cleanup_events.old_values`, `automated_payroll_audit.detail`,
  `field_workforce_compliance_imports.diagnostics`, `outstation_expense_requests.car_evidence_metadata`.
- The bulk CRM and Source-of-Sales tables were never backed up at all.

**An inverse scrub is not the answer and was deliberately not attempted.** Of the 666 real->fake
pairs in `mock_backup.name_map_final`, only **367 reverse unambiguously**: **162** fake names are
themselves real names elsewhere in the map, and the remainder are many-to-one. Reversing the 367
would leave a half-real, half-fake state that reads as authoritative and is not - strictly worse
than a uniformly fake log table. See [[a-mock-name-generator-reproduces-real-employee-names]] for
why the generator collided with real names in the first place, and note `auth.users` was NEVER
scrubbed, so it still holds real emails - which is why restoring `app_auth_users.auth_email`
re-aligns the two.

**Scrub tooling was dropped** (`scrub_names`, `scrub_prose`, `scrub_prose2`, `scrub_jsonb`,
`name_pattern_tbl`). The `mock_backup` schema itself is **kept** as the safety net, including
`name_map_final` (the only surviving record of the mapping) and `inverse_map`.

**Staging code was already in sync with `main`** - no action was needed for that half: the Railway
staging service tracks branch `main` and `/api/healthz` returned revision `3c1430e5`, identical
to `origin/main`. Verified read-only; `railway service source connect` is **service-level, not
environment-scoped**, and would have repointed production too.

---

## Dated record of the 2026-08-28 mock (historical - no longer true of staging)


**Staging `cifwmndunmlxjhyjugxa` stopped being a production mirror on 2026-08-28.** Until that day it
held a full clone of the real company: 171 employees, **120 valid 14-digit national IDs**, 139
company-domain emails, **156 real net salaries (EGP 2,500-95,500)**, 691 salary records, and real
doctor/pharmacy names across 116k CRM visits and 148k customer-directory rows. It was anonymised so
an external videographer could screen-record an announcement video.

**Do NOT read staging data as real any more, and do not "reconcile" it against production** - every
figure will disagree by design.

What was changed:

- **Identities**: every person, doctor, pharmacy, candidate and distributor replaced via a
  deterministic map, so one real person is the same fake person in every table. The map is
  `mock_backup.person_map`; generators are `mock_backup.fake_person/_ar/fake_customer/fake_pharmacy/
  fake_address/fake_distributor`.
- **Money**: salaries regenerated by job band (basic = 70% of base, per the app's own rate);
  `salary_records` rebased by a per-row factor that preserves each payslip's arithmetic; every
  Source-of-Sales figure scaled by a uniform **1.1735**.
- **Achievement**: `au.monthly_targets` + `au.monthly_attribution_rollup` rebuilt for 2026-01..2026-08
  across all three lines, every row floored at **84%** (owner's requirement for the video).
- **Wiped**: `audit_logs` old/new JSON, `ireports360_visits.raw_payload` and comments,
  notification/email recipients and subjects.

**Originals are in the `mock_backup` schema** (employees, salary_records, ats_candidates, offers,
users, app_auth_users, monthly_targets, attribution rollup + meta). The bulk CRM/SoS tables were NOT
backed up - restoring those means re-cloning from production.

**Two traps if you touch this again.** `phx_monthly_achievement` silently falls through to
`f_monthly_achievement_live` unless `au.monthly_attribution_rollup_meta.config_fp` equals
`au.f_attribution_config_fingerprint()` - so any org-config change (seats, occupancy, line_area_map)
invalidates the stamp and the mocked numbers vanish behind live computation. **Re-stamp last, after
org edits.** And `salary_records` is guarded by `phx_prevent_closed_salary_detail_mutation()`, which
blocks writes to approved payroll batches - disable the user triggers around the write and re-enable
them immediately.

**HOW TO LOG IN AFTER THE SCRUB.** Login is `public.app_auth_users.login_id`, NOT `auth.users` -
`auth.users` holds only 22 rows (mostly RLS test fixtures) while the app's own table holds 139+, so
checking `auth.users` for an account and finding nothing proves nothing. **All 139 login ids were
rewritten**: they were bare usernames before and are now `firstname.lastname@satopharma.com` built
from the *mocked* name, mapped in `mock_backup.login_map` (old -> new). So the owner's own login is
now **`heba.badr@satopharma.com`** (`B-10`, Super Admin) - his previous username no longer exists.
**`admin-HR` (`PHX-1`) was NOT remapped** and is the one guaranteed-unchanged way in.
**No password was ever changed** - verified by comparing `password_hash` against
`mock_backup.app_auth_users`, identical for every account - so old passwords still work. Never read
or set these hashes; set a password through the app's user management instead.

Video account: `khaled.sorour@satopharma.com` - District Manager, Anti Infective, Cairo (`AI-0001`),
`is_active`, `force_password_reset = false` (re-verified 2026-08-28 - so signing in will NOT
interrupt a recording with a change-password prompt). The three reps added below have employee
records but **no login row** - they are there to populate the DM's team, not to be signed in as.

**The DM was renamed 2026-08-28 - he was `Mohamed Nagy` until the owner caught it** ("nagy is
pedia"). See [[a-mock-name-generator-reproduces-real-employee-names]] for the sweep that found the
other four and the `auth.users` hole it exposed. Five employees were renamed in total: `AI-0001`
Mohamed Nagy -> **Khaled Sorour**, `B-126` Ibrahim Tawfik -> Omar Wahba, `B-134` Aya Ibrahim ->
Nourhan Sorour, `B-180` Heba Shalaby -> Shaimaa Fouad, `B-183` Mohamed Kamal -> Youssef Wahba. The
mapping is kept in `mock_backup.name_fix_20260828`. Achievement was unaffected (Anti-Infective
100.7% / CNS 100.8% / Pedia 100.1%, floor 84.0%) and the fingerprint stayed valid on all 8 periods -
a rename does not touch `au.line_area_map`, unlike a hire.

**The Cairo Anti-Infective team was completed on 2026-08-28 at the owner's explicit instruction**
("fill the three vacant Cairo rep seats"). Three invented reps were hired into the three vacant
areas - `AI-0005` Ibrahim Mahmoud (CA1 Heliopolis), `AI-0006` Sameh Bakr (CA2 Nasr City), `AI-0007`
Nada El Deeb (CA6 Cairo West), all `hire_date` 2026-07-14, seated from 2026-07-14. Cairo is now the
only fully-staffed Anti-Infective district; **the line's NSM seat, both the Giza and Others DM seats,
and 11 rep seats elsewhere are still vacant and were deliberately NOT filled** - that is the real
organogram, per [[never-change-the-organogram-skeleton]]. Filling seats did not move a single
achievement figure (attribution is per AREA, not per person) - July still reads Anti-Infective
100.7% / Cairo 102.5% / floor 84.0%. The mechanism trap it exposed is in
[[an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing]].

**THE VIDEO ACCOUNT CHANGED 2026-08-28 - it is now `sherif.wahba@satopharma.com` (`B-76`), District
Sales Manager, Anti Infective, region D2 "Delta"**, seat `SEAT-AIF-DM-D2`, reporting to `AA`. His
four active reps are `B-40` Mariam El Deeb (D21 Dakahlia 1), `B-108` Nourhan Ibrahim (D22 Dakahlia
2), `B-96` Sara Labib (D23 Dakahlia 3), `B-15` Mariam Tawfik (D26 Port said - Domiat); D24 Sharkia 1
is a vacant seat that still carries sales. The earlier `AI-0001` Cairo account is superseded.

**WHY HIS DASHBOARD READ ALL ZEROS, and the fix.** Team size 0, sales 0, target 0, achievement 0%,
"No sales data synced for the current period yet" - with the data sitting right there
(`phx_monthly_achievement('2026-07')` returned 5 rep seats and ~2.15M actual for his DM seat, and
the fingerprint was valid on all 8 periods). **The org seats were fine and the rollup was fine. The
gate is `monthly_closing_publications`.** Every manager keycard reads only periods whose *line-scoped
Monthly Closing is PUBLISHED* - `loadPublishedPeriodKeys` in `src/lib/sales/vs-target.ts` keys on
`resolveTargetLineCode(line)||'|'||period`, and `activePeriodsOf` drops everything else. Staging held
exactly **one** publication row, `2026-05 / CNS`, which is *below* `SALES_VS_TARGET_FLOOR` (`2026-07`)
- so nothing in the window was published and every manager dashboard in staging was blank. Fixed by
inserting `2026-07` rows for Anti Infective / CNS / Pedia directly into that table (bypassing
`publishClosing`, so no notification or email fires). **August was deliberately NOT published** - the
closing golden rule forbids releasing a month during that month, and `closing-period-gate.ts` throws.
`loadPublishedPeriodKeys` is **not** cached (only `loadVsTargetRange` is, 3600s), so the change shows
on the next reload. **A blank manager keycard in staging is almost always this, not broken data.**

**Plans were seeded 2026-08-28** (`employee_plan_headers` + `_items`, previously **0** rows for the
whole team): 3 weeks x 4 reps = 12 rep plans (W33 `hr_acknowledged`, W34 `manager_approved`, W35
`submitted` so B-76 has live approvals waiting), plus B-76's own 3 (W33/W34 approved, W35 `draft`),
6 activities each. The app's week is **Sat-Thu**; W33 = 08-15..08-20, W34 = 08-22..08-27, W35 =
08-29..09-03.

**The jsonb gap.** The original scrub scanned only `text`/`varchar`, so **no json column was ever
scanned**. Found and fixed: `employee_plan_headers.manager_name` + `hierarchy_snapshot` (real
managers, incl. the CEO), `deduction_candidates.hierarchy_snapshot`, `notification_events.metadata`
(1,456 rows of prose - "X approved your weekly plan"), `notification_deliveries.metadata`,
`ats_cv_intake_events.raw_metadata`, `field_workforce_compliance_live_snapshots.preview`
(15 MB) + `employee_rollup`, `admin_cleanup_events.old_values`, `automated_payroll_audit.detail`,
`field_workforce_compliance_imports.diagnostics`, `outstation_expense_requests.car_evidence_metadata`.
`email_delivery_events.raw_event` (5,130 rows) was blanked to `{}` the way the app's own retention
sanitiser does it (`src/lib/notifications/email.ts`). Already-clean: `audit_logs` (0 at leaf level),
`ireports360_visits`/`_checkins.raw_payload` and `source_of_sales_import_rows.raw_row` (all `{}`),
`weekly_sales_rows.raw_row` (depot/product only, no person names). All sweeps end at **0**.
Tooling left behind in `mock_backup`: `name_map_final` (666 real->fake pairs, the canonical map),
`name_pattern_tbl`, `scrub_prose2(text)` (prose, regex baked in as a literal so it compiles once -
the variable-pattern version was ~100x slower and timed out) and `scrub_jsonb(jsonb)` (leaf
exact-match, for blobs too big to regex). See
[[a-mock-name-generator-reproduces-real-employee-names]] for the collision traps in that map.

## RE-CLONED FROM PRODUCTION — 2026-08-29

The reversal above left residue the `mock_backup` restore could not reach (log and derived tables
still carried scrubbed names, 3 raw payloads were gone). The owner's answer was **"re-clone
production into staging"**, and that is what staging now is: a full physical clone of production
`ozucdzovmcqvepbozvqf` taken 2026-08-29 ~08:00 UTC, loaded into `cifwmndunmlxjhyjugxa`.

**Staging is therefore REAL PRODUCTION DATA, not a demo.** It holds production's **161 real
`auth.users` rows including password hashes**, all 179 employees, 796 salary records and 11,267
sales records. Cloning `auth` was not optional — staging's own 25 accounts had **zero id overlap**
with production, so without it every `employees` row would point at a user that does not exist.
The consequence is that **staging must not be handed to a videographer or any third party** in this
state, and logging in there now needs production credentials. This is the exact opposite of the
posture the mock exercise was trying to create — see [[a-mock-name-generator-reproduces-real-employee-names]].

**How it was done** (scripts under the session scratchpad, not in the repo): native `pg_dump`
reproducing Supabase's own flag set, because `supabase db dump` needs Docker and Docker Desktop was
not running. Two traps worth keeping:

- **Supabase's dump splits `auth`/`storage` asymmetrically** — the SCHEMA dump excludes them
  (platform-managed) while the DATA dump includes them. A clone that copies the schema exclusion
  list into the data step silently ships an empty `auth`.
- **`drop schema public cascade` exhausts `max_locks_per_transaction` (64) at ~368 tables** —
  `out of shared memory`. The reset has to batch `COMMIT`s inside DO blocks, which means the restore
  must NOT run under `--single-transaction`.
- **`storage.buckets_vectors` / `storage.vector_indexes` cannot be truncated** by this role
  (`permission denied`). Both are empty on production, verified live, so skipping them is lossless —
  guard the truncate with `has_table_privilege(..., 'TRUNCATE')`.
- **The migration ledger is excluded from BOTH dumps.** `supabase_migrations.schema_migrations` had
  to be dumped and loaded separately (775 rows). Without it staging's ledger is empty and the next
  `db push` tries to replay every migration.

**What a clone CANNOT carry: storage FILES.** Production holds **910 objects / ~285 MB** (736
recruitment CVs, 86 outstation evidence, 68 marketing evidence, 9 employee photos). The `storage.objects`
metadata rows clone perfectly, so staging lists all 910 and serves none — every CV download and
photo **404s**. Copying the bytes is a separate job through the storage API.

**Verified after the load** — 477/477 COPY blocks, 0 errors, and structure identical to production:
350 public tables, 16 `au`, 30 views, 288 functions, 395 policies, 78 triggers, 1379 indexes.
Row counts matched everywhere except continuously-written tables (`ireports360_*`, `audit_logs`,
`activity_events`, `app_sessions`, auth sessions), where staging is behind by the ~30 minutes
between the dump and the check — that is drift, not loss. `ireports360_sync_notify=false` was
re-applied afterwards, since a clone overwrites it with production's `true`.
