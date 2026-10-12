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

**The ruling — one visit for the rep, in BOTH managers' records** (owner, 2026-10-08, in his words:
"the rep submits the chain visit and chooses, for example, two managers; it is counted one visit for
the rep and for the two managers — one visit for the three, so the three have this visit in their
records, but the one who submitted is the medical rep").

- **The rep's side counts the ROW, once.** His visits, his double visits received, a company total
  and a rep's Employee 360 never count a chain visit twice.
- **Every manager-side figure counts each manager on it, the second exactly like the first.**
  `double-visit-analytics/chain-visitors.ts` holds the one mechanism: `perDoubleVisitorRows` hands
  each manager his own view of the row (himself in slot 1), so every reader written for slot 1 counts
  slot 2 unchanged; `keepDoubleVisitors` lets a scope or an allow-list take ONE manager off a row
  without touching the other's credit or the rep's visit.
- **Where it reaches:** Double Visit Analytics (given totals, days, the leaderboard, the manager-rep
  pairs, the log and report filters, the portal focus), the coaching audit (the second coach has his
  own tab), Employee 360 (credited to both, received once), the private calendar (a performed chain
  day for each manager), and the probation DV-Days (each manager his
  own day — migration `20261008141330` moved `probation_dv_visits` to UNIQUE (`crm_visit_id`,
  `dv_day_id`) so the second day keeps its visits). Field Activity, compliance, the first-visit board,
  plan adherence, the day maps and the deduction connectors already credited both slots.
- **The ruled consequence:** the leaderboard's sum now exceeds the KPI total by exactly the number of
  chain visits. That is his ruling, not drift — the downward-scope test's "total equals the
  leaderboard sum" holds only for a board with no chain visit on it.
- **Not extended, deliberately:** the outstation trip workload evidence
  (`getDoubleVisitExpenseWorkloadEvidence`) still reads slot 1 only — money is decided on it, and the
  ruling was not given for it.
- **Left as it is:** `reconciliation/checks/crm-sales.ts` — its left side reads `ireports360_visits`,
  which has one partner column. And the vendor's OWN chains, which iReports360 split into two rows,
  keep their old history.

Pinned by `tests/chain-visit-one-visit-both-managers.test.ts`, `tests/probation-dv-detection.test.ts`
and `tests/probation-dv-sync.test.ts`. Each reader must SELECT `double2_hr_id` as well as read it;
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

## A doctor added twice stopped the hourly refresh for a day

Found 2026-10-12. From Sun 11 Oct 15:00 Cairo until it was fixed, `crm_contact_master_refresh` aborted ten to
thirteen times an hour with `duplicate key value violates unique constraint "crm_contact_assignments_open_uidx"`.
It runs as ONE transaction, so every abort rolled back the vendor passes, the region and brick resolution and the
Phoenix fifth pass together: nobody's doctor list refreshed for about 26 hours. Earlier occurrences were sporadic
(10 Oct 11:00, 14:00, 21:00).

**Why four static checks found nothing.** The collision exists only inside the run — after the rollback no
colliding row persists, so every query of committed state came back empty. What found it was running the function
inside a `DO` block that catches `unique_violation`, reads `pg_exception_detail` and `pg_exception_context`,
and always ends in a `RAISE EXCEPTION` so nothing is kept:

    Key (contact_crm_id, agent_crm_id, list_type)=(1000038395, 1542, PM) already exists
    at the insert in step 5b

**The cause.** A rep added a doctor on 10 Oct (own contact id 1000038395), and on 11 Oct added him again BY
REFERENCE to the first (reference 1000038395, own id 1000038463). Two live customer rows, one doctor. The unique
key under `crm_contact_assignments` is the doctor and the rep's CRM account, not the customer, and the fifth
pass was written as if a doctor were one row: its source was `select distinct` over a set that includes
`grade` and `starts_on`, so two rows differing by creation day both survived and 5b inserted one key twice.
Measured the same day: 158 doctor/list keys held more than one live customer row, 140 of them differing in grade or
creation day — the next one would have aborted the run as well. 28 keys held a dropped and a live row, which 5b
opened and 5c closed again inside the same run.

**The fix** (migration `20261012184500`). The fifth pass collapses `phoenix_crm_customers` to one row per
(rep, doctor, list) before 5b-5e touch it: a live row beats a dropped one, active beats pending, the earliest start
wins. 5b also skips a key an open row already holds under another hr id, because the index is on
`agent_crm_id`. Proven on production inside one transaction that was rolled back: the old function failed with
the same key; the new one ran, opened 135 periods, closed 148, touched 4,135, and a second run changed nothing.

**Not fixed here.** The add path that lets a rep add a doctor he already has. The refresh now holds whatever the
table contains; the duplicates themselves still sit on the integrity board.

**Logs.** `refreshCrmContactMaster` kept only `error.message`, so the line said which constraint and never which
doctor. `describeContactMasterError` now adds the PostgREST `code`, `details` and `hint`.

## The signboard read waited twice its budget

`PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS` is 8 s, and every signboard timeout between 11 and 12 Oct landed at 16.4 s.
`OPENAI_MAX_RETRIES` is 1 and the SDK retries a timeout with a fresh copy of the same timeout. `readSigns` now
passes `maxRetries: 0` (new optional parameter on `createOpenAiResponseText`), because the `timeoutMs` it hands
over is the time left on that check's deadline. A timeout still returns `unjudged("call_failed")` — the rep is
never held for it.
