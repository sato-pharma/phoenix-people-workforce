# CRM cutover runbook — iReports360 to Phoenix

CRM phase 5. The switch from the iReports360 mirror to Phoenix's own visits and plans, for everyone
on one date (owner decision 17), after the one-week Pedia pilot.

**Everything in the code is dormant until step 4.** The migration
`supabase/migrations/20260913230000_crm_cutover.sql` seeds `public.crm_cutover` with no date, and
while the date is null every unified view returns exactly the vendor rows it returned before.

Every step below that writes production is **announced in plain words first, and needs the owner's
explicit go for that step**. None is pre-approved by merging this code. Production has no
point-in-time recovery; the 7 daily backups are the whole recovery story.

## What the code does once each field is set

| Setting | Effect |
| --- | --- |
| `cutover_date` null | Nothing changes. Vendor rows only, everywhere. |
| `cutover_date` set | Every CRM read (visits, check-ins, plan boards, rep doctor lists, rep day, reps list, Visits Report, FWC, probation double visits, deductions) serves vendor rows **before** the date and Phoenix rows **on and after** it — never both for one day. The rep day stops asking the live vendor for days on or after the date. The CRM no-activity deduction is not charged for the calendar month the date falls in (decision 18), and the collection result says so. |
| `vendor_sync_retired_at` set | The live poller's tick stands down whole (no pulls, no pings). The four cron routes answer `200 {skipped: true, reason: "vendor_sync_retired"}` before their dead-man's switch. The Visits Report backfill, the rep doctor lists Refresh and plan verification answer 409 with a plain message; the Early Birds Sync button is no longer shown, and the admin CRM sync panel says iReports360 was retired on that date and hides its backfill. The heartbeat sweep stops watching the four vendor jobs, reconciliation check 10 (sync freshness) holds, the FWC live snapshot stops warning it is stale, and the first-visit board stops waiting for a vendor sync. The housekeeping timer takes over the probation double-visit capture every 6 hours, and Phoenix double visits (negative ids) are captured. It also takes over the contact master refresh (`crm_contact_master_refresh`) — every 15 minutes, with the visit-and-plan pass once per Cairo day — because its only other callers were the poller and the doctor-lists cron, and without it a doctor a rep adds in Phoenix would never reach the master (re-audit, 2026-10-22). |

A retirement no longer needs a date (`20261031150000_crm_cutover_retire_without_date.sql` dropped
`crm_cutover_retire_needs_date`). With `cutover_date` null, `vendor_sync_retired_at` does everything in
the row above and nothing else: no read moves, no month is waived, no KPI rule changes.

## Closing iReports360 when every team started on its own date

The single global date was overtaken: since 3 October 2026 each team moves on its own Phoenix start
(`phoenix_crm_team_starts`, set on Admin → CRM, always a Saturday). Closing the vendor API then
needs **no cutover date** — steps 2 to 5 below are skipped, and the date (with decision 18's waived
month, the KPI rule switch and vacation-day requests) stays a separate decision of the owner's.

1. **Nobody is still counted from iReports360.** This must return no row:

   ```sql
   select agent_hr_id, agent_name, count(*), max(visit_date)
     from public.crm_visits_unified
    where source = 'ireports360' and visit_date >= current_date - 14
    group by 1, 2;
   ```

   On 31 October 2026 it returned 36 active people (1,732 visits since 18 October). 9 had no Phoenix
   visit at all (4 medical reps, 3 district managers, 2 national sales managers). The other 27 record in
   Phoenix too, but still had 135 person-days recorded only in iReports360: Phoenix wins a day only when
   it has an entry, and district managers keep both apps by the owner's rule. Closing while anyone still
   records a day only in iReports360 leaves that day empty, and CRM no-activity is charged on it. The
   Delta (2) training (Thursday 5 November 2026) is what moves the last of them.
