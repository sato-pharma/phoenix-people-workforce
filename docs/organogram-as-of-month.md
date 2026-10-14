# The organogram "View as of" a month

Owner request, 2026-10-14: *"View as of a month on the chart."* The chart used to draw only today.
Now a viewer can pick a month that has already ended and see the structure as it stood on that
month's last day. This is the account behind the rule in `.claude/rules/org.md`.

## What it is — and is not

A **read-only picture of the structure**: which seats existed, who held each one, and who they
reported to, as recorded in the seat model. It is not a closing, not a sales number and not a
people export. Everything that only means something TODAY is switched off on a past picture:

| Off on a past picture | Why |
| --- | --- |
| Edit, Resign, "Add employee to this seat" | they change a person or a seat as they are now |
| Open offers on empty chairs | an offer is a fact about today's empty chair |
| The Head Office branch | built from the employee master, which carries no seat dates — it would draw today's Head Office under a past month's name |
| The spreadsheet and "Select & email" | they pair today's contact details with a past month's seat |

The banner above the chart says so, and it prints, so a page taken off the screen cannot be filed
as today's structure.

## Where the answer comes from

`public.au_f_org_tree_as_of(p_date date)` — one additive, read-only database function (migration
`20261014110748_org_tree_as_of_month.sql`), `service_role` only, same columns as `au_v_org_tree`.
The API is `GET /api/reports/organogram?asOf=YYYY-MM`; the app asks for the month's **last day**.

How it answers a day (spans are half-open `[effective_from, effective_to)`):

- **A seat** is on the chart if its own `effective_from` / `effective_to` cover the day.
  `is_active` is deliberately ignored: it says whether a seat is live now, and the old single Upper
  Egypt district (retired 2026-09-01) must still draw for July and August.
- **Its occupant** is the `au.occupancy_history` span covering the day; a vacant placeholder span,
  or no span, is a vacant seat.
- **Its manager, region, area and line** come from that span first and the seat itself second. The
  span carries the manager seat the seat answered to *then*, which is what reproduces the Upper
  Egypt split (July and August reps under the old district seat; September on, under the two new
  ones).
- **Reachability** is a recursive walk from the root, as the live tree does.
- A span whose manager seat is **not on the chart that day** falls back to the seat's own parent.
  Staging carries four such spans (open spans still naming the retired Upper Egypt seat) and,
  without the fallback, those four reps vanished from the chart.

🔴 It reads the raw spans and **never** `au.f_seat_occupant_asof`: that resolver's first arm credits
today's holder with the seat's whole history, which is an attribution rule for sales, not a record
of who sat where.

## Which months are offered

July 2026 (the seat model's first seat starts 2026-07-13) up to the last finished month, newest
first, plus "Today (live)". The current month is never an as-of choice — its last day is in the
future. Earlier months have no seats at all, and offering them would draw an empty chart that reads
as "the company had nobody" instead of "no record". A malformed or unchoosable month is a 400,
never silently answered with today's chart. Pure rules: `src/lib/reports/organogram-as-of.ts`.

## Measured when it shipped (production, 2026-10-14, Cairo)

| Date | Seats drawn | Notes |
| --- | --- | --- |
| 2026-06-30 | 0 | before the seat model |
| 2026-07-31 | 132 | 36 vacant; 7 reps under the old Upper Egypt district seat |
| 2026-08-31 | 137 | |
| 2026-09-30 | 140 | |
| today | 140 | equals the live tree: 0 seats differ in occupant, parent, region or area |

## The known limit

A seat that has **no span covering the day** (empty before it was first filled) takes today's
parent, region and area. The chart never invents a person for it.

## Pinned by

`tests/organogram-as-of-month.test.ts` — the month rules, the function's shape and grants, and each
place the past picture must differ from the live chart. The migration's own proof block fails the
apply if the function disagrees with the live tree about the seat count or any occupant today.
