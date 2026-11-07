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
| The review's fixes (2026-11-01): the copy's rules below, the entry-days trigger skips a copied visit, a copied visit's detail cannot be written up | `supabase/migrations/20261101101900_phoenix_crm_import_history_review_fixes.sql` |
| The second review's fixes (2026-11-01): the catch-all is left out, a partner is judged by the seat of the visit's day, his own customer beats an Archive copy, the links are indexed, two new counters | `supabase/migrations/20261101111500_phoenix_crm_import_history_second_review_fixes.sql` |
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
- **A double visit keeps its partner, judged as he was on the visit's day.**
  - In a manager's seat that day (district, acting district, regional or national): `kind = 'double'`, whatever
    he is now.
  - In only other seats that day, a rep's for example: no partner, and the visit is `single`, even if he was
    promoted since.
  - In no seat that day, which is where product and training managers always land because they hold none: his app
    role today (`app_auth_users.role`, an active login first, never a test persona), the same list the visit form
    offers. With no login, his job title stands in for the role. A product manager, group product manager or
    training manager, and the marketing manager on CNS, goes in as `kind = 'product_manager'`; a district,
    regional or national sales manager as `kind = 'double'`; anyone else is no partner.
  - **A partner named and not filed is counted**, in the totals' `partners_dropped`, for the rows still to write.
- **The seat is the rep's current seat.** A visit is copied only if he held this seat that day (*"donot add
  visits here or here"*).
  - Mostafa Saied's 1,259 visits on the Anti-Infective seat stay in the old history only, and so does a day he
    spent on a manager's seat.
  - A rep who held the same seat earlier keeps those visits.
  - A rep who held no seat at all that day keeps only his campaign visits; they go on his current seat.
- **Two old visits by one rep to one doctor on one day become one row,** because Phoenix allows one visit a
  day. The second visit's note is appended to the first, and both old ids map to the one row.
  - **Two reps on one seat who saw one doctor on one day are not merged.** The earlier visit is written. The
    later one stays unmapped and counted as a conflict, so the List's old-system line keeps counting it.
    A seat holds one open occupant today (the unique index `occupancy_open_span`, on production too), so one run
    cannot reach this; a rehearsal on staging reached it only with that index dropped inside the transaction.
  - **That line is read by the customer's reference id, so it does not cover a doctor found only through a
    link.** A visit left unmapped on him, for this reason or because a Phoenix visit already holds that day,
    shows on no screen. The totals' `conflicts_without_a_line` counts these, so a dry run says so first.
- **The doctor:** the seat's own customer for that doctor, matched by reference id first and then by a
  confirmed identity link (`customer_identity_links`), whatever that customer's status. A doctor the rep added
  himself has only a Phoenix-only id, so the link is the one thing that can name him. Production holds no such
  link yet (0 on 2026-11-01), so today this finds nobody extra.
  - **A doctor Phoenix does not have goes to the rep's Archive** (*"Add to Archive"*). The import creates him
    as `dropped`, with archive reason `imported_history`, and he reads *"Visited in the old system, not on
    your Phoenix list"*. The active list does not change.
  - **An Archive customer whose speciality is pharmacy is a pharmacy,** list type `Pharmacy`, whatever the
    assignment rows or the AM/PM majority say.
  - **A campaign visit names nobody.** It is filed under a numbered "Campaign visit N" holder on the seat: the
    Nth campaign visit of that day and list goes on holder N. A holder is `campaign_visit_holder = true`. It
    is never on the List, the Archive or the identity candidates, and it never reaches `crm_contacts`.
  - **The catch-all contact 100000 is left out of the copy.** It names nobody, its 2026 visits are all planned
    ones and not campaign visits, and every check-in, coverage or territory figure leaves it out.
- **A copied visit is history, so the rep cannot write it up.** `visitDetailEditable` and
  `phoenix_crm_edit_visit_detail` (`phoenix_crm:visit_is_history`) both refuse it: a pharmacy named on one would
  file an unmarked visit dated before his start.
