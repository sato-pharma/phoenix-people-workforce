# The Phoenix CRM switchover — the account behind three CRM hooks

The hooks are in `.claude/rules/crm.md`. This file holds their evidence, so the rules file stays a
set of cues and nothing is charged to a session that is not working in the CRM.

Owner's instruction, 2026-10-07: *"every single report that was pulling data from the CRM must stop
pulling data from the Go Live teams and pull from the Phoenix CRM"*, and, approving the plan: *"I
don't want the old data to be deleted … they find everything they did as it is, and the new visits
are populating under them as if they did not happen any change in them … nothing show that a drop
happened."*

---

## 1. The doctor list follows its own team's start — and the fifth pass that writes it in

### The three places that ask, and why they move together

`crm_cutover.cutover_date` is NULL on production and a team start never sets it. Asking it alone
failed in **opposite directions** in the three places that ask:

| Place | How it failed |
| --- | --- |
| `crm_contact_list_change_apply` | failed **closed** — refused every change |
| `crm_contact_master_refresh` | failed **open** — kept re-deriving a started rep's list from the vendor |
| `contact-lists/service.ts` | refused **everyone** in `assertInForce`, for two days after the database was fixed |

That third one is why the SFE Manager's direct drop — his rule since 2026-09-14 — could not be made
at all, and **0 list changes were ever filed on production.**

One rule instead: `doctorListOwnedByPhoenix` = his team's start OR a global date, mirroring
`v_phoenix_owns`, asked **per rep** by every write and read path.

**All four vendor assignment passes skip a started rep — the INSERT above all.** A removed doctor has
no open row, so `not exists (…)` is true and the vendor re-opens him.

Migration `20261004120000`, pinned by `tests/doctor-lists-follow-team-starts.test.ts`.

### The fifth pass — `20261007200000`

Skipping the vendor was only half the job: a started rep's rows stayed frozen exactly as iReports360
last left them, and **Esraa Ibrahim Saad showed 0 doctors against 163 in Phoenix CRM.**

The fifth pass writes each started rep's Phoenix list into **the same table**,
`crm_contact_assignments`, as a dated period:

- the vendor period is closed at `counted_from - 1`
- the Phoenix period is opened at `counted_from`
- **nothing is deleted**

So all ten readers and all three PostgREST contact embeds stay correct with no TypeScript change, and
a month already computed still reads the list exactly as it stood. There is still **no**
`crm_contact_assignments_unified` — building one would move the KPI denominators.

**The guard that matters: a rep with NO Phoenix list KEEPS his vendor list.** The hand-over is driven
by the LIST, never by the started set. Three of the eighteen started people are district managers who
hold no list, and **Nermeen Salah's 25 doctors and Mahmoud ElHassanin's 1** would otherwise have gone
to zero. The refresh's own counters say it: 1,997 rows frozen, 1,971 handed over, and the 26
difference is those three people.

It owns only `source = 'phoenix_crm'` rows and never touches a `source = 'phoenix'` one — that is one
approved human decision. And `crm_contact_list_change_apply` now writes an approved removal or
regrade into `phoenix_crm_customers` as well, or the next hourly run would undo it.

Measured on production after it was applied: 12,191 → 14,362 assignment rows, 2,171 periods opened,
1,971 closed, **0 deleted**; all 12,191 vendor rows still present.

Pinned by `tests/doctor-lists-everywhere.test.ts`.

---

## 2. The visits door carries two partner slots

### What was wrong

Slot 1 was filled from `manager_hr_id` **alone**, which is NULL on a `product_manager` visit — so the
visit carried nobody and the day read as a day the rep did not work. That is **18 of Ahmed
SharafEldeen's 18 visits of 6–7 October**, and Rasha Sabry Khalifa and Hany Saad Omar with no October
rows at all. A `chain` visit lost its second person entirely.

### The shape

Slot 1 is now `coalesce(manager, product_manager, senior)`, which repairs every existing reader where
it stands, with no new column. `double2_crm_id` / `double2_name` / `double2_hr_id` are **appended** —
a `create or replace view` accepts a new column only at the END, and `crm_visits_checkin_flags`
depends on this view. They are NULL on both vendor branches, and every partner expression keeps its
`p.rep_hr_id is not null` gate, because a DM's OWN visit has no rep.

**This is parity, not new policy:** iReports360's own partner slot has carried Product Managers, a
Group Product Manager, an RSM, a Training Manager and a Marketing Manager since 1 September.

**Two slots carry everyone,** measured over all 743 real visits: no row sets all three people, and
`senior_hr_id` never appears without `manager_hr_id`.

`buildParticipantCrmIdOrFilter`, `buildParticipantHrIdOrFilter` and the `doubleHrIds` filter ask BOTH
slots. `doubleOnly` and `requireDoubleHrId` need no second arm and must not be given one: slot 2 can
never be filled while slot 1 is empty.

