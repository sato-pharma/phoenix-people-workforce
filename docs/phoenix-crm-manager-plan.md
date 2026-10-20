# The district manager's weekly plan in Phoenix CRM

The account behind the rules in `.claude/rules/phoenix-crm-manager-plan.md`. Every ruling is the
owner's own, given in chat on 2026-10-16 across five rounds.

## What he asked for

He wanted the district manager (DM) to plan his week "exactly like the numbered form that the medical
reps use", but the other way round. For each half-day the DM does one of three things:

- **With a rep.** His reps are listed with the bricks they visit that day. He picks one, then ticks
  some of that rep's customers for that half, or presses **Mark all** ("mark 6 or mark all").
- **Admin.** One of the seven day activities (meeting, training, conference, admin work, travel, health
  day, sales day), plus a note.
- **Single visit.** An area of his district, vacant rep seats included. Then customers from that
  area's rep lists, from **Manager's own list**, or a newly typed customer. A customer he adds needs
  a name, the two grades and an area of his region; the **speciality, phone, address and brick are optional**
  (owner, 2026-10-18). **Area** and **Brick** are cascading drop-lists: the areas of his region, then the bricks
  of the area he chose. **Capture location** fills the address and selects the area and the brick when it can,
  and he can still change them.

AM and PM are each a choice of their own.

## What it replaced

Before this, there were two DM plans:

- **The legacy Weekly/Monthly plan** (`employee_plan_headers`). 19 DMs filed it. It was typed by hand
  and never built from their reps' real days.
- **The 2026-10-02 double-visit planner** (`phoenix_crm_double_visit_plans`). It held one row, handled
  only double visits, and was never sent or approved.

This plan replaces both, for DMs only. The old planner's POST now answers 410. Its GET and its one row
stay, and the visit report reads that row beside the new with-rep half-days.

### Measured on production before building (2026-10-16)

| What | Result |
|---|---|
| Legacy DM plan items | 854 over 42 days: Double Visit 53% (444 of 450 already name a rep), Single Visit 19%, the admin family 26%, Coaching 0. The three new kinds cover 98% of what DMs already did. |
| DM approver | All 19 DM seats have the same manager in the organogram and the HR record. |
| Live teams | 18 of 19 DM teams are live. Mohamed Alaa Eleiwa's (Pedia) is not. |
| Existing "My own visit" entries | 25, by 2 managers, since 3 Oct. They counted in territory KPIs. |
| Acting DM who also holds a rep seat | Exactly one person: Nosiba Salah. |
| Payroll | No exposure. The no-weekly-plan deduction applies only to Product Manager and Group Product Manager. |

## Why a separate table family

Putting DM rows in `phoenix_crm_plans` breaks things in both directions:

- **Its readers would pick up DM rows.** They scan by seat or by week: `crm_plan_entries_unified`, the
  reports, the expiry passes, the visit save's "on a sent plan" check, `loadPlanReviews` and
  `phoenixCrmPlanIdsAwaitingDecision`.
- **Its writer refuses DM rows.** `phoenix_crm_save_plan` demands that the customer's seat is the
  plan's seat, and a DM seat owns no customers.

Migration `20261017000000_phoenix_crm_manager_plan.sql` adds seven tables:

| Table | What it holds |
|---|---|
| `phoenix_crm_manager_plans` | The week header: status, version, due date, late stamp, both approvers. |
| `phoenix_crm_manager_plan_slots` | One half-day: its kind and that kind's own fields. |
| `phoenix_crm_manager_plan_customers` | The customers ticked for a slot: a rep's customer or one from his own list. |
| `phoenix_crm_manager_plan_events` | The trail, with a snapshot taken on submit. |
| `phoenix_crm_manager_plan_edit_requests` | His asks to reopen a sent week. |
| `phoenix_crm_manager_customers` | Manager's own list: the optional address and picked brick (`pin_address` / `pin_brick_id` / `pin_brick_name`; a row with no `pin_lat` was filled in by hand), an optional pin and the removal fields. |
| `phoenix_crm_manager_visits` | His own single visits, planned or unplanned. |

Every table has RLS on and no anon or authenticated access. Every function is SECURITY DEFINER and
executable by service_role only.

There is deliberately **no foreign key to `phoenix_crm_plan_items`**: the rep's own save rewrites
those rows, so a link would make his save fail. "Not sent" and "no longer on the rep's day" are worked
out when the plan is read.

The migration also replaces `phoenix_crm_merge_duplicate_customer`, so a merged customer is re-pointed
in the two new tables that name one. The live body was proven by md5 against the repo file before the
replacement.

## Approval

