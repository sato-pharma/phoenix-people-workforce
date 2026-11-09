# Plan your week in Phoenix CRM — the week at a glance, the Excel file, and three fixes

The account behind the "Your week at a glance" rule in `.claude/rules/phoenix-crm-manager-plan.md`. It is
the premium pass of the sixth item of the Regional Sales Manager's menu, **Plan your week in Phoenix CRM**
(`RSM_PLAN_BOARD_HREF`, `/employee-portals/field-crm?tab=plan`). It shipped on 2026-11-09, in the pass the
owner asked for that night: "eyeball every report in My Team's Reports, premium polish, big work, every
single component", one page per pull request.

## What the page is

The page is the manager's own plan board, `ManagerPlanBoard`
(`src/components/phoenix-crm/manager-plan-board.tsx`). It is used by a district manager, a regional or
national sales manager, a product manager and the Training Manager. The pages are the same and are told
apart by `writer.kind`.

The board works in three steps:

1. Choose the week.
2. Choose a day.
3. Plan one half-day.

Every half-day autosaves through `POST /api/phoenix-crm/manager-plans`. The board's GET writes nothing, and
neither does opening a day.

Before this pass, a manager could not see the whole week on the board without opening the days one by one.
The day list showed a tick or nothing, and a one-line note per day.

## What the pass added

### 1. Your week at a glance (`ManagerWeekGlancePanel`)

A panel above the steps holds the week in one place. It shows on steps 1 and 2 and is hidden on step 3, so
it never sits over a half-day being edited. It is a `<details open>`. Its title is "Your week at a glance",
or "<Name>'s week at a glance" when a Super Admin or HR reader has picked a manager.

**Four tiles:**

- **Half-days planned**: "5 of 9 half-days planned".
- **Still to plan**: "3 still to plan · 1 passed with nothing planned".
- **Days planned in full**: for example "1 of 5 field days".
- **Customers**: "5 ticks · 4 different customers", with the grade line and the A share under it.

**A kind bar.** One flat bar shows the planned half-days by kind: With a rep, With a district manager, With
my manager or product manager, An area, Admin and Single visit. Its whole-number shares always add up to 100
(the largest-remainder method that District Managers' Plans uses: floor each share, then give the points
left to the largest remainders, ties to the first). A kind with no half-day is left out of the bar.

**The week grid.** On a desktop it is one `table-fixed` table with a `colgroup` of 14 / 43 / 43 (the day,
then AM, then PM). On a phone it becomes cards. It never scrolls sideways. Each half reads one of:

- the saved summary, with its kind's colour edge;
- "Nothing planned yet";
- "Passed · nothing was planned".

A holiday is one line, and a day with no afternoon shows its morning only.

**Still to plan.** One button per open half-day, for example "Tue 10 PM". The button opens that day at that
half, through the board's own `openHalf`. Passed halves are never offered.

**Districts, People and Customers:**

- **Districts:** each district the week goes to, with its half-days, days and the half-days with the
  district manager. The districts the planner is offered but the week does not go to are listed as "not in
  the week".
- **People:** the reps and the managers the week goes with, and on which half-days.
- **Customers:** the grade spread, the planner's own list, the customers the board flags, and the
  customers ticked more than once.

**Download Excel.** A link to the file described in the next section.

Every figure comes from one pure module, `src/lib/phoenix-crm/manager-week-glance.ts`
(`managerWeekGlance`). The panel only lays the figures out. The rules it follows:

- **A half is planned only when it has a saved slot with a kind.** A typed half that is not saved is still
  open, and so is an emptied half (a slot row whose kind is null).
- **A passed half that has nothing planned is never "still to plan".** It is counted on its own, so planned,
  still to plan and passed-empty add up to every field half exactly once.
- **A holiday, or a day with no half, is not a field day.**
- **A customer is one customer however many half-days tick them.** The key is the customer list's id, then
  Manager's own list's id, then the name folded. A grade is read whatever its case or spaces, and anything
  that is not A, B or C reads as "no grade". A flag on any half is the customer's flag, because the later
  half may be the one the rep dropped.