Migration `20261007193000`, pinned by `tests/phoenix-crm-visits-everywhere.test.ts`.

### The half that is in TypeScript

**Widening the PostgREST filter alone fixes nothing.** `doubleHrIds` already returns the slot-2 row,
and a reader that then decides "whose visit is this" against one partner column throws it away again
— which is the owner's reported sentence, in code: the day he spent in the field reads as a day he
did not work. `rep-day.ts` additionally spelled its own agent-or-one-partner pair out by hand, so the
slot-2 person's own day came back empty.

**Swept — the presence and money class.** Pinned as a named list in
`tests/crm-participant-filter.test.ts`:

- `crm/rep-day.ts` — the shared builder, plus `buildRepDayResult`'s own "is this him" test
- `attendance/crm-day-maps.ts` — the day map, whose own comment says "either role means the employee was genuinely present"
- `company-activity-report/crm-detail.ts`
- `business-review/sources/visits.ts` and `sources/field-link.ts` — these credit a RIDE
- `deductions/connectors/dsm-no-record.ts`, `holiday-bridge.ts`, `crm.ts` — **a manager read as absent here is a manager the month CHARGES**

`crm/visit-workload.ts` deliberately needs nothing: its role test is
`submitter === self ? "agent" : "partner"`, so slot 2 is already "partner".

**Still one-slot.** Each of these changes a reported COUNT, so each ships with the second partner's
NAME beside the credit — that is the layout half, and it needs a browser measurement:

`double-visit-analytics/service.ts` + `audit-export.ts` · `employee-360/service.ts` +
`deep-service.ts` · `probation/intelligence/dv-source.ts` · `weekly-planning/plan-adherence-data.ts` ·
`employee-portal/nsm-crm-compliance.ts` + `early-birds/collect.ts` ·
`field-workforce-compliance/ireports360-source.ts` · `private-calendar/field-visits.ts` ·
`reconciliation/checks/crm-sales.ts` · `crm/master.ts` · `crm/rep-visits.ts` ·
`field-activity/report.ts`.

**The settled answer for all of them: a chain visit credits BOTH managers.** Each really gave that
ride, and no double count is possible — slot 1 is `coalesce(manager, product_manager, senior)`, so
the two slots never hold the same person. Each reader must SELECT `double2_hr_id` as well as read it;
one without the other is silently `undefined`.

**The whole exposure is bounded:** 10 visits on production have ever carried a second partner — two
people, 6–7 October 2026.

### Measured, before and after, on production

| | Before | After |
| --- | --- | --- |
| Ahmed SharafEldeen (B-155), October | 6 rows, all 4 Oct | 24 rows across 3 working days |
| Rasha Sabry Khalifa (A-8), her own day | 0 | 6 |
| Hany Saad Omar (PD-0001), his own day | 0 | 4 |
| Rasha / Hany, days the attendance map calls worked | 71 / 44 | 72 / 45 |
| Ahmed, same | 77 | 77 (unchanged — he is the agent) |

`deductions_candidates` held 2,081 rows over three months with **2026-09** as its latest month when
this shipped, and neither Rasha nor Hany had a candidate row in any CRM category from September on —
so this landed before the first month that could have charged either of them.

---

## 3. A Phoenix-born doctor answers to `own_contact_crm_id`

**923 of 12,574** Phoenix customers have no vendor id, and every per-doctor report keys on one. **60
real visits** were reaching the doors with a NULL contact and silently vanishing from coverage,
plan-vs-actual, Employee 360 and the brick punch-list.

The range is `crm_contacts_phoenix_id_seq` (**1,000,000,000–2,000,000,000**), which migration
`20260914020000` reserved for exactly this.

**Never a negative contact id.** It breaks `crm_contacts_real_contact`,
`direct_order_pharmacies_crm_contact_id_positive`, and
`ireports360_crm_customer_brick_resolutions.crm_contact_id`, which is `integer` and answers
`22003 numeric field overflow` — turning a blank into an error.

**All three doors emit the same `coalesce(reference_contact_crm_id, own_contact_crm_id)`,** and they
are pinned EQUAL to each other: a visit carrying an id against a plan that carries none reads
**MISSED**, which is worse than a blank.

A `before update of reference_contact_crm_id` trigger
(`phoenix_crm_customers_no_late_reference`) refuses to re-point a customer who has already carried his
own id into a report, so a month somebody has already read can never be restated. Its refusal
`phoenix_crm:customer_already_has_own_contact_id` has its own sentence in `REFUSALS`.

The hourly refresh gives each one its `crm_contacts` name row with `source = 'phoenix'` — the only
value that CHECK allows, `'phoenix_crm'` is rejected — and never overwrites a name the vendor already
carries.