2. **Their last vendor days are pulled.** After the last day anyone recorded in iReports360, wait for one
   rolling sync that covers it (the poller's 10-day pull), so no visit saved there is left behind.
3. **Retire vendor sync** — step 6 below, with `cutover_date` left null (announce first).
4. Steps 7 to 9 below: cron-job.org, Healthchecks, secrets.

### Done — iReports360 retired on Friday 6 November 2026, 03:16 Cairo

Owner, 6 November 2026, after the last reps' training: *"no more accepted visits or records on old crm … take all
its data and close and retire its api and any relatings to the old crm."* Read on production `ozucdzovmcqvepbozvqf`:

- **The last pull, just before the switch:** the 10-day visits sync fetched and upserted 437 visits and 614
  check-ins (0 deleted); the plan sync pulled 314 entries for 1 November to 13 December (0 pruned); the parity
  sweep of 28 October to 6 November read **318 = 318, equal**. All 11 parity windows from 1 January are equal
  except 31 January to 1 March, where the mirror holds 338 rows MORE than the vendor still returns — nothing is
  missing there. The mirror holds 144,524 visits, 1 January to 5 November 2026. The history copy's dry run: 66,954
  visits in scope, all already copied into `phoenix_crm_visits`, 0 to write.
- **Still recording there at the switch** (own entries, 24 October onwards): Salim Gomaa, district manager, no Phoenix
  entry since 7 October, last old-CRM entry Thursday 5 November 14:26; Nermeen Salah, district manager, meeting and
  training days only, last saved Friday 6 November 01:03. Both are in the mirror. Anything either enters there
  from now on is not read — the owner's ruling.
- **The switch:** `vendor_sync_retired_at` = 2026-11-06 03:16:26 Cairo, `cutover_date` still null, so no month is
  waived and no KPI rule moved. No sync run started after it; the last vendor row was synced at 03:14:40.
- **cron-job.org:** `phoenix-crm-contact-lists` (8344730) switched off and read back off; the four iReports360 jobs
  (8200910, 8200916, 8200918, 8203342) were already off.
- **Healthchecks.io:** `phoenix-crm-contact-lists`, `phoenix-ireports360-live-poll`, `phoenix-ireports360-sync` and
  `phoenix-reconcile-visits` paused and read back paused; `phoenix-ireports360-live-sync` does not exist.
- **Secrets:** the four `IREPORTS360_*` names (`BASE_URL`, `USERNAME`, `PASSWORD`, `TIMEOUT_MS`) were on GitHub
  and on the Railway services `phoenix-people-workforce` and `phoenix-workforce-worker`. Removing them is a
  secret-store write the session's classifier refuses, so it is the owner's own step. `PHOENIX_LIVE_CRM_POLL` stays.
- **The code:** the vendor sync engine, the poller, the vendor cron routes, the scraper and their tests leave in
  the same PR as this record — on the owner's word, not after the month step 10 below once asked for. Gone: every
  call to the vendor (the HTTP client, its credentials check, the visits, plan, contact-list and parity syncs, the
  live poller, the rep-day live fetch), the four vendor cron routes, the four vendor buttons (the CRM hub's
  backfill, the Early Birds Sync, the rep-doctor-lists sync, the plan Verify that wrote into the vendor), the
  Team tab's old-CRM week approval, the holdouts tab, and the vendor jobs in the schedule, heartbeat, cron-control,
  Healthchecks and cron-job.org declarations. Every stored row stays and every report keeps reading it.
- **Rewired, not closed** (owner, 6 November 2026: *"do not close early birds just make it grab its data from phx
  crm .. phx crm replaced the old crm so any module was wired with old crm must wire with phx crm"*): Early Birds
  already scored from Phoenix CRM through the read door (a day with a Phoenix visit takes that visit's time,
  2 October 2026), so only its vendor Sync button went. The plan verification board's button, which only ever
  wrote into iReports360, now approves a sent Phoenix CRM week through Phoenix's own plan decision
  (`/api/phoenix-crm/plans/decide`); old-CRM plans on that board are history in words. The CRM housekeeping timer
  (contact master, probation double visits) now runs unconditionally, because with the poller gone it is the only
  caller of both. Measured before the change: no database view or function reads the vendor tables except the
  three combined views, the contact master, the history copy and one identity lookup.

#### The live poller's rules, retired with it

Moved here verbatim from `.claude/rules/crm-sync.md` when the code they governed was deleted, so the account
outlives the code:

- 🔴 **THE POLLER REMEMBERS ITS LAST ROLLING SYNC AND WEEKLY RECONCILE BY READING DEEP RUNS ONLY (`readDeepRunMarkers`, `date_from` at least 9 days back) — NEVER "THE NEWEST 200 SUCCESSFUL ROWS" OF `ireports360_visits_sync_runs`.** The live poll writes a small row per probe (20-44 an hour from 10:00 Cairo on 11 Oct 2026), so by a 17:35 deploy that Sunday the 04:00 reconcile was 231 rows back, the marker came back null and the 30-day reconcile ran again, digest included. It only shows on a Sunday after 04:00 because the reconcile is due on no other day. Pinned by the 231-probe-row block of `tests/crm-live-poller.test.ts`, whose fake applies the filters it is given.
- 🔴 **A RESTART MARKER THE POLLER COULD NOT READ HOLDS THE JOBS IT TIMES, AND IS READ AGAIN EVERY TICK — FOR 30 MINUTES AT MOST, THEN THEY RUN WITHOUT IT AS BEFORE** (19 Oct 2026, 15:21 Cairo: one marker read timed out in a database burst, a 6.5 ms query, and the first due tick would have re-run the 10-day sync it had just run; on a Sunday afternoon, the 30-day reconcile). `seedMarkers` and `nextSeedHold` in `src/lib/crm/live-poller.ts`; three groups, each its own hold: the deep runs (rolling sync and reconcile), the plan sync and the parity sweep. `resolveDueScheduledWork` takes `held`; the live poll and the contact lists are never held. A failure is a `logWarning` while held and ONE error row when the hold gives up (`SEED_HOLD_MAX_MS`), never sooner — never lengthen it, the rolling sync feeds payroll attendance. Pinned by the last block of `tests/crm-live-poller.test.ts`.
- 🔴 **NO RECONCILE OR PRUNE DELETES A ROW AN OVERLAPPING SYNC WROTE** (audit F-07/S-SAL-01, 2026-10-23). Visits, check-ins and the weekly and monthly plan prune all judge stale rows through `staleReconcileIds` (`src/lib/crm/reconcile-guard.ts`): unseen by this fetch AND synced before this run began, compared as instants. The plan prune also records every row it removes in a required `crm_plan_sync` audit row before the delete, and deletes nothing it could not record.
- 🔴 **ONE POLLER ACROSS EVERY PROCESS — EACH TICK CLAIMS THE `crm-live-poll` LEASE IN `public.job_leases` FIRST, AND STANDS BY WHILE ANOTHER LIVE PROCESS HOLDS IT** (23 Oct 2026 audit, P5-05). A heartbeat renews it every minute (ttl 180 s), so a long deep run never lets it lapse and a dead holder is replaced within three minutes. It FAILS OPEN: until `20261023140000_job_leases.sql` is applied, or whenever `claim_job_lease` cannot be read, every claim answers "held" — today's behaviour, said once in the log (`job_lease_unavailable`). Never make an unreadable lease stop the poller. `src/lib/platform/job-lease.ts`; pinned by `tests/job-lease.test.ts`.
- 🔴 **THE PARITY SWEEP'S "MIRROR" IS `ireports360_visits`, READ DIRECTLY — NEVER `queryVisits`, WHICH SCANS `crm_visits_unified` AND COUNTS EVERY PHOENIX-BORN VISIT AS A ROW THE VENDOR LOST** (23 Oct 2026). The newest window was refused at 4,779 extra of 12,116 — 4,780 of them Phoenix rows, first one 3 Oct, growing ~300 a day — so it could never be verified again and 8 real late saves went unwritten; nothing was ever at risk of deletion, because the repair path only ever touches the mirror table. `loadMirrorVisitIds` in `src/lib/crm/parity.ts`, keyset by `crm_visit_id`. Account: `docs/crm-parity-sweep-mirror-only.md`, which also holds the one window still legitimately refused.


### The read side — Phoenix CRM is the one source of field work (7 November 2026)

Owner, 6 November 2026: *"any single source of field work is now the Phoenix CRM, wire it everywhere"*, with his
answers that day: count every team from 6 November; keep the old-app visits and show them in Phoenix; replace
"campaign" with unplanned visits; and a manager's visits count to him both ways — the double visit a rep submits
with him on it, and a single visit he submits himself.

Retiring the vendor stopped the writes; this stopped the reads. Before it, the three combined views still served
3,611 stored iReports360 visits by 42 people on 450 person-days after their own team's start, and several readers
asked the vendor tables alone, so they would have gone quietly to zero.

- **The doors** (`20261106235920`): `crm_visits_unified`, `crm_checkins_unified` and `crm_plan_entries_unified`
  serve the iReports360 branch only before `vendor_sync_retired_at::date`, and every seat from Phoenix from that
  day, started team or not. Before each team's start the archive stands exactly as it was.
- **Nothing lost:** the old-app days after each team's start were copied into Phoenix as history (the after-start
  mode of `phoenix_crm_import_ireports360_history`), stamped `imported_from_ireports360_at` so no figure counts
  them twice — Phoenix's own timeline, Visit Report and calendar show them.
- **Leave** from the retirement is HR's approved vacation requests (`src/lib/crm/hr-leave-days.ts`), so a leave day
  reads AV on Field Workforce Compliance and never as no activity; vendor code −4 answers archive days only.
- **Unplanned replaces campaign:** a Phoenix visit with `is_unplanned`, or vendor −8 on an archive day. The
  outstation trip allows at most 2 unplanned visits; the Business Review reads Planned and Unplanned.
- **A manager's own visits** count on the outstation trip (beside the double visits his reps submitted), in the
  attendance day maps and as worked days on Field Workforce Compliance. The chain-visit ruling of 8 October is
  unchanged.
- **Check-ins:** Phoenix visit positions are check-ins for every reader above the rep — the trip workload on an
  approver's view and the Employee 360 GPS module — never on the rep's own payload.
- **Paging:** the Phoenix work-evidence loader reads every page, so proven-worked days are not cut at 1,000 rows.
- **The outstation stamp** writes `workload_source = 'phoenix_crm'` (`20261107010725` widened the check); rows
  stamped `ireports360` keep it.
- **Retired with it:** the iReports360 account-setup alert and its reminder, the CRM Integrity page (now a pointer),
  reconciliation check 9, and the dead `ireports360_*` event names. The company activity report's CRM channel means
  holding a Phoenix seat. The manager plan board reads an old-CRM week only for weeks before the retirement.
- **Words:** the portal sidebar's "iReports 360" section is **Field Work**, and every field-visit screen names
  Phoenix CRM as its source, with the iReports360 archive before each team's start.

Deliberately unchanged: past months' archive; `cutover_date` stays null (a money decision that is his); the dated
contact register; the vendor resolution tables; leaver CRM-id lookups on the frozen mirror; the vendor tables
themselves; the half-day deduction (it already counts Phoenix positions — adding check-ins would double them);
Early Birds (Phoenix days already use the visit clock); "Copy last month" (it prefers the previous Phoenix plan and
falls back to iReports360 only for a seat's first month).

## Who enters what from the cutover date

- **Every rep of every line** enters visits in Phoenix (My Visits → Log a visit). A regular (doctor)
  visit saves only for a doctor on the rep's list AND planned that very day in a week plan the manager
  verified; the form offers only those doctors.
- **A double visit** is entered by the rep, who names the district manager; the manager confirms it
  himself. It counts to both.
- **A district manager's single visit** (rare, owner 2026-09-14): he enters it himself, to a doctor
  on one of his reps' lists, naming nobody. The plan rule does not reach it, and he files no weekly
  plan of his own.
- **Doctor lists** (owner 2026-09-14): the rep asks for an add, a removal or a grade change (My Visits
  → My doctor list); his district manager approves or refuses. The SFE Manager and the Super Admin
  add, remove or regrade directly (Admin → Doctor List Changes). A change is in force only from the
  cutover date; before it the nightly iReports360 contact-list scrape still owns every list.
  Pharmacy lists are not edited in Phoenix for now.

## Migrations this depends on

Apply to production, in order, each with the owner's separate go, **before** the cutover date is set:
`20260913230000_crm_cutover`, `20260914000000_crm_unify_vendor_reads`,
`20260914010000_crm_native_visit_vacation_day_requests`, `20260914020000_crm_contact_list_changes`.
Check `pg_class`/`pg_proc` for each object, never the migration ledger alone.

## The steps

1. **Run the Pedia pilot** (19–24 September 2026) and have the owner accept it.
2. **The owner names the cutover date.** Ask whether it must be the 1st of a month: a mid-month date
   makes that month mixed (half vendor, half Phoenix) in every KPI. The date must be set **before that
   month is ever collected for deductions**.
3. **Final full parity pull.** The last vendor pull covering every day before the date, then a parity
   check of that window. Nothing after the date is ever read from the vendor again.
4. **Set the date** (announce first):

   ```sql
   update public.crm_cutover
      set cutover_date = 'YYYY-MM-DD', note = 'Cutover — owner decision 17', updated_by = '<who>', updated_at = now()
    where id;
   ```

   Every process picks it up within a minute (the setting is cached for 60 seconds).
5. **Verify.** For the day before the date, `crm_visits_unified` equals `ireports360_visits`; for the
   date, it holds only `source = 'phoenix'` rows. Repeat for check-ins and plan entries. Open the
   Visits Report, the plan board and one rep day on either side of the date. The **KPI series break**
   is the cutover month: any month-over-month figure crossing it compares two recording systems
   (`crmKpiSeriesBreak` / `monthRangeCrossesCrmSeriesBreak` in `src/lib/crm/cutover.ts`).
6. **Retire vendor sync** (announce first). It needs no date — see "Closing iReports360 when every
   team started on its own date" above:

   ```sql
   update public.crm_cutover set vendor_sync_retired_at = now(), updated_by = '<who>', updated_at = now() where id;
   ```

   Confirm in the worker logs that `[crm:housekeeping]` refreshed the contact master and captured probation
   double visits, and that the poller stopped pulling.
7. **cron-job.org.** Disable the one vendor job still enabled, the CRM contact lists job. The 4 OFF
   iReports360 jobs are already OFF by design; leave them OFF. The API allows 100 requests a day.
8. **Healthchecks.** The in-app heartbeat sweep already skips the jobs tagged vendor in
   `src/lib/observability/job-schedule.ts` once vendor sync is retired, so nothing pages from Phoenix.
   On Healthchecks.io itself, pause or delete the vendor checks (`phoenix-ireports360-sync`,
   `phoenix-reconcile-visits`, `phoenix-ireports360-live-sync`, `phoenix-ireports360-live-poll`,
   `phoenix-crm-contact-lists`) once the owner agrees.
9. **Secrets.** Remove `IREPORTS360_*` from GitHub first (it overwrites Railway), then confirm Railway
   no longer has them. **Keep `PHOENIX_LIVE_CRM_POLL`**: the guard it feeds
   (`resolveInProcessHostRefusal`, `live-poller.ts`) also gates the CRM housekeeping timer and the
   Early Birds close timer, so removing it stops probation double-visit capture and the Early Birds
   close. Rotate nothing else; `CRON_SECRET` stays.
10. **Follow-up deletion PR** — the vendor sync engine, the poller, the vendor cron routes, the
    scraper and their tests — only after a full month has run clean on Phoenix's own records.

## Rolling back

- **Undo a cutover without dropping anything** — every read returns to vendor rows within a minute:

  ```sql
  update public.crm_cutover set vendor_sync_retired_at = null, cutover_date = null,
    updated_by = '<who>', updated_at = now() where id;
  ```

  If vendor sync had been retired, turn the poller back on and re-run a parity pull for the gap.
- **Drop the objects** — roll the code back first, then run the rollback block at the bottom of the
  migration.

## Known gaps at cutover (not handled by this code)

- **`public.ireports360_visits_effective`** still reads the vendor table directly and does not see
  Phoenix rows. No application code reads it, so it is only a drop for the deletion PR.
  (`crm_contact_master_refresh` and `phx_crm_agent_crm_ids_for_hr_ids` read the unified views since
  `20260914000000`.)
- **Rep doctor lists** are rebuilt nightly from the vendor scrape until the cutover date. From the
  date, only Phoenix's doctor-list changes move them (see "Who enters what"); disable the scrape job
  at step 7 so a stale scrape never competes with them.
- **A rep with no CRM id** (a new hire after the cutover) has a null `agent_crm_id` and an
  `exclusion_crm_id` of -1 in the views. Check-in matching, the call rate, the KPIs board, rep doctor
  lists, the rep day, visit workload, visit partners, plan actuals, the reps weekly plans board and
  doctor coverage key him by his HR id instead. A double visit whose partner has no CRM id counts on a
  Phoenix row only (`source = 'phoenix'`); a vendor row's stray HR id never does. The Reps List
  activity column reads him by his HR id, and the shared-customer partners and check-in observers
  (location confidence, Phoenix insights) key him as `hr:<id>`. A list row that names a rep who has a
  CRM id by his HR id alone stays unnamed as a partner rather than risk the wrong name.
  `getAgentCrmIdentityRows` deliberately stays on the vendor table (it maps a leaver's historical CRM
  id), and the plan view has no `exclusion_crm_id` column.
- **Plans filed in Phoenix** appear on the plan boards with a negative plan id and read "Reviewed in
  Phoenix" there, with no verify button. They are verified on Phoenix's own plan review screen.