- **First stage:** his RSM or NSM, `territoryReviewer(org, dmSeatId)`.
- **Second stage, after every regional manager:** the National Sales Manager above him. Owner,
  2026-10-17: *"if regional manager applicable then after the rm approve the nsm also must approve
  never skip"*. `managerPlanApprovers` reads it from the organogram: when the first approver holds an
  RSM seat, the second is the NSM seat above it. So a regional seat filled tomorrow gets the step with
  no list to update. Today that is Hany Saad, then Ali Mohamed Ali — the one named pair in
  `src/lib/workforce/plan-second-approver.ts`, which the legacy plan still reads and which this rule
  replaced for the Phoenix CRM week.
  - **An empty NSM seat** passes the step up to the CEO, the way every vacant seat passes upward. The
    week never closes on the regional manager's approval alone.
  - **An empty RSM seat** passes the FIRST step up to the NSM, who then approves alone: there is no
    regional approval to follow.
  - **Who decides never changes the stages.** The database closes a week at the first approval only
    when no second approver was stored on send, so the Administrator acting for the regional manager
    still passes it on. Pinned in section 1 of `tests/phoenix-crm-manager-plan.test.ts`.
  - **The same two steps decide his asks.** Asked the same day which approvals the rule covers, he
    answered *"Week + edit asks + removals"*. His ask to reopen a sent week and his ask to take a
    customer off Manager's own list store their second approver when they are raised, as the week does
    on send. The regional manager's approval passes the ask on (`first_approved`,
    `removal_first_approved`); only the NSM's approval reopens the week or removes the customer, and a
    refusal at either step closes the ask. The NSM is told when the regional manager agrees; the
    district manager's own requests list says who the ask waits on.
  - **Each step is decided by its holder only, and the page names the step it showed** (`stage`), so a
    page left open on a step already taken is refused rather than deciding the next one unread. When a
    caller names no step, the database reads it off the ask's own status, so the code running before
    the change kept working. An ask nobody finished deciding closes with its week at either step.
    Migration `20261017120000`; pinned in section 9 of `tests/phoenix-crm-manager-plan.test.ts`.
- **No other stage for a district manager.** There is no HR acknowledgement and no SFE step. The
  regional, national and product managers who plan here since 2026-10-17 are approved differently —
  see the last section.
- **Where it is decided:** the portal Approvals Hub. The choices are Approve, Return the week and
  Return one day.
- **The Administrator** may act in place of any holder at any stage. The decision is recorded and shown
  as "by the Administrator".
- **Every decision names what it read.** A send, an approval, a return and a decision on an edit ask
  carry the plan version the screen showed, and the server refuses one that does not; a decision on an
  own-list removal carries the time that ask was raised. A page left open on an older week, or on an
  ask that was refused and raised again, is told to reload — it never decides the newer one unread.

The Hub reads the queue through `server/manager-plan-queue.ts`, merged once into
`getPlanApprovalsForResponder`. That one merge covers the pending count, the badge, Needs You, the
overdue check and the bell. The same rows are merged separately into My Requests, History, the CEO's
feed and the second approver's feed — every week stored with that person as its second approver, read
by his own id rather than from a named pair. Each open week, ask and removal is filed by its own step
(`managerQueuePlace`): the regional manager's turn, then coming to the NSM, then the NSM's turn.

## What counts as the actual

| Half-day kind | Judged by |
|---|---|
| With a rep | The double or chain visits the **rep** logs that name him, customer by customer: `phoenix_crm_countable_visits` on the rep's seat that day, judged by `countsAsManagersDoubleVisit`. (`phoenix_crm_report_manager_visits` is a per-manager count with no customer in it, so it cannot answer which ticked customer was seen.) Ticking a rep is not itself a double visit. |
| Single visit | His own `phoenix_crm_manager_visits`. |
| Admin | Not checkable. |

Only a week he **sent** is judged — waiting for a decision, or approved. A draft, or a week returned to
him, is still his to change, so it counts nothing as planned or missed; the visits he logged that week
are listed apart with his unplanned ones.

The planning calendars show a with-a-rep half-day as **Field**, never as a Double Visit, and the Visit
report generator's column for it reads "Manager's plan with the rep".

His own single visits count **only in his own report**. Nothing adds them to a rep's figures or a
territory KPI. For the same reason, the old "My own visit" option is closed for anyone holding a DM or
acting-DM seat **once he plans in Phoenix CRM** (`managerOwnVisitClosedNow`: the seat test and the
switch below). One still on the legacy form has no "My single visits" to log in instead, so he keeps
it; an unreadable switch keeps it open too, because a refused save loses a real visit. On a territory
with no rep the visit form does not pre-pick Double visit — it says where his visit goes instead. The
25 visits already logged stay as they were.

Re-saving a single-visit half-day writes it afresh, so the visits he already logged against it are
handed to the new half-day (`relinkPlannedVisits`) — planned ones of that day and half only. With a
rep, a new tick must be on that rep's own half-day (`assertOnTheRepsHalf`); a customer he ticked
before the rep dropped him stays, flagged, and the board keeps that rep selectable so the tick can be
seen and taken off.

The report is read by:

