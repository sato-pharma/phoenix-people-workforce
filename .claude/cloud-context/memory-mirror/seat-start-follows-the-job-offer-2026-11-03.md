---
name: seat-start-follows-the-job-offer-2026-11-03
description: "A new hire's seat starts on the job offer's start date through the Master's hire date (owner, 3 Nov 2026). 40 rows corrected, 2 held to 8 Nov; pre-image in au_backup_20261103.occupancy_hire_start."
metadata:
  node_type: memory
  type: project
  originSessionId: e50549d1-2c7d-48f2-9380-f5c0f14ffe8c
  modified: 2026-11-03T19:31:01.030Z
---

Owner, 2026-11-03: "the start date must follow the date, the start date in the job offer, not the date when he accepted".

`phx_hire_into_seat_on_vacancy_filled` dated seats from `filled_at`, the day the record is created at acceptance. The Master's hire date already matches the letter (only Aya Ali and Sahar El Gallad differ, and he ruled both correct, so their seats follow the Master's 24 Oct). Migration `20261103133000_seat_start_follows_the_job_offer.sql` is live on staging and production through `scripts/apply-sql-file.mjs`, because the production tool declined it.

**Corrected on production, 3 Nov about 13:20 Cairo:** 40 open hire rows and 34 vacant rows, one transaction, pre-image `au_backup_20261103.occupancy_hire_start` (keep it). Sales credit on every seat at every month end of 2026, the organogram and open vacancies all unchanged; drift stayed at 108; inverted rows went from 1 to 0. Closed spans were left alone.

**Still owed from 8 Nov 2026:** Toka Zaki (`SEAT-CNS-REP-D25`, seat 2 Nov) and Mahmoud Khaled (`SEAT-CNS-REP-CA1`, seat 1 Nov) start on 8 Nov. Moving them before that flips the published months' credit on their seats to Muhammad AlMinshawy and Georgette Hany, who held them, until 8 Nov. From 8 Nov the same update moves no credit, measured by the arm order of `au.f_seat_occupant_asof`. A one-off scheduled task for it was refused by the permission classifier twice (the second time on 3 Nov about 21:35 Cairo, with the owner's own request behind it), so it needs doing by a session. Same update, restricted to those two seats, with its own pre-image: `au.occupancy_history` person rows 297 and 301 `effective_from` and vacant rows 280 and 290 `effective_to`, all to 2026-11-08.

The owner sent "move Toka Zaki and Mahmoud Khaled's seat dates to 8 Nov" on 3 Nov, five days early, because a reply quoted those words as a future step and the box offered them. It was held, not done. Never quote words he should only send on a later date: he sends what the box holds.

**How to apply:** a pending joiner's seat reads vacant on the DATED readers until the start, and every new accepted hire does the same; for sales credit that is the rule working. It is NOT acceptable on the live chart: the owner reported the same day that people who accepted were missing from the organogram, so `drawJoinersAwaitingStart` (`src/lib/reports/organogram-au-source.ts`) draws them on their seat with "Starts <date>". Never fix that in `au.v_org_tree`. Open-only readers still show them. Related: [[au-occupancy-hiring-date-from-master]], [[hire-date-history-survives-only-in-probation-reminders]].
