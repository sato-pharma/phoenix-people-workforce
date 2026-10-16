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
  area's rep lists, from **Manager's own list**, or a newly typed customer.

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
| `phoenix_crm_manager_customers` | Manager's own list, with an optional pin and the removal fields. |
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
- **Second stage, only for Hany Saad's DMs:** Ali Mohamed Ali. This chain is shared with the legacy
  plan through `src/lib/workforce/plan-second-approver.ts`.
- **No other stage.** There is no HR acknowledgement and no SFE step.
- **Where it is decided:** the portal Approvals Hub. The choices are Approve, Return the week and
  Return one day.
- **The Administrator** may act in place of any holder at any stage. The decision is recorded and shown
  as "by the Administrator".

The Hub reads the queue through `server/manager-plan-queue.ts`, merged once into
`getPlanApprovalsForResponder`. That one merge covers the pending count, the badge, Needs You, the
overdue check and the bell. The same rows are merged separately into My Requests, History, the CEO's
feed and Ali's feed.

## What counts as the actual

| Half-day kind | Judged by |
|---|---|
| With a rep | The double or chain visits the **rep** logs that name him (`phoenix_crm_report_manager_visits`). Ticking a rep is not itself a double visit. |
| Single visit | His own `phoenix_crm_manager_visits`. |
| Admin | Not checkable. |

His own single visits count **only in his own report**. Nothing adds them to a rep's figures or a
territory KPI. For the same reason, the old "My own visit" option is closed for anyone holding a DM or
acting-DM seat. The 25 visits already logged stay as they were.

The report is read by:

- the DM himself;
- his RSM and his NSM;
- the SFE Manager, the CEO and the Administrator.

A rep can never read it.

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
live. When it is true:

- **The legacy write paths refuse him.** `createEmployeePlan` and `updateEmployeePlan` refuse, and
  `canSubmitPlans` is false.
- **His navigation changes.** He loses the Plans tab and keeps the Planning Calendar.
- **The old address redirects.** `/employee-portals/plans` without `?plan=` sends him to the Phoenix
  CRM Plan tab. A `?plan=` deep link still opens an old plan.

Plans already filed stay readable and decidable.

Mohamed Alaa Eleiwa switches over by himself the day his team starts. Nosiba Salah files both her
rep week and her manager week; a switch on the Plan tab chooses between "My territory" and "My
district".

## Test rows

`scripts/phoenix-crm-clear-test-rows.ts` sweeps the seven tables. Two of them must be cleared before
`phoenix_crm_customers`, because they reference it with no cascade: `manager_plan_customers` and
`manager_visits`. Three of the tables carry no `is_test` flag and are reached through the plan header.
`docs/phoenix-crm-test-rows.md` has the foreign-key graph.