- the DM himself;
- his RSM and his NSM;
- the SFE Manager, the CEO and the Administrator.

A rep can never read it.

## The district manager's single-visit limit

Owner, 2026-10-19: a district sales manager may not submit more than **one day** of single visits in a week
(*"currently the single visits are accepted in 2 days in a week no cap it to 1 day in the week"*), counted
as **two half-days in any mix**, and the limit covers **the visits he logs** as well as his plan. It
lowers his 2026-10-17 limit of two days, which he had counted as "four halves or 2 full days" — the
any-mix counting stays.

- **Planning.** `saveManagerPlanSlot` refuses a Single visit half when the week already holds two other
  single-visit half-days. Re-saving a half he already planned as a single visit is no new half-day.
- **Logging.** `logManagerVisit` refuses an unplanned visit that would open a third half-day. A planned
  visit answers a half-day the plan already holds, so it is never refused. An unplanned visit falls in the
  morning or the afternoon of the Cairo time it was logged, before noon being the morning.
- **Who.** The district manager only. A regional, national or product manager's single visits are not
  limited.
- **On screen.** The Single visit part of the board and "My single visits" both tell a district manager
  the limit and how many of the two half-days the week holds — counted by the server exactly as the save
  and the log count them, his planned half-days AND the half-days of visits he has already logged
  (`singleVisitHalvesUsed` on the board, `singleVisitLimit` on My single visits). Until 2026-10-19 the
  board counted the plan alone, so it could say "1 of 2" while the save refused a second half-day that a
  logged visit already held. When no half-day is left for an unplanned visit at the time he opens My
  single visits, "Log an unplanned customer" is replaced by a sentence saying so, so a full week is not
  learned from a refusal after the form.
- **Where it lives.** `server/manager-single-visit-cap.ts` counts; the rule is
  `dmSingleVisitCapError` in `manager-plan-rules.ts`. There is no database constraint, so two saves sent
  at the same instant could both pass the count.

### After midnight is the evening before, and a full week says so (2026-10-20)

He wrote *"no button to add the single unplanned visit"*. The button is hidden on purpose once a week holds
its two half-days — but one of them could be a phantom. A visit logged at 00:08 Cairo is filed on the day
before (`cairoBusinessDay` subtracts the 2-hour `VISIT_DAY_CUTOFF_HOURS`), while `singleVisitHalfOfHour`
read the clock hour, 0, as a MORNING. So a manager who worked one evening into the night held that day's
afternoon AND a morning he never worked: "2 of 2", and the button gone for the rest of the week. On 20 Oct
the test persona Dina Hamdy was in exactly that state. Hours before the cutoff now read as the afternoon;
the cap, the actual-versus-planned report and the visit details all read through that one function.

And the full week no longer hides the button silently: a warn note stands where it was, saying the
unplanned log is closed for the week and a planned single visit can still be logged.

## A rep who still works in the old CRM

Owner, 2026-10-17: *"if the district manager's reps are still working on the old CRM … their weekly plans
on the CRM must appear to the district manager when he is making his weekly plan in Phoenix"* and *"make
sure the district manager can validate the reps' CRM that are entered and the old CRM."* His answers to
the two questions put in chat: the board shows **"their old-CRM plan, tickable"**, and validate means
**"approve the rep's weekly plan"** (not visit confirmation, not customer approval).

All 21 district teams are live, so this is a rep-level question, not a team one: 25 active reps had no
Phoenix plan for the week of 17 October, under 11 district managers, while the iReports360 sync was still
running (plans 22:06, visits 22:14) and 42 reps were still logging visits there.

- **The board.** `loadRepWeeks` reads a rep's iReports360 week (`getAgentsWeekPlanEntries`, the CRM door,
  the vendor's own `ireports360_plan_entries` rows, weekly) only when Phoenix holds no customer of his that
  week; a Phoenix draft or sent plan is never replaced. His state is `old_crm`, the pill reads "Old CRM plan",
  and a customer he planned there is flagged like a sent one (it is a filed plan, not a draft).
