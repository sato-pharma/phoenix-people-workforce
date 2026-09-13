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
| `vendor_sync_retired_at` set | The live poller's tick stands down whole (no pulls, no pings). The four cron routes answer `200 {skipped: true, reason: "vendor_sync_retired"}` before their dead-man's switch. The Early Birds Sync button, the Visits Report backfill, the rep doctor lists Refresh and plan verification answer 409 with a plain message. The housekeeping timer takes over the probation double-visit capture every 6 hours. |

The table's check constraint refuses a retirement without a date.

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

   Confirm in the Railway logs that `[crm:housekeeping]` captured probation double visits and that the
   poller stopped pulling.
7. **cron-job.org.** Disable the one vendor job still enabled, the CRM contact lists job. The 4 OFF
   iReports360 jobs are already OFF by design; leave them OFF. The API allows 100 requests a day.
8. **Healthchecks.** Delete the vendor checks (`phoenix-ireports360-sync`, `phoenix-reconcile-visits`,
   `phoenix-ireports360-live-sync`, `phoenix-ireports360-live-poll`, `phoenix-crm-contact-lists`) and
   their entries in `src/lib/observability/job-schedule.ts` once the
   owner agrees — retired jobs never ping, so they would page forever.
9. **Secrets.** Remove `IREPORTS360_*` and `PHOENIX_LIVE_CRM_POLL` from GitHub first (it overwrites
   Railway), then confirm Railway no longer has them. Rotate nothing else; `CRON_SECRET` stays.
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

- **Database objects that read the vendor tables directly** do not see Phoenix rows:
  `public.crm_contact_master_refresh`, `public.phx_crm_agent_crm_ids_for_hr_ids` and the view
  `public.ireports360_visits_effective`. CRM phase 6 (KPI unification) owns them.
- **Rep contact lists** come from the vendor scraper. Once it stops, someone must own adding and
  removing a rep's doctors in Phoenix.
- **A rep with no CRM id** (a new hire after the cutover) has a null `agent_crm_id` in the views.
  Reads that filter by CRM id, and the rep day, do not find him yet.
- **Plans filed in Phoenix** appear on the plan boards with a negative plan id. They are verified on
  Phoenix's own plan review screen; the iReports360 verify button answers 409 for them.