- **A pharmacy the import put in the Archive is not one he dropped.** `loadListedPharmacies` leaves it out, so
  it never refuses Add a pharmacy and never leaves a named pharmacy unfiled. Restored, it loses the mark and is
  listed again. `loadSeatPharmacies` also skips a name typed on a copied visit, so the form never offers a
  pharmacy that only the old system knew.

**How these rules were run:** on 2026-11-01, on staging, inside a transaction that raised at the end, so nothing
stayed (staging read back with no fixture left and the index in place). The fixtures were 11 old visits on one
seat, among its real ones:

| Fixture | Result |
| --- | --- |
| Catch-all contact 100000 | not copied |
| Partner in a rep's seat that day, District Manager today | `single`, and `partners_dropped` 1 |
| Partner in a district manager's seat that day, a rep today | `double`, with him as the manager |
| Partner in no seat that day, District Manager today | `double` |
| Product manager, and the marketing manager on CNS | `product_manager` |
| Doctor with both an Archive copy and a confirmed link to the rep's own customer | filed on the rep's own customer |
| Two reps, one doctor with a reference id, one day | earlier visit copied; the later one unmapped and on the old-system line |
| Two reps, one doctor found through a link, one day | earlier visit copied; the later one unmapped, and `conflicts_without_a_line` 1 |

The same seat's dry run with 440 customers and 2,000 links took 1.4 seconds.

**What the rules above do not change:** the review's fixes of 2026-11-01 apply to the next run. The first run's
rows were read one by one with the owner, who chose what to repair on 2026-11-01:

| What the first run wrote | Rows | What happened |
| --- | --- | --- |
| A terminated training manager's visits, filed as `double` | 218 | Re-filed as `product_manager`, at 11:44 Cairo |
| Imported pharmacies filed on the AM or PM list | 138, with 612 visits | Moved to the Pharmacy list, each visit carrying the pharmacy's name, at 11:44 Cairo |
| Archive rows for the catch-all contact 100000 | 5, with 6 visits | Left: taking them out means permanently deleting production rows |
| Archive doctors with the same name as a doctor the rep added | 7 pairs, 29 visits | Left: moving a visit needs someone to confirm it is one doctor |
| Archive doctors with the same name as another old contact on the rep's list | 752 pairs, 4,513 visits | Left, and never merged by name: 4,237 names are shared by more than one old contact |

The repair is `supabase/migrations/20261101120000_phoenix_crm_first_run_rows_repair.sql`. It updated 968 rows and
deleted none. The schema `phoenix_crm_backup_20261101` holds those rows as they were, and the file carries the
rollback. The training manager held no seat on any of those days and their login role is Training Manager, so the
rule above files all 218 as `product_manager`.

A customer on the Pharmacy list counts as validated, so the 612 visits now read `customer_validated = true` in
`phoenix_crm_countable_visits_with_history`. Before the repair they were on doctors' lists and unvalidated.

## On a day page

Until 1 November 2026 the day page asked `validated_at` alone, so copied and real pharmacy visits read Pharmacies 0
and "waiting for their customers to be validated", although a pharmacy needs no validation. It now asks what the view
asks (`customerCountsAsValidated`).

- A copied visit has no clock: its `captured_at` is that day's midnight in Cairo. A day page prints "No time recorded",
  and a copied pharmacy row prints no half-day.
- A copied visit to a customer in the Archive (`status = 'dropped'`, not validated) reads "Old-system history"
  (`visitIsArchiveHistory`): 23,587 visits on 1 November 2026. It stays outside every figure.
- A copied visit to a customer still pending, about 17,000 visits, still reads as waiting, because that customer can
  still be validated.

## The marks

| Column or table | Set on | Meaning |
| --- | --- | --- |
| `phoenix_crm_visits.imported_from_ireports360_at` | every copied visit | the time of the run that wrote it |
| `phoenix_crm_customers.imported_from_ireports360_at` | every Archive doctor and holder the import made | the same; **cleared when the rep restores the doctor from the Archive**, by the trigger `phoenix_crm_customers_clear_import_mark` |
| `phoenix_crm_customers.campaign_visit_holder` | every "Campaign visit N" holder | not a doctor |
| `phoenix_crm_imported_visit_sources` | one row per old `crm_visit_id` | the Phoenix visit it became; the idempotency key, so a second run never writes an old visit twice |