- **The A share is of the graded customers.** Nobody ticked gives words, never a zero share.

### 2. The week as Excel (`GET /api/phoenix-crm/manager-plans/export`)

The file is called `week-plan-<name>-<week start>.xlsx` and has five sheets:

- **Cover:** whose week, the plan's status, and the glance lines.
- **Week:** the screen's grid as a table: Day, the day's word (Passed, Planned, Still open, Holiday), Morning and
  Afternoon. Every row is `managerGlanceGridRow`, so the file reads as the grid does, word for word.
- **Half-days:** every half of every field day once, with the holiday as one line.
- **Customers:** one row per tick, with grade, speciality, own list and flag.
- **People:** the districts the week goes to (the ones it does not go to read "Not in the week"), and the
  people it goes with.

The file wears the house identity (`buildHouseCoverSheet`, `writeHouseMasthead`, `writeHouseTable`). It
reads the same `managerWeekGlance` arithmetic as the screen, so the two cannot disagree.

**How the route is guarded:**

1. `assertPermission(access, "phoenix_crm", "read")` is checked first.
2. Next comes the rate limit, `assertExportRateLimit`, with scope `export:phoenix-crm:manager-week`.
3. Then `loadManagerPlanBoard` reads the board with the board's own rule: the manager themself, plus the
   people who read that manager's week. A rep is refused.
4. The route asks for `scope: null`, so the file always holds the whole week, never one district's reps.
5. With no manager chosen, the route answers 400 "Choose whose week to download first".
6. Every download is audited as `crm_manager_week_export`, because the file names reps and customers.
7. The route reads and never writes the plan.

It is registered in `access-registry.ts` as an audited `export`.

### 3. The approver sees the same week at a glance

The Approvals Hub's page of a manager's week (`ManagerPlanRequestDetail`, both the portal's and the admin shell's)
now opens with the same panel, above the plan details and the half-by-half read. It shows the same figures, read
from the same module, so the approver sees the whole week before reading it half by half.

- **Text only.** The page is a server component and hands the client panel no function. With no `onOpenHalf`,
  nothing in the panel opens a half, and its note reads "The week as its planner saved it."
- **Its own download.** The link is `managerHubWeekExportHref(planId)`, which is
  `/api/phoenix-crm/manager-plans/export?plan=<id>`.
- **How the `?plan=` door decides.** It opens the week through `loadManagerPlanHubDetail`, which is the same proof
  the hub's page uses (`mayOpenManagerRecord`): the week's manager, its approvers, the Super Admin and the
  Administrator. Anything else is a 404 "not found", never a hint that the week exists.
- **A refused id never falls through.** It never reaches the board's own door.
- **The audit says which door.** Its summary ends ", from the Approvals Hub".

Every approver who can decide a week holds `phoenix_crm` read, because the decide route asks it. So the module's
gate in front of both doors refuses no approver.

### 4. The Send step counts through the same module

The Send step's tally used to be counted inline on the board: the days still to come, the halves typed and able to
save, the halves going empty, and the flagged ticks. It now comes from `managerSendTally`, and the board hands it
each typed half's kind and problem.

The rules are unchanged, and now tested on the hand-worked week:

- a passed day is history, never a gap;
- a typed half counts only when it has a kind and nothing stops it;
- a day that can no longer be edited is never named as going empty.

### 5. A district, a whole line and a region are worded as what they are

The glance spoke of "District managers" on every board. The Training Manager plans by region, and a national
sales manager's whole-line choice ("Any rep in Pedia") has no seat, yet the file printed "Seat is vacant" for it.
The empty line "No half-day is planned with a district manager yet" was also wrong for everyone: the list counts
every half planned in a district, not only the ones spent with its district manager.

- **`managerGlanceScopeKind`** tells a district, a line and a region apart from the scope.
- **`managerGlanceScopeWords`** words the tile, the section, the empty line and the file's table. It speaks of
  regions on a board whose every choice is a region, and of district managers otherwise.
- **`managerGlanceDistrictWho`** gives the file's second column: the district manager's name, then "Seat is vacant"
  for a district, "Any rep of the line" for a line, and "The whole region" for a region.

