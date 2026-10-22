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

The table's check constraint refuses a retirement without a date.

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
6. **Retire vendor sync** (announce first):

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