## Who skips it, and who keeps it

**`phoenix_crm_countable_visits` skips a copied visit at its root** (`20261031160000`). Every reader of
that view skips the copy without naming the mark, so a new reader that forgets it can never count the copy
as Phoenix work. Counting the history is the reader that has to ask for it by name:
`phoenix_crm_countable_visits_with_history` is the same view without that one filter, service role only.

- **What changed with the root filter:** the adoption board (`phoenix_crm_seat_visit_firsts`) no longer
  reads a copied January visit as the seat's first Phoenix visit.
- **What did not change:** the entry-days cache (`phoenix_crm_rep_entry_days_calc`), `crm_visits_unified` and
  `crm_checkins_unified` already started at the team's Phoenix start date, which no copied visit reaches. For
  the same reason the trigger `phoenix_crm_rep_entry_days_on_visit` skips a copied visit (`20261101101900`).
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
- A second `--apply` straight after writes 0. Later it can write: a changed rule, a new seat or team, or a new
  link can bring in an old visit the last run left out. The dry run says how many first.
- These are unchanged from before the apply:
  - `crm_visits_unified` counts per rep and month;
  - the entry-days cache;
  - the pending unplanned queue;
  - notifications and outbox rows;
  - Phoenix proven-worked days for September and October.
- For three reps on different teams, September shows in the Visit Report and on the customer timeline, and
  the List's old-system line no longer counts those visits.

## The after-start copy (2026-11-07)

iReports360 was retired on 6 Nov 2026 (`crm_cutover.vendor_sync_retired_at`). From that day every territory
counts from Phoenix CRM (`20261106235920`). Before it, some reps went on logging in the old app after their
team had started on Phoenix. Those days still count, read from the stored iReports360 rows, because the
combined view keeps a vendor day only when the rep has no Phoenix entry that day. Phoenix CRM's own screens
(Visit Report, the customer timeline, the calendar) did not show them.

Asked what to do with them, the owner chose "Keep + show in Phoenix" (6 Nov 2026). `--after-start` copies them:

- **What it copies:** a current rep's iReports360 visit dated from his team's start to the day before the
  retirement, on a day with no Phoenix entry. A day with a Phoenix entry belongs to Phoenix and is never
  copied.
- **What is unchanged:** every other rule above, line for line, in the same function
  (`p_after_start`, `20261107001714`).
- **Archive note:** an Archive doctor it adds says "Visited in the old system after this team started on
  Phoenix, on a day with no Phoenix entry".
- **No count moves.** The copy carries `imported_from_ireports360_at`, so `phoenix_crm_countable_visits` and
  the entry-days trigger skip it. `crm_visits_unified` therefore keeps serving those days from iReports360,
  exactly as before.
- **Where the records go:** `F:\PHX backup\phoenix-crm-ireports360-after-start-20261107\`.

```powershell
node --env-file-if-exists=.env.production.rls.local --experimental-strip-types scripts/phoenix-crm-import-ireports360-history.ts --after-start
```

Every row a run writes carries that run's own `imported_from_ireports360_at`, and `applied-<Cairo time>.json`
names it. To remove only this copy, change the rollback below to
`imported_from_ireports360_at >= '<that run's start>'`.

**Run on production, 7 Nov 2026 at 00:27 Cairo** (`applied-2026-11-07-00-27-40.json`):

- **Written:** 23 seats, 3,067 visits of 3,067 planned, dated 10 Oct to 4 Nov. Also 15 Archive doctors and
  1 campaign holder. No seat was stopped.
- **Unchanged, read before and after:** `crm_visits_unified` for September, October and November (row
  counts and row hashes), the entry-days cache (1,241 days, same hash), `phoenix_crm_countable_visits`
  (10,736) and the notification outbox (5,153).
- **Its rows are** `imported_from_ireports360_at >= '2026-11-06 22:00+00'`.

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
