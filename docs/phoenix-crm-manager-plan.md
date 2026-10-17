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
  area's rep lists, from **Manager's own list**, or a newly typed customer. A customer he adds must carry
  a **name, speciality and phone** and an **address, brick and area**: he types the last three, or presses
  **Capture location** and the capture fills them in (he can still correct them) — owner, 2026-10-17. The
  add refuses a customer short of any of them.

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
| `phoenix_crm_manager_customers` | Manager's own list: the address and brick (typed, or from the pin, in `pin_address` / `pin_brick_name`; a row with no `pin_lat` was typed), an optional pin and the removal fields. |
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

Owner, 2026-10-17: a district sales manager may not submit more than two days of single visits in a week,
counted as **four half-days in any mix** (his answer to how the halves add up was "four halves or 2 full
days"), and the limit covers **the visits he logs** as well as his plan.

- **Planning.** `saveManagerPlanSlot` refuses a Single visit half when the week already holds four other
  single-visit half-days. Re-saving a half he already planned as a single visit is no new half-day.
- **Logging.** `logManagerVisit` refuses an unplanned visit that would open a fifth half-day. A planned
  visit answers a half-day the plan already holds, so it is never refused. An unplanned visit falls in the
  morning or the afternoon of the Cairo time it was logged, before noon being the morning.
- **Who.** The district manager only. A regional, national or product manager's single visits are not
  limited.
- **On screen.** The Single visit part tells a district manager the limit and how many of the four
  half-days the week holds.
- **Where it lives.** `server/manager-single-visit-cap.ts` counts; the rule is
  `dmSingleVisitCapError` in `manager-plan-rules.ts`. There is no database constraint, so two saves sent
  at the same instant could both pass the count.

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