The test works the Training Manager's week by hand (two regions offered, three half-days in one of them), and a
whole-line week, through the screen's words and the file.

### 6. Six defects fixed

- **The district manager's day pill said one thing twice.** It read "Draft · not sent yet" and
  "Not started · not sent yet". It now comes from one function, `districtManagerDayPill`, which decides on
  `standing` and never on the words:
  - approved: good;
  - waiting (sent, first-approved, or ended before approval): info, showing its own status;
  - returned: warning, "Returned for changes · may still change";
  - draft: warning, "Draft · may still change";
  - not started: neutral, "Not started".
- **A district manager's week that had been returned for changes was treated as sent.** Its `sent` was
  "anything but a draft". It is now `isManagerPlanSent(week.status)`, and the new `standing`
  (`districtManagerWeekStanding`) tells returned apart from waiting.
- **The panel decided "No customers chosen" by the word "Admin" on screen.** It now asks the half's own
  `admin` flag, which is true only on the Admin fallback.
- **The grid said "No afternoon to plan" under Morning** on a day holding its afternoon only. A missing half is now
  said by which half it is (`managerGlanceMissingHalfWords`).
- **A doctor no longer on the list was only struck through** on the district manager's own day, and a screen reader
  never says a strike-through. The line now ends "No longer on the list" and only the name is struck, and the grade
  is read whatever its case (`districtManagerDayCustomerTail`).
- **The approver's half-by-half read hid an empty half.** It listed the saved halves only, so a day with its
  morning planned and its afternoon left empty showed one half. It now walks the day's own halves: an empty one
  reads "Nothing planned for this half", a planned one wears its kind's edge as on the glance, and a grade is read
  whatever its case.

The day list's finished mark (`managerDayIsPlanned`), its note (`managerDayNote`) and the areas line
(`managerAreasTickedLine`) moved into the same pure module, and so did the grid's words: the day's word
(`managerGlanceDayState`) and a day with no half (`managerGlanceNoFieldWords`). The day list, the glance and the
file can no longer count or word a day two ways.

## What it does not change

- **The plan's saving, sending and approval are untouched.**
- **The shared kit's gradient and shadow in `ui.tsx` are left as they are.** The gradient is the owner's
  pinned design (`tests/phoenix-crm-plan-board.test.ts`).
- **No migration.** `audit_logs.entity_type` has no CHECK constraint.

## The test

`tests/phoenix-crm-manager-week-glance.test.ts` builds one week by hand: Hany Saad's week of Saturday 7
November 2026, viewed on Monday 9. It has three districts offered (one with a vacant seat), a passed
Saturday, a Sunday holiday, a Monday planned in full, two half-planned days and a Thursday with a morning
only.

Every figure above is asserted against that week: 9 halves, 5 planned, 3 still to plan, 1 passed, 5 ticks
and 4 customers, among others. The test also checks the workbook sheet by sheet, and pins the route's
order, the registry entry, the board's wiring and the flat, square, neutral look.

Thirty break proofs were run before the merge. Each one broke a single line, and each was failed by its own
assertion. The first ten:

- passed counted as open;
- a holiday counted as a field day;
- a customer counted once per tick;
- grades read with their case;
- shares short of 100;
- not-in-the-week inverted;
- the returned colour;
- returned counted as sent;
- the audit name;
- the step-3 guard.

The next ten:

- Send counting a passed day;
- Send counting a typed half that cannot save;
- Send naming a locked day empty;
- the hub link not encoded;
- a refused hub id falling through;
- the hub page losing the glance;
- the panel opening a half with no handler;
- the region words lost;
- a line read as a vacant seat;
- the scope kind ignored.

The next five:

- a missing morning said as the afternoon;
- a passed day read as planned;
- the file's Week sheet left out;
- a gone doctor struck through only;
- the raw grade on the doctor line.

The next two: the approver's list hiding an empty half, and the approver's grade read raw.

The last three are on a district manager's own week, which has no district to choose: a manager gone with counted as
a rep, and the district table or the districts rows written on that file anyway.
