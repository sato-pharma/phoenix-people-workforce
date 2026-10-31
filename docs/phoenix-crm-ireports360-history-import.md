# Phoenix CRM — the iReports360 visit history import (2026-10-29)

Owner, 2026-10-29: *"I want to grab every rep now current in the company working. I want to grab his visit
history and put it in Phoenix CRM and make it as if it is a complete data… Not a shift… grab the business."*

Every current Medical Rep's 2026 iReports360 visits are copied into `phoenix_crm_visits` as real visit rows,
so the customer timeline, Visit Report, KPIs, Frequency and the calendar reports show his whole year. Nothing
that judges, alarms or pays reads them.

Closing the iReports360 API is a separate step. It happens later, on his word, after the Delta (2) training,
and is not part of this import.

| Piece | Where |
| --- | --- |
| The marks, the source map, the triggers, the two SQL readers, the view column, the copy function | `supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql` |
| The contact refresh skips an imported customer | `supabase/migrations/20261029212300_the_contact_refresh_skips_imported_customers.sql` |
| The countable view skips the copy at its root; the history view and the four report functions keep it | `supabase/migrations/20261031160000_phoenix_crm_countable_visits_skip_imported_history.sql` |
| The indexes for the copy function's lowercased rep ids: old visits, seat occupancy, the double-visit partner. A one-seat plan is index scans only; the largest seat's source query (2,345 visits) runs in 224 ms | `supabase/migrations/20261031170000_phoenix_crm_import_history_indexes.sql` |
| The runner (dry run, then one seat per transaction) | `scripts/phoenix-crm-import-ireports360-history.ts` |
| The pins | `tests/phoenix-crm-imported-history.test.ts` |

## Scope

- **Who:** every active employee on a current `-REP-` seat whose team has started on Phoenix.
- **Which visits:** his iReports360 regular and campaign visits from 1 January 2026 up to the day before his
  team's start date. Anything on or after that date was entered in Phoenix itself and is not copied.
- **Size:** the production dry run of 2026-10-30, 00:07 Cairo: 69,127 visits on 58 seats. Two visits to one
  customer on one day become one row, so 69,046 rows are written (81 merged). It adds 2,493 Archive doctors and
  1,027 campaign-visit holders. Mostafa Saied's 55 doctors seen only on the Anti-Infective seat are not added,
  because those visits are not copied.

## The rules of the copy (owner, 2026-10-29)

