# District Managers' Plans — premium pass, 9 November 2026

District Managers' Plans is the page at `/employee-portals/district-manager-plans`. It is the Regional Sales Manager's alone (Dr. Hany Saad's fifth need, 8 Nov 2026). The owner asked for the premium pass on 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every single component", then "group reps by district manager".

It is the fifth page of that pass, after Coverage, Frequency, Visits — Yesterday and Today (`docs/team-visits-report.md`) and the Reps List. It wears the same kit. This file explains what the page shows and where each figure comes from.

## The rules the page keeps

- **Only a sent week is shown.** A district manager's draft is never read. A week that is not sent prints "Not sent yet" and the day it was due.
- 🔴 **A sent week nobody decided before its Thursday passed has ended** (owner, 2026-11-08). It reads "Ended before it was approved", never "Waiting for approval", because the database refuses every step on it.
  - The loader used to ask the status words without the week (`managerPlanStatusLabel(plan.status)`). A re-sent week from 31 October therefore still read as waiting on 9 November. It now asks with the week and Cairo's today.
  - The panels count such a week as ended, never as waiting, and the "Waiting for a decision" filter leaves it out.
- 🔴 **A chain visit is information, never a warning** (owner, 2026-10-24). A chain visit is two managers with one rep on the same day.
  - It is a sky line with the people icon, and it has its own list at the bottom.
  - It is never a reason on "Weeks to look at", never a warning colour, and it never blocks a plan.
- **A vacant district manager seat is a seat, not a manager who did not send.** It wears the lightest colour (owner, 2026-11-09: "if a seat a vacant color in light color"). It is counted in neither "sent" nor "not sent", and it has no row on the week at a glance.
- **Admin work and leave show in place of a visit** (owner, 2026-11-09: "if a day for dm or rep has admin work put it instead of visits and if vacation put it").
  - An admin half shows its activity ("Office", "Training").
  - A day the district manager is on approved leave reads "On leave", never "Nothing planned".
  - A half with a rep on leave says so.
- **Grouped by region and district manager.** Each section is headed `regionManagerTitle` over `regionGroupCaption`, the one helper every Regional Sales Manager screen uses.

## What the Regional Sales Manager sees

**The toolbar.** The week, with a line saying whether it has ended, is running or is still ahead. Then a key to the half-day colours (with a rep, with a senior manager, an area, admin, a single visit) and Download Excel.
- Previous week, This week and Next week keep the filter.
- The Show filter lists Every seat, Sent, Waiting for a decision and Not sent, each with its count.

**Four tiles.**
- *Weeks sent*, out of the seats with somebody in them, split into approved, waiting and ended undecided.
- *Not sent*, with how many were sent late, and the vacant seats named apart.
- *Half-days planned* across the sent weeks, by kind.
- *Reps a manager is with*. Every manager kind counts, so a rep the Regional Sales Manager himself goes with is not alone.

**Where the weeks stand.** Two flat bars, each with a key that gives every count.
- Every district manager seat by where its week stands. It adds up to the seats on the page.
- Every planned half-day of the sent weeks by kind. It adds up to the Half-days tile.
- Shares are whole per cent and always add up to exactly 100, using the largest-remainder method.
- One sentence under the bars says how many weeks were sent, approved, waiting, ended undecided and late. Another counts the Saturday-to-Thursday half-days with nothing planned, leaving out each manager's own leave.

**The week at a glance.** One row per district manager, one column per day, AM over PM.
- Saturday to Thursday always appear. Friday appears only when a sent week planned something on it; a draft's Friday never opens the column.
- A half with a rep shows the rep's name. Any other half shows the plan's own words.
- A day on leave reads "On leave", and an empty half reads "Nothing". A week not sent fills its row with "Not sent".
- Today's column is marked.
- It is a table from `lg` up and one card per manager below that, never a sideways scroll.

**Weeks to look at.** Plain facts, never a judgement, in this order:
1. not sent (or returned and not sent again), with the day it was due;
2. ended undecided;
3. sent late;
4. a half with a rep on approved leave that day;
5. a half with a rep whose own week is not sent or has no plan;
6. customers ticked that are no longer on file.

Each line names the halves ("Mon 9 AM with Tamer Fouad (not sent)").

**Whom they will visit** (Dr. Hany Saad's sixth need: "know who he goes with and whom he will visit"). One row per district manager with a sent week, and the whole team underneath:
- the ticks and the different customers behind them. A customer ticked on two half-days is two ticks but one customer;
- the customers by grade (A, B, C, no grade) and the share of the graded ones that are A;
- the first three specialities, with how many more;
- the customers ticked on more than one half-day ("Dr. Mona Saleh ×2");
- the customers no longer on file, and those from the managers' own lists.

A customer is matched by name and speciality. The grade is the list's own, read as A, B or C whatever its case or spaces; anything else is "No grade". A draft's customers are never read.

**Reps no manager is with this week.** The reps in a seat whom no manager of any kind is with, team by team. A rep on leave all six field days is left out, because nobody could be with them.

**Chain visits.** Every chain visit of the week, neutral.

**One section per district manager**, its left edge in the week's colour:
- a heading with the region and the manager, and the week's status;
- when it was sent, whether late, and when it was approved;
- the half-days by kind, the half-days still open, how many of the team's reps he goes with, and the customers ticked;
- his own leave days;
- "Open the week" on a sent week, which opens it on the Approvals Hub (`managerPlanHref`);
- each day's AM and PM: the plan, its kind, the rep's own day, the customers, any no longer on file, and the chain visits;
- the team this week: each rep's own week, leave, the managers with them and how many half-days a manager is with them (two managers on one half count twice), with the vacant seats on one light line.

## Where the figures come from

Nothing on this page adds a measure.

- `loadDistrictManagersPlans` (`src/lib/phoenix-crm/server/manager-plan-bookings.ts`) reads the weeks, their half-days and customers, the bookings of every manager kind on the team's reps, the reps' own weeks, and approved leave for the reps AND the district managers. If either leave read fails, the page says so once, and nobody is marked on leave.
- `src/lib/phoenix-crm/server/district-plans-summary.ts` holds every figure the page prints: the states, one week's figures, the team's totals, the bars, the grid, the attention list, the reps alone, the chain visits, the customer mix and the filter. It is pure and reads only the report.
- `src/lib/phoenix-crm/server/district-plans-workbook.ts` is the Excel file.
  - Sheets: Cover, Managers, Half-days, Customers, Reps and To look at, in the house identity.
  - Customers holds one line per manager (ticks, different customers, A, B, C, no grade, no longer on file, the A share), the customers ticked more than once, and one row per tick of every sent week with its grade, speciality and list.
  - It is served by `/api/crm/district-manager-plans/export`. That route checks `phoenix_crm:read` and `readsRegionalTeamReports` before any read, is rate-limited, and records every download in the audit log as `crm_district_plans_export`.
  - `week` is read strictly. The file always holds every seat, whatever the filter.
- The filter (`show`) narrows only the sections listed. The tiles, bars, grid and lists are always the whole team's.

## The finish

Flat colour, square corners, no gradient, glow or drop shadow (owner, 22 Oct 2026). No ellipsis, and no he, his or him in any word on the screen or in the file.

The panels are `src/components/crm/regional/district-manager-plans-panels.tsx` and the sections `district-manager-plans-view.tsx`. Both are markup only, so the page stays a server component. Every table is `table-fixed` with a colgroup that adds up to 100%, and the phone gets cards.

## Tests

`tests/district-manager-plans-premium.test.ts` checks a fixed team of four seats worked out by hand. It covers:

- the ended rule, and the loader asking the status with the week;
- the states, one week's figures, the team's totals and the bars;
- the grid and its Friday rule;
- the attention list, the reps alone and the chain visits;
- whom they will visit: a customer counted once however many halves name them, grades counting customers, and a draft adding none;
- the filter, the words, the workbook, the export's gate and registry;
- the flat kit.

It is registered in `tests/run-tests.ts`.