- **🔴 It reads the vendor's rows, never `crm_plan_entries_unified` (2026-10-18).** The view anti-joins every
  iReports360 plan entry of a rep in a STARTED team from his `counted_from` on, and all 21 teams are started,
  so the first version of this read (#6064) answered zero for every rep it was built for. Found when a
  product manager could not pick Gehad Alaaeldin (Pedia, Minia): the mirror held 22 reps' weeks for 17 Oct
  (synced 14:04 Cairo; her plan 27550, 59 calls) and the view held none, so the board printed "No plan this
  week" and greyed each rep out. After the fix, run through the board's own loader on production, 22 of 22 reps
  read, Gehad's week gives 10 half-days with 59 of 59 customers tickable. The sync was never down. A reader that
  asks "what did this rep file in the old app" reads the vendor's rows, as plan verification already does
  (`getPlanForVerification`); the counting views are for counting. Pinned by `tests/crm-cutover.test.ts` (five
  unified-view reads, four raw ones in `plan-board.ts`) and `tests/phoenix-crm-manager-plan.test.ts`.
- **When the old week exists.** Reps file the next week in the old CRM on Wednesday to Friday (the 17 Oct plans
  were first synced 14 Oct 17:06 to 16 Oct 19:05 Cairo). Before then the coming week shows "No plan this
  week" for an old-CRM rep exactly as it does for a Phoenix rep who has not started a draft; it is not a
  sync fault.
- **Which half.** The old weekly plan names a day and no morning or afternoon (`appm`, `startAM` and
  `startPM` empty on all 16,544 weekly rows since 19 September). A contact goes where his **list** puts him
  (`halfOfListType`: AM list the morning, PM list the afternoon), as the rep's own Phoenix plan does.
- **Which customer.** Matched to a customer on the REP's own seat through `own_contact_crm_id` or
  `reference_contact_crm_id` (1,473 of 1,614 planned calls, 91%, for a sample of old-CRM reps). A matched
  one can be ticked; an unmatched one is shown "Not on the rep's Phoenix list" and cannot. A pharmacy is
  left out (never planned with a rep, owner 2026-10-02), and the vendor's catch-all contact is not a customer.
- **The server holds it too.** `assertOnTheRepsHalf` reads the same old plan, so a tick must still sit on
  the rep's half, whichever system the rep plans in.
- **Approving.** The Team tab's Weekly plans list shows such a rep's week with its status and the buttons
  **Approve the week** and **Take back approval**. It is the vendor's own supervisor approval and nothing
  else: `setPlanVerification` (the admin Plan Verification board's own service), so
  `decidePlanVerification` refuses an approval over an area manager's (status 2), a take-back of anything
  but the district manager's own approval, and an unknown status. The vendor has no "return" and no note,
  so none is offered.
- **Who.** Exactly the admin board's reach: the District Manager and Regional Manager roles, the
  `crm_plans:approve` grant (the CEO stays observational), and the plan's rep inside the viewer's reach. On
  top of that the Phoenix refusals: the Super Admin decides nothing, and a test login holds no vendor plan.
- **When the vendor is retired.** The buttons go (`resolveVendorSyncStandDown`); the plan stays readable.
- **What it does not do.** It writes nothing about a rep's visits, never pulls a plan on demand, and adds no
  count to the "waiting for you" totals (those count Phoenix weeks); the week's list does count it in its
  own "Waiting for review" filter.
- **Where it lives.** `old-crm-plan-rules.ts` (rules), `server/manager-old-crm-weeks.ts` (the board's read),
  `server/old-crm-plan-approval.ts` (the Team tab's read and the decision), `app/api/phoenix-crm/plans/old-crm/decide`.

## Screens outside Phoenix CRM

Six readers showed a DM's legacy plan. Each now reads his Phoenix CRM week through the one adapter,
`server/manager-plan-readers.ts`:

1. **The Planning Calendar.** A with-rep half-day books that rep.
2. **The landing-page plan card.**
3. **The private calendar.** Display only, never cover.
4. **The company calendar.**
5. **Decided for me.**
6. **The visit report's double-visit plans.**

The Action Center's My Requests and History were already covered by the Hub plan tabs.

Five places were checked and left alone, because no DM appears in them:

- attendance office days;
- the CEO Command Center;
- Employee 360's team lifecycle;
- the plan drift check;
- the no-weekly-plan deduction.

## The switch-off

`dmPlansInPhoenixCrm(hrId)` is true when he holds a DM or acting-DM seat **and** that seat's team is
live — **unless his job title still owes the legacy plan.** The no-weekly-plan deduction charges a
Product Manager or a Group Product Manager a day for each week with no plan on the legacy form
(`owesAWeeklyPlan`, read from `employees.job_title` exactly as the charge reads it), so such a person
keeps that form whatever seat he holds. On 17 Oct 2026 the DM seats were held by 18 District Sales
Managers and one Senior District Manager, so this guard switches nobody back today; it stops a future
seat holder being charged for a plan he was not allowed to file. When it is true:

- **The legacy write paths refuse him.** `createEmployeePlan` and `updateEmployeePlan` refuse, and
  `canSubmitPlans` is false.
- **His Plans tab becomes his history** (owner, 2026-10-17: "make it unhidden, but make them not able
  to submit … only able to see their historical plans, which they submitted on the old module"). The
  tab stays, with the Planning Calendar. `/employee-portals/plans` opens `PlansHistory`: every plan he
  filed on the old form, newest week first, filtered All / Weekly / Monthly, each opening to its days
  and its decision history. It has no field and no button that writes.
- **Nothing on the old form writes for him.** Besides create and update, `cancelEmployeePlan`,
  `requestEditEmployeePlan` and `submitVisitDetails` refuse him too, so a stale page or a hand-built
  request cannot reopen a plan. His history is loaded by `loadOwnPlanRows`, so an old plan outside the
  company-wide 250-plan window is still on it.
- **A link to someone else's plan still opens the review workspace** for the approver it was sent to.

Plans already filed stay readable and decidable.

Mohamed Alaa Eleiwa switches over by himself the day his team starts. Nosiba Salah files both her
rep week and her manager week; a switch on the Plan tab chooses between "My territory" and "My
district".

## Test rows

`scripts/phoenix-crm-clear-test-rows.ts` sweeps the seven tables. Two of them must be cleared before
`phoenix_crm_customers`, because they reference it with no cascade: `manager_plan_customers` and
`manager_visits`. Three of the tables carry no `is_test` flag and are reached through the plan header.
`docs/phoenix-crm-test-rows.md` has the foreign-key graph.

## Widened to the regional, national and product managers (2026-10-17)

His request, about 18:00 Cairo: *"Now do the same for the product managers and the national sales
managers and the regional manager. The only difference is that he first choose the region or the
district manager, then the areas of this district manager appear."* His answers, in chat the same
evening, recommended options first:

- **Approvers:** *"as today HR auto acknowledge"* — the same people who approve each one's legacy plan
  today, and then HR acknowledges by itself.
- **When the district manager is chosen:** *"once per day by default but have the option to half-day
  when choosing area"*.
- **Which product managers:** Rasha Sabry and Ahmed SharafEldeen. Their legacy form stays, because the
  no-weekly-plan deduction reads it. Hossam Reda (Marketing Manager) is out — he has never filed a plan.
- **A product manager's scope:** *"make him choose between the 2 lines pedia and anti infective
  whever he he chooses from both appear its district managers and make product managers able to skip
  districyt managers and choose a rep with out district manager"*; asked whether that held for both,
  *"Both of them"*.

### Who plans, and as what

`managerPlanWriterOf` answers one of four kinds. A district manager seat comes first, so a person on
one still plans as the district manager he is; then a national or regional seat; then the Product
Manager or Group Product Manager role (`plansAsProductManager`, read from the live roster in
`server/manager-plan-writers.ts`).

| Kind | Production, 17 Oct | Chooses from |
| --- | --- | --- |
| Regional sales manager | Hany Saad (Pedia) | the three district managers below his seat |
| National sales manager | Ali Mohamed Ali (Pedia), Amr Mohamed Naguib (CNS), Magdy El Senosey (Anti Infective) | every district below his seat; those under a regional manager are grouped under "Hany Saad's region" |
| Product manager | Rasha Sabry, Ahmed SharafEldeen | the line first (Pedia or Anti Infective), then its district managers, or "Any rep in the line" |

A vacant district is offered by its place, reading "No district manager". The per-line "Others"
buckets are never offered: they hold no reps.

### The extra step

- **Per day by default.** Step 3 opens with "District manager for this day". Both halves use it.
- **Per half on request.** Inside With a rep and Single visit, "Another district manager for this
  half" picks one for that half only; "Same as the day" goes back. Admin needs none.
- **Stored per half.** `phoenix_crm_manager_plan_slots.scope_dm_seat_id` / `scope_line_code`, both
  null on an Admin half and on every district manager's half. The day default is the screen's
  convenience, not a column.
- **Loaded per choice.** The board's GET takes `scope` (`dm:<seat>` or `line:<code>`) and answers with
  that district's reps, areas and rep half-days. A save answers in the scope the screen sends.

### Approval and HR

- **District managers are unchanged** — the seat chain, and never skipping the NSM after a regional
  manager.
- **Everyone else: "as today".** `legacyStyleApprovers` — the first approver is the manager his HR
  record names; when that is the CEO, or nobody, the CEO approves alone; otherwise the CEO approves
  second. Hany Saad → Ali Mohamed Ali → the CEO; each NSM → the CEO; Ahmed SharafEldeen → Rasha Sabry →
  the CEO; Rasha Sabry → Hossam Reda → the CEO. The week, the edit asks and the own-list removals all
  store the same pair, so #6032's two-step machinery is reused unchanged.
- **HR acknowledges by itself.** When the last approval lands on a non-district-manager week, the
  transition writes an `hr_acknowledged` event and stamps `hr_acknowledged_at` as `SYSTEM-AUTO-HR-ACK`,
  as the legacy plan does. A district manager's week never gets one — his own ruling for them.
- **The routes moved to `read`.** The CEO, the NSMs, the regional manager and the product managers
  hold `read` (and some `approve`) on Phoenix CRM, never `create`, so the ten manager-plan POST routes
  gate on `read` and the service narrows: `assertManagerPlanWriter` (a district manager still needs
  `create`) and the approver stored on the week or ask.

### Office, and the attendance day

Ali Mohamed Ali, Amr Mohamed Naguib, Rasha Sabry and Ahmed SharafEldeen are judged on "office days
only": the Day-by-Day Report counts only the days their plan marks Office. Office was the largest
legacy item for these managers (the NSMs: 59 of 120 half-days). So Admin offers **Office** to everyone
but a district manager (the database refuses it for one), and `attendance/plan-office-days.ts` reads
the approved halves of a regional or national manager who has switched: any Office half makes it an
office day; any other planned half makes it not one; a failed read is logged and judges nobody. A
product manager keeps filing the legacy form, so his attendance still reads that.

### What stays as it is

- **The no-weekly-plan deduction** still reads the legacy form only. Changing what it reads is a
  payroll decision for the owner, never taken in chat.
- **A product manager files both forms.** `plansManagerWeekHere` is always true for him, and the
  legacy form never refuses him.
- **A regional or national manager switches off the legacy form** once a live team sits below his
  seat, the way a district manager does once his own team is live.

### Readers

- **The Approvals Hub.** The district-manager feed keeps district managers only; the Company Plans
  feed gains everyone else's weeks, labelled by the real title; the CEO's pending count adds the weeks
  and asks at his step.
- **The Team tab.** A manager who plans a week and also reads others (an NSM reads the regional
  manager's week and his district managers') chooses among them with himself listed first
  (`managerPlanChoices`). Before this he read them as a "pick" reader; planning his own week would
  otherwise have hidden them.
- **The report** counts a rep's `product_manager` double visit that names a product manager, as it
  counts `manager_hr_id` and `senior_hr_id` for the others.
- **The calendars and Decided for me** read every writer through `server/manager-plan-readers.ts`;
  Office reads as the legacy "Office".

Migration `20261017213000` (staging and production, 17 Oct). Pinned in section 10 of
`tests/phoenix-crm-manager-plan.test.ts`.

## A vacant area: named, its list the previous rep's, and a visit there says where (2026-10-19)

His words, in chat on 19 Oct 2026: *"when a manager is planning or doing single visits make the vacant
areas appear named as areas — when he chooses the vacant area he is able to see the dr list of the
previous rep, so he can choose from the vacant area's list and make his plan or make single visits"*,
then *"if the area is vacant make the district manager obligatory either to fill the dr address by hand
or to capture location and the address, area and brick are auto filled — either this or this"*. Asked as
a multiple choice whether that binds the visit log, adding a customer to his own list, or both, he chose
**the visit log only**.

- **Measured that day on production:** 39 vacant rep territories. 18 still hold the previous rep's list
  on their seat (85 to 132 AM and PM customers each) — a list belongs to the seat, not the person; the
  other 21 hold none, and have no iReports360 list either. So nothing is copied: choosing a vacant area
  reads the list its seat still holds, and an area with none says so and offers Add a customer.
- **Named as an area, everywhere he picks one.** The plan board's single-visit "Area" choice and My single
  visits' new "Choose an area" both list the areas he plans in by area name, a vacant one marked
  "Vacant · the previous rep's list" (`managerAreaChoices`, `VACANT_AREA_NOTE`). Its customers read "The
  previous rep's list" where a rep's name would go, and the name search says the same.
- **My single visits opens on the areas.** "Log an unplanned customer" now shows the areas first; choosing
  one lists its customers with a search, a page at a time, each with Log this one. The name search stays
  beneath it.
- **The visit to a vacant area's customer needs one of two.** The log form shows Capture location — which
  fills in the address and says the area and brick it fell in, read by the same `locateInReach` that Add a
  customer uses — and an Address field to type by hand. Neither filled: refused, by the form, by the save
  (`vacantVisitPlaceError`) and by the database (`phoenix_crm_manager_visits_vacant_place`). Elsewhere the
  whole block stays optional (it is on every single visit since 20 Oct — "The place block" below).
  "Vacant" is read off the territory the customer is on on the visit day, never off the plan — a rep
  customer's seat, and since 20 Oct an own-list customer's `area_seat_id` too.
- **What the visit row keeps:** `in_vacant_territory`, the `address` he saw, and the `area_code`,
  `area_name`, `brick_id` and `brick_name` — from the capture, or (since 20 Oct) from the area and brick
  he chose, which win over it. Nothing is written to the rep's list: the vacant seat's customer record is
  untouched.
- **Adding a customer to Manager's own list is unchanged** — its address and brick stay optional.
- **What it recorded is shown back** (his multiple-choice answer the same day, "Show the recorded place").
  A logged vacant-area visit reads "Where the customer is", then the address, `Area:` and `Brick:`
  (`visitPlaceText`), under the customer on his Visits tab, planned or not, and under the customer
  in the actual-versus-planned report, a done single visit and a visit without a plan alike. A capture
  nothing could be read from says so. Since 20 Oct every single visit shows back what it recorded, not a
  vacant area's alone; one that recorded nothing still shows nothing. The
  unplanned card's "Vacant area" comes from the visit (`in_vacant_territory`), never from the territory
  today, so a seat filled since does not rewrite it.

Migration `20261019103745` (staging and production, 19 Oct; additive, the 6 visits already logged keep
`in_vacant_territory` false). Pinned at the end of `tests/phoenix-crm-manager-plan.test.ts`.

## The place block: the Add-a-customer screen's, on every single visit (2026-10-20)

He sent three screenshots of My single visits with "Log an unplanned customer" ringed, and wrote: *"in
district manager single visit unplanned the system asks for a location or address and their is no place
to write the address it should be as the screen when adding new customer is plans in singled visits deep
audit"*. Asked as a multiple choice how much of the Add-a-customer block to copy, he chose **the whole
block** — Capture location, Address, Area and Brick — on every single visit he logs.

**What his screenshots caught.** He chose the vacant area Menoufia 1, whose own line reads "Logging a
visit here needs the customer's address typed by hand, or Capture location". That area's seat holds no
list, so he picked the customer from **Manager's own list** underneath — and the form that opened showed
"Location · Optional. No photo is needed." and no Address box at all. The screen had asked him for an
address and then given him nowhere to write one.

**Why.** The Address box was drawn only when `logging.vacant`, and a customer of Manager's own list was
flatly `vacant: false` in all three places that answer the question: `ownLogging` on the screen,
`matchManagerCustomer`'s own-list branch, and `logManagerVisit`, which never looked at an own customer's
territory at all. His own list carries the area the customer is in (`area_seat_id`), so it can answer the
same question a rep customer's seat answers — and now does, in all three.

**What the block is.** The same fields, in the same order and with the same words, as
`manager-customer-form.tsx`:

- **Capture location**, which fills the address, selects the area and selects the brick, through the one
  `locateInReach` reading the save stores. It fills only what the capture read, and only what he left
  empty — his own typing or choosing wins over it.
- **Address**, typed by hand, 300 characters, opening on the address his own list already holds for that
  customer (a rep list's customer opens empty).
- **Area → Brick**, cascading drop-lists over the areas he plans in, the brick list that area's own.
  Choosing a new area empties the brick. Checked on the server by `resolveChosenPlace`, which is the same
  check Add a customer makes: an area outside his reach is refused, and so is a brick that is not of the
  area he chose.

**Required, still, only in a vacant area** — "one of the first two is needed" there, "optional" elsewhere,
and the heading says which. The refusal is unchanged (`vacantVisitPlaceError`, the save, and the database
CHECK).

**One seat per area.** `managerAreaChoices` lists one seat per area, while a customer sits on a rep seat,
so opening the area drop-list on the customer's own seat would have shown a blank area. `areaChoiceSeatOf`
maps a seat to the seat its area is listed under; the Visits tab sends it as `areaSeatId`, and a match
carries it too.

**Stored and shown back on every single visit.** `logManagerVisit` used to write `address: vacant ?
address : null` and nothing else, so a typed address outside a vacant area was thrown away silently. It
now stores the address, `area_code`, `area_name`, `brick_id` and `brick_name` for every visit, and
`visitPlaceText` (was `vacantVisitPlaceText`) prints what the visit recorded rather than only what a
vacant area's recorded. A visit that recorded nothing still prints nothing. **No migration:** the columns
and the `_address` CHECK are from `20261019103745`, and the `_vacant_place` CHECK only ever constrained a
vacant visit.

**Audited and left alone:** the territory Add-visit hand-over (`fileAsOwnSingleVisit`) always sends a
captured pin, so the place rule was already answered there; adding a customer to Manager's own list is
unchanged, by his 19 Oct ruling.

## His own single visits are also proof he worked (2026-10-19)

Asked, on 19 Oct 2026, whether a district manager's own single visit should become a record on the
Field Absence Calendar **and** in the no-activity engine behind the deduction, the owner answered
**"count it on both"** — explicitly leaving his report figures, KPIs, coverage and call rate untouched.

**The gap this closes.** Since 16 Oct a manager's own visit is written to `phoenix_crm_manager_visits`
and no longer to `phoenix_crm_visits`. That separation is the point of the table — no KPI, coverage,
call-rate, frequency or target reader may pick one up, so his own work never moves a rep's figures or a
territory's, and that half is unchanged. But nothing in that ruling was about whether he *worked*, and
the two questions shared one source: when the visit left the visits door it left the Field Absence
Calendar, the private calendar and the deduction engine with it.

**Measured on production, 19 Oct 2026.** Mina Farouk Nawar Rizkallah (B-116) and Mohamed Alaa Eleiwa
Abozaid (PD-0012) each spent the day on their own single visits and held **no other record at all** —
no row in the visits door, no day-activity row, no old-CRM row, no fingerprint punch, no filed vacation,
no business trip. Both were heading for "No Activity Recorded", which is exactly the exception the Daily
Deductions no-records connector adjudicates. All 12 rows in the table carry a canonical upper-case
`manager_hr_id`, so the person key is sound.

**One door, three readers.** `loadManagerOwnVisitDays` and `describeManagerOwnVisitDay` live in
`src/lib/phoenix-crm/server/manager-plan-readers.ts`, the adapter every screen outside Phoenix CRM
already reads his week through, and they stay the only way out of that table — a calendar, attendance
or deduction reader must never query it directly.

- **Field Absence Calendar** — `src/lib/field-absence/server/evidence.ts` reads it as its own source,
  settled with the rest under the `crm` label, whose wording now names it.
- **Private calendar** — `src/lib/private-calendar/manager-own-visit-items.ts`, wired into all three
  passes (workspace, company no-activity, day evidence) and into the single `field_visit` readiness
  flag. Best-effort like its siblings: a failed read can only ever add a flag, never remove one.
- **Deductions** — a third source in `selectProvenWorkedDays` / `loadProvenWorkedDays`
  (`src/lib/deductions/proven-worked-days.ts`), folded **last**, so a day a business trip already
  explains keeps the trip's reason line. Like the other two sources there it only ever removes a day
  from a charge, and the loader fails closed.

Pinned by `tests/deductions-phoenix-work-evidence.test.ts` (the fold, and a source fingerprint on the
calendar's `addSeen` line) and `tests/field-absence-calendar.test.ts`.

## A manager's day: plan, actual, and the detail of every visit

Owner, 2026-10-20: the manager's visits were a bare count (*"I want full details, name, address, brick, type,
AM/PM, when, single, double, every single detail"*), then *"show a premium table, plan vs actual vs detail per
visit in actual"*. The day is one table, drawn by `ManagerPlanActualTable`
(`src/components/phoenix-crm/manager-plan-actual-table.tsx`) on the manager's own page
(`/employee-portals/field-crm/manager-day/<seat>/<day>`, `manager-day-detail.ts`) and in the private calendar's
manager entry (`manager-own-visit-items.ts`, `ManagerPlanActual`).

- **One row per planned customer, one per visit nobody planned** (`buildPlanVsActual`,
  `src/lib/phoenix-crm/manager-day-plan.ts`). ONE table, four columns (owner, 2026-10-20: *"one table: plan a
  header, then actual status, matching or not, then area and brick of the actual, then address and time"*): **Plan**
  (the half, the kind, the planned customer) · **Actual status** (done / not done / still open / not on the plan,
  with a sentence, and the customer who was visited) · **Area · Brick** of the actual visit · **Address · Time**. Under
  each row one spanning line carries the rest of the record: territory, who came along, products, location pin,
  comment.
- **The verdict is the weekly report's** (`computeManagerReports`, read through `loadManagerDayPlans` on the
  private calendar and directly on the manager's page). The table sets that verdict beside the visit that proves
  it; it never re-derives done / not done.
- **Matching**: by customer key (`c:<id>` on a rep's list, `m:<id>` on his own — `planCustomerKey`), and by
  source: a with-a-rep row is answered only by a rep's visit that names him, a single-visit row only by his own
  visit. A visit that answers no row is listed as "Not on the plan".
- **A week that was never sent is not judged**: its rows read "No plan sent" and the visits are still listed in
  full. **A plan that fails to load is said** (`planUnread`), never shown as "no plan"; on the private calendar it
  leaves the visits standing.
- **Layout**: a fixed-layout table with named column widths when the PANEL is at least 720px wide (`@container`,
  because the private calendar's day sits in a narrow column on a wide desktop), cards below that. Square edges,
  nothing truncated, an Arabic name keeps its own direction.
- **The address is the DETAILS', never the calendar's** (owner, 2026-10-20: *"do not show address in the private
  calendar itself, show area/brick, and in details show address"*). The private calendar's own chip lines
  (`managerVisitChipLine`) print the brick and the area (`managerVisitAreaLines`); the table, the cards and the
  detail text (`managerVisitWhereLines`, `managerVisitLine`) print the street address first.
- **The day slot shows the RECORD, of every type, and never the plan** (owner, 2026-10-20: *"on the day slot itself
  never show plan, show actual only … not only visits, show actual record of any type"*). The month cell and the
  phone markers draw every entry but an approved plan (`isRecordedEntry` in `private-calendar.tsx`: attendance,
  leave, holiday, visits, other CRM). The plan reads in the day's detail below, inside the table, and a manager's
  own half-day plan cards are left out there (`withoutPlanDrawnByATable`) because the table already draws them.
  A person with no table keeps his plan entry in the detail.
- **Cost**: the plan is read only when the visits are (the opt-in detail passes), one report per week the window
  touches for all the managers at once. The company-wide pass the Daily Deductions connector adjudicates stays a
  count and reads neither.

Pinned by `tests/phoenix-crm-manager-visit-details.test.ts`.