- **A regular visit is a planned visit. A campaign visit is an unplanned visit** (*"You will treat the
  regular visit as the planned visit, and the campaign visit as the unplanned visits."*).
  - A campaign visit is `unplanned_kind = 'out_of_list'`, because it names no doctor. It counts with no
    approval queue and opens no request.
- **Each row has the admin shape.** That means:
  - `capture_source = 'admin'`, the only shape the table allows with no GPS and no products;
  - `location_flag = 'no_place'` and `products = '{}'`;
  - the old note goes in `comment`;
  - the rep is both `rep_hr_id` and `entered_by_hr_id`.
- **The visit time** comes from the old visit and is stored as `captured_at`. iReports360 writes Cairo
  wall-clock time but labels it UTC, so the import uses the combined door's own conversion. If the time is
  missing, or falls on another day, the visit reads 12:00 Cairo.
- **A double visit keeps its partner.** A product manager goes in as `kind = 'product_manager'`; any other
  partner goes in as `kind = 'double'`.
- **The seat is the rep's current seat.** A visit he made on a different seat is not copied (*"donot add
  visits here or here"*).
  - Mostafa Saied's 1,259 visits on the Anti-Infective seat stay in the old history only.
  - A rep who held the same seat earlier keeps those visits.
  - A rep who had no seat yet keeps his campaign visits from the days before he joined; they go on his
    current seat.
- **Two old visits to one doctor on one day become one row,** because Phoenix allows one visit a day. The
  second visit's note is appended to the first, and both old ids map to the one row.
- **The doctor:** the seat's own customer for that doctor, matched by reference id first and then by own id,
  whatever that customer's status.
  - **A doctor Phoenix does not have goes to the rep's Archive** (*"Add to Archive"*). The import creates him
    as `dropped`, with archive reason `imported_history`, and he reads *"Visited in the old system, not on
    your Phoenix list"*. The active list does not change.
  - **A campaign visit names nobody.** It is filed under a numbered "Campaign visit N" holder on the seat: the
    Nth campaign visit of that day and list goes on holder N. A holder is `campaign_visit_holder = true`. It
    is never on the List, the Archive or the identity candidates, and it never reaches `crm_contacts`.

## The marks

| Column or table | Set on | Meaning |
| --- | --- | --- |
| `phoenix_crm_visits.imported_from_ireports360_at` | every copied visit | the time of the run that wrote it |
| `phoenix_crm_customers.imported_from_ireports360_at` | every Archive doctor and holder the import made | the same; **cleared when the rep restores the doctor from the Archive**, by the trigger `phoenix_crm_customers_clear_import_mark` |
| `phoenix_crm_customers.campaign_visit_holder` | every "Campaign visit N" holder | not a doctor |
| `phoenix_crm_imported_visit_sources` | one row per old `crm_visit_id` | the Phoenix visit it became; the idempotency key, so a second run writes nothing |

## Who skips it, and who keeps it

**`phoenix_crm_countable_visits` skips a copied visit at its root** (`20261031160000`). Every reader of
that view skips the copy without naming the mark, so a new reader that forgets it can never count the copy
as Phoenix work. Counting the history is the reader that has to ask for it by name:
`phoenix_crm_countable_visits_with_history` is the same view without that one filter, service role only.

- **What changed with the root filter:** the adoption board (`phoenix_crm_seat_visit_firsts`) no longer
  reads a copied January visit as the seat's first Phoenix visit.
- **What did not change:** the entry-days cache (`phoenix_crm_rep_entry_days_calc`), `crm_visits_unified` and
  `crm_checkins_unified` already started at the team's Phoenix start date, which no copied visit reaches.
- The view keeps its `imported_from_ireports360_at` column, always null now, because a view cannot lose one.

**The readers that also skip it by the mark** — each read the raw table or was written before the root
filter, and each keeps its own skip:

- `loadPhoenixWorkEvidenceDays`, which feeds deductions, Field Workforce Compliance and the calendar. Those
  days already belong to the iReports360 door, and a copied row would credit a partner the old system never
  named.
- The first-visit gate (`isFirstVisitSubmittedBy`) and the third-visit rule in `saveVisit`.
- The roster and cadence sweep (`runRosterAndCadence`).
- Ranks: `readVisits`, `readFieldSaves`, and `readFirstVisitDayOf`, so owed days start at the first real
  Phoenix visit.
- The exceptions board (`loadVisitTallies`, which reads the countable view's new column).
- The visit-lifecycle detector, in both of its visit reads.
- The 06:55 digest (`phoenix_crm_seats_with_activity`).

**A customer the import made opens no territory and is not part of the list the rep built:**

- `loadSeatLists` (team readiness);
- `capacityLists` (insight reports);
- the contact refresh's customers snapshot (`20261029212300`).

**A holder is on no screen:**

- `loadTerritoryCustomers` (the List and the Archive);
- `phoenixCrmCandidates` (customer identity);
- the name-row trigger.

**The List's "N visits in iReports360" line** (`phx_crm_contact_visit_history`) never counts an old visit
already copied, so no visit is counted twice.

**The history screens keep every copied row.** That covers the customer timeline, the Visit Report, KPIs,
Frequency and the tracking sheet (`server/reports.ts`), and the calendar reports. Copying the history so it
shows there is the whole point of the import. The test refuses the mark in `reports.ts`.

- The screens that read the raw table keep it as they always did.
- The screens that read the countable rule read `phoenix_crm_countable_visits_with_history`: `reports.ts`,
  `team-calendar.ts`, `week-progress.ts`, `list.ts`, `my-map.ts`, `double-visit-plans.ts`,
  `insight-reports.ts`, `manager-customer-marks.ts`, `manager-plan-report.ts` and
  `manager-visit-details.ts`.
- So do the four report functions: `phoenix_crm_report_brick_coverage`, `phoenix_crm_report_coverage`,
  `phoenix_crm_report_manager_visits` and `phoenix_crm_report_visits_by_day`.
- `tests/phoenix-crm-imported-history.test.ts` pins all of it: the countable view ends with the filter, the
  history view equals it without that filter, and the four functions read the history view.

`phoenix_crm_contact_truth_calc` is not touched. It reads only validated customers, and nothing the import
writes is validated.

## How to run it

```powershell
node --env-file-if-exists=.env.production.rls.local --experimental-strip-types scripts/phoenix-crm-import-ireports360-history.ts
```

- **The dry run is the default.** It asks the function for every seat at once, writes nothing, and saves
  `dry-run-<Cairo time>.json` to `F:\PHX backup\phoenix-crm-ireports360-history-20261029\`. Every run writes
  files of its own; an earlier run's record is never overwritten.
- **`--apply` is a bulk production write.** Announce it in plain words first: production has no PITR. It
  works like this:
  1. it runs the dry run again, for the list of seats;
  2. it takes one seat per transaction, on one snapshot: it plans the seat, writes it, and compares the
     written count with the planned count (rows to write, less the ones that collide with a visit already in
     Phoenix);
  3. a seat whose counts differ is rolled back inside its own transaction, and the run stops there; every
     seat before it stays written;
  4. `applied-<Cairo time>.json` keeps every seat's answer.
- `--apply` takes no value: `--apply=false` is refused, never read as an apply.
- `--seat=<seat id>` limits the run to one seat; a bare `--seat` or `--out` is refused.
- The function itself refuses an apply that names no seat (`phoenix_crm:import_needs_a_seat`).
- Each call lifts the pooler's statement timeout to 15 minutes for its own transaction only.

## Checks after the apply

- On every seat, the written count equals the planned count.
- A second `--apply` writes 0.
- These are unchanged from before the apply:
  - `crm_visits_unified` counts per rep and month;
  - the entry-days cache;
  - the pending unplanned queue;
  - notifications and outbox rows;
  - Phoenix proven-worked days for September and October.
- For three reps on different teams, September shows in the Visit Report and on the customer timeline, and
  the List's old-system line no longer counts those visits.

## Rollback

Production has no PITR. The copy is removed by its marks, never by a restore:

```sql
delete from public.phoenix_crm_visits where imported_from_ireports360_at is not null;
delete from public.phoenix_crm_customers c where c.imported_from_ireports360_at is not null
  and not exists (select 1 from public.phoenix_crm_visits v where v.customer_id = c.id);
```

The source map's rows go with their visits, through the foreign key. To roll the schema back, follow the
`ROLLBACK:` header of each migration, newest first. The view keeps its appended column, because a view
cannot lose one.
