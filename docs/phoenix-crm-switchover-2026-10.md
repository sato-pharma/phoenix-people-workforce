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
value that CHECK allows, `'phoenix_crm'` is rejected. Until 2026-10-22 it never overwrote a name the
vendor already carried; since then Phoenix's name, speciality and phone win (see "Phoenix is the source
of trust" below).

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

## A doctor the system added twice

Asked 2026-10-12: "stop a rep adding a doctor who is already on his list". The refresh outage above was the
symptom; this is the cause of the second row.

**Who made it.** Not the rep. On seat SEAT-AIF-REP-CA2 a rep added a doctor on 10 Oct (own id 1000038395, origin
`new`). The next morning a second row existed: reference 1000038395, own id 1000038463, origin `reference`,
status `pending`, created by the system. The chain, read from the live definitions:

1. The hourly refresh (fifth pass) gives a started rep's Phoenix list as assignments keyed on
   `coalesce(reference_contact_crm_id, own_contact_crm_id)`, so the doctor he added is an assignment under his OWN id.
2. `phoenix_crm_seat_reference` found the customer behind an entry by `reference_contact_crm_id` alone. For the
   doctor the rep added, that column is NULL, so the entry came back with no customer: "carried over, not minted yet".
3. `phoenix_crm_ensure_reference_customers` runs on every read of the list, the planner and the visit form, and
   mints a pending reference row for every entry with no customer. It minted the copy.

The unique index `(seat_id, reference_contact_crm_id, is_test)` could not stop it: the original's reference id is
NULL and the copy's is the original's OWN id, which sits in a different column.

**The fix** (migration `20261012200000`). `phoenix_crm_seat_reference` matches either id and returns one customer per
entry (live beats dropped, active beats pending, earliest wins). The minting function also skips a contact that is a
customer's own id. A BEFORE INSERT trigger `phoenix_crm_customers_no_double_add` refuses a row whose reference id is
another customer's own id on the same seat (`doctor_already_on_list`, a 409 with words in `db.ts`).

**Proven on production, inside a block that always rolled back.** 10,767 reference entries before and 10,767 after.
13 entries that had no customer but an own id (the ones the next read would have copied) resolve to their own customer
afterwards. 200 entries change their customer or state, all of them seats that already held a pair: the reference list
now reads the live row instead of the copy. SEAT-AIF-REP-CA2 contact 1000038395 now resolves to the original, validated.
The trigger itself could not be probed on production or staging (the insert probe was declined), so it is pinned by
`tests/phoenix-crm-doctor-once.test.ts` only.

**Not done.** The 158 pairs already on production are untouched (no merge, no drop, no unique index over the doctor).
Which row of a pair keeps the visits is the owner's decision. The rep's `new` door already refuses a same-name customer
(`same_name`, 409) unless the rep confirms it is a different person; that confirmation was left as it is.

## The customer table was read twice, and a doctor added between the reads aborted the run

`phoenix-crm-contact-lists` raised eight `scheduled_job_stranded` alerts between 25 September and 15 October 2026 —
a slice that died mid-run, and a later slice or run that succeeded. The 15 October 12:59 Cairo alert, in full:

```
in-process slice 5/12: 7 agent(s) attempted, 562 row(s) upserted, contact master refresh FAILED:
insert or update on table "crm_contact_assignments" violates foreign key constraint
"crm_contact_assignments_contact_crm_id_fkey" [code 23503]
Key (contact_crm_id)=(1000040482) is not present in table "crm_contacts".
```

**The contact was never missing data,** which is what makes this one read as impossible. Read on production
`ozucdzovmcqvepbozvqf` the same afternoon:

| Table | Row | Created (Cairo) |
| --- | --- | --- |
| `phoenix_crm_customers` | `own_contact_crm_id` 1000040482, seat `SEAT-PED-REP-GZ7`, status `pending`, not test | **12:59:20.549** |
| `crm_contacts` | `contact_crm_id` 1000040482, `source = 'phoenix'` | **13:04:47.651** |

The rep saved the doctor at 12:59:20 — **while the 12:59 run was between its two reads of
`public.phoenix_crm_customers`.** `crm_contact_master_refresh` is plpgsql, so the whole call is one transaction at
READ COMMITTED, where **every statement takes its own fresh snapshot**. It read the customer table twice:

1. the name-row pass, near the top, which creates a Phoenix-born doctor's `crm_contacts` row;
2. the fifth pass's `create temporary table crm_refresh_phoenix_lists_all as select …`, near the bottom, which
   feeds 5b's insert into `crm_contact_assignments`.

The name pass had already run and could not see the new customer. The fifth pass, a later statement with a later
snapshot, could. 5b then inserted an assignment for a contact with no row in `crm_contacts`, and the foreign key took
the whole transaction down — every rep in the company, not just that one. The contact row landed five minutes later
from the NEXT run's name pass, which is why a retry is always clean and why the row is present by the time anyone goes
to look.

**Every doctor a rep adds is exposed.** Nothing on the add path writes `crm_contacts` — this function is its only
writer — and the window is the whole span between the two passes, with the activity pass, the four vendor passes and
the brick and region passes inside it. Measured the same day, the four Phoenix-born doctors created on 15 October each
waited a mean 312 s (max 327 s) for their contact row: the next run, never their own.

**The fix** (migration `20261015132445`). One statement reads `public.phoenix_crm_customers` into
`pg_temp.crm_refresh_phoenix_customers`, and both passes read that snapshot. Three textual edits, nothing else: no
filter, no ordering and no written value changes, and the recreated body is `20261012184500`'s byte for byte otherwise
(`md5(prosrc) = 34220e8603660375d75fb06bb58d116e` before, `7194a3929cef15051f541d5bab6ee875` after). The fifth pass's
set is now a subset of the set the name pass covered, **by construction**, so the foreign key cannot fail on a contact
the same run is about to create. A customer committed mid-run is in neither pass, and the next run five minutes later
takes it whole — contact row and assignment in one transaction.

**Pinned by** `tests/crm-contact-master.test.ts` block 9, which reads the NEWEST migration that redefines the function
(not a fixed filename, because the defect returns the moment a future definition reads the table twice again) and
asserts: exactly one read of `public.phoenix_crm_customers`, that the one read is the snapshot build with both filters,
that each pass reads `pg_temp.crm_refresh_phoenix_customers` inside its own statement, and that the order is snapshot →
name rows → assignments. Break-tested: reverting the two reads to `public.` fails the headline assertion with `3 !== 1`.

**Staging, applied and verified** (`cifwmndunmlxjhyjugxa`, 15 Oct): `md5(prosrc) = 7194a3929cef15051f541d5bab6ee875`,
`prosecdef = false`, `proconfig = {search_path=public}`, ledger row `20261015103443`, and a real
`crm_contact_master_refresh(false)` returned clean — 409 Phoenix periods opened, 462 vendor handovers, 18,617 contacts.

**Production, applied and verified** (`ozucdzovmcqvepbozvqf`, 15 Oct, **20:14 Cairo**). Both doors AGENTS.md §8
pre-authorizes had refused it — `supabase-production` `apply_migration` answered `{"status":"declined"}` and the
account connector `mcp__b345e47e-…` answered `MCP error -32600: You do not have permission to perform this action`
(it had just applied the same SQL to staging) — so it went the remaining route,
`node scripts/apply-sql-file.mjs <file> production`, a direct Postgres connection. The three previous versions of this
function reached production the same way, and like them this one wrote **no ledger row**: production's ledger holds
`20261015133143` and `20261015155642` but nothing for `20261015132445`, so the file is carried in
`ACKNOWLEDGED_EXCEPTIONS` (`scripts/lib/migration-inventory.ts`) with the digest below as its evidence — a missing row
is answered by a digest and an evidenced entry, never by a ledger write.

**Verified by digest, not by presence** (read 15 Oct 20:22:49 Cairo): `md5(pg_proc.prosrc)` for
`public.crm_contact_master_refresh` is `7194a3929cef15051f541d5bab6ee875` over 29,236 chars — equal to md5 of this
file's own dollar-quoted body, where the superseded `20261012184500` body digested `34220e8603660375d75fb06bb58d116e`.
`prosecdef = false` and `proconfig = {search_path=public}`, matching staging. This file is the function's LAST definer,
so presence could not have answered it: `create or replace` means an older generation satisfies any catalog probe, and
another session re-applying an earlier migration would revert the body while leaving the object exactly as present.

**The hourly job then ran clean on the new body.** `public.job_heartbeats` for `phoenix-crm-contact-lists`, read
15 Oct 20:22:49 Cairo: `last_outcome = success`, `last_success_at` **20:18:14 Cairo** — four minutes after the apply,
so the first run on the new body — `last_detail` `in-process slice 4/12: 7 agent(s) attempted, 697 row(s) upserted`.
The last success before the apply was **20:12:28**, on the old body. `last_fail_at` is still **15 Oct 12:59:21 Cairo**,
the `23503` abort this section opens with. That row carries ONE failure stamp and rewrites it on every failure, so an
unmoved `last_fail_at` means no failure since the apply at all — not a failure that a later success papered over.

## A rep with no vendor list

Shahd Mohamed Elsayed Ghoneim (`PD-0026`, seat `SEAT-PED-REP-AB4`, Pedia Behira 1) had an **empty doctor droplist**,
reported by the owner on 15 October 2026. Read on production `ozucdzovmcqvepbozvqf` the same evening:

| Fact | Reading |
| --- | --- |
| `crm_contact_assignments` for `PD-0026` | **0 rows, ever** — the table every list screen reads |
| `phoenix_crm_customers` on her seat | **112** real rows, built 11 Oct 2026, all `pending` |
| `employees` | `crm_id` NULL, `crm_username` NULL — **no iReports360 account at all** |
| `phoenix_crm_team_starts` | no row for `SEAT-PED-DM-AB` — **her team has not started** |
| Her two peers on that same unstarted team | `B-177` 183 open rows, `PD-0005` 180 — both from `ireports360` |
| Her seat's predecessor (Mahmoud Eltanany, resigned 10 Aug) | 0 assignments — **no vendor list to inherit** |

So **both** sources wrote her nothing. The four vendor passes can only key on an iReports360 account, which she does
not have; the fifth pass covers a rep whose own team has started, which hers has not. Her peers see a list only
because each carries a vendor account. Nine more October hires were in exactly that state — `AI-0026/27/28`,
`CN-0010`, `PD-0021/24/25/27` and her — **1,223 built list rows between them, reaching no screen**: Rep Doctor Lists,
the Reps List doctor column, the rep KPI coverage and frequency denominators, Employee 360's doctor list and the
direct-order venue picker all read `crm_contact_assignments`. `CN-0009` looked identical and was not in the hole: her
team HAS started, so the fifth pass already covered her.

**The owner's ruling, 15 October 2026**, asked as the choice between extending the hand-over rule, starting her team,
and a one-off write for her alone: *"Everyone in Pedia that logged yesterday and in, tried in, in, in, in validation
in Makram Abed, those were new hired and we were in training. So all those should be opened for them, the Phoenix
now."* The rule, for every rep in that state, on every line.

**The rule.** The hand-over is driven by the LIST, in both directions: a rep with no Phoenix list keeps his vendor list
(§1), and a rep with no VENDOR list gets his Phoenix list without waiting for his team. A rep who has **both** still
waits for his team's start — that is what keeps a team's counting source the owner's own Start click.

**The shape — `20261015215500_a_vendorless_reps_phoenix_list_opens.sql`.** One new door, `phoenix_crm_doctor_list_reps()`
= `phoenix_crm_started_team_reps()` ∪ `phoenix_crm_list_only_reps()`, and the three readers of the list rule ask it:
the refresh's fifth pass (and the freeze set that keeps the vendor off those rows), `crm_contact_list_change_apply`'s
`v_phoenix_owns`, and the service's `listOwnership` through `loadDoctorListRepWindows`. `phoenix_crm_list_only_reps()`
requires all four: a real non-test Phoenix list on the seat, no numeric `crm_id` and no `crm_username`, no open
`source = 'ireports360'` row, and **no window in the started set** — returning a started rep there too would offer the
fifth pass a second, earlier window and backdate his periods to the day his list was built (`CN-0009`'s list predates
her team's start by five days). `counted_from` is the later of his occupancy day and the list's Cairo build day.

🔴 **The visits door is untouched, and that is the point.** `phoenix_crm_started_team_reps()` is unchanged, so
everything that decides whether somebody *worked* — the four unified views, field-work compliance and its
payroll-deduction recommendation, the CRM no-activity / DSM no-record / holiday-bridge connectors, the attendance day
maps, the KPI boards, Early Birds — counts exactly whom it counted before. This moved the doctor list and nothing else.

**Applied and measured on production, 15 October 2026 22:07 Cairo**, through the standing route
(`PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs … production`, because
both MCP doors refuse a `create or replace function` whose body merely contains a `delete` or a `drop table pg_temp.…`).
All four function bodies read back md5-equal to the file: `phoenix_crm_list_only_reps`
`ce348bea5b05175d6298dc7f79417820`, `phoenix_crm_doctor_list_reps` `6d63cbefda825947e76dccfe6dd7a5d8`,
`crm_contact_master_refresh` `f099c54bdeed10ee8b8756968a972c73` (pre-image `7194a3929cef15051f541d5bab6ee875`) and
`crm_contact_list_change_apply` `40d256cff9fb976d6ba1799f02bedade` (pre-image `b5a5a2ab9ec3a9ef14f6bff322c0f445`). The
door then returned exactly the nine reps, and one `select public.crm_contact_master_refresh()` answered
**`phoenixAssignmentsOpened` 1223**, with `assignmentsClosed` 0, `assignmentsDiscarded` 0 and
`phoenixVendorHandedOver` 0 — nine lists opened, nobody else's row touched. Shahd's own list is **104 PM + 8 AM**,
`source = 'phoenix_crm'`, open from **11 October 2026**. It writes no ledger row, so the file is carried in
`ACKNOWLEDGED_EXCEPTIONS` with those digests as its evidence.

## Phoenix wins the day — for a medical rep

**Owner, 2026-10-16.** All 21 teams are started (the 11 not yet running from Saturday 10 October; Mohamed Eleiwa's team
from 17 October, because it was started first). The 2 October rule — a started team's iReports360 visits are ignored from
its start — is narrowed: *"once you see an entry for a medical rep in Phoenix, drop the iReports; district managers keep
both."* Scope: everything that reads visits.

### The rule

- **A day with a Phoenix entry for the rep drops his iReports360 visits and check-ins of THAT day.** A day with no
  Phoenix entry keeps them, so a rep who has not yet moved to Phoenix on a given day is counted as he always was.
- **An entry** is a countable Phoenix visit with a rep on it, or a recorded day activity of a counted kind (meeting,
  conference, health day, sales day, training, admin work, travel), on a started REP seat and inside the start.
- **A district manager has no entry day by design** — his team seat is not a rep seat — so he keeps BOTH apps. His own
  iReports360 rows are never dropped by this rule.
- **The plans door is unchanged.** `crm_plan_entries_unified` still drops a started team's iReports360 plan entries, a
  district manager's included.

### The shape — `20261016201551_phoenix_crm_wins_the_day_for_medical_reps.sql`

One new function, `phoenix_crm_rep_entry_days()` (security definer, `service_role` only, rows hr_key / agent_crm_id /
entry_day), and `create or replace` of the two doors whose iReports360 branch changes: `crm_visits_unified` and
`crm_checkins_unified`. Only the iReports360 branch's exclusion is rewritten — two `not exists` clauses against the
function, by HR id and, for a vendor row with none, by CRM id. The Phoenix branches, the column order and the types are
untouched, so no reader changed shape. Rollback: re-apply the two earlier view definitions (`20261010161139`), then drop
the function.

### Readers moved with it

- **Early Birds** (`collect.ts`) no longer judges a rep by his start window; the day's clock is the first Phoenix visit
  when there is one and the iReports360 check-in when there is not, and the check-ins door already drops the latter on a
  Phoenix day.
- **"Recorded in both apps on the same day"** (the old "still recording in iReports360" flag) now counts only the mirror
  rows the rule drops — a vendor row on a day the rep also has a Phoenix entry — by asking the same function the views
  use. Its wording lost "counted nowhere", which is no longer true of a day Phoenix does not hold.
- rep-day, the call rate and the KPI boards read the views and need no change; the call rate's "submitted" basis counts
  every submitted visit, so a vendor row on a Phoenix-empty day scores again.

### Measured on production before applying (read-only)

1,395 iReports360 visits across 40 people (12 days) return to the figures, because they sit on days with no Phoenix
entry; 7 newly drop, on days the rep also recorded in Phoenix. Both are the intended effect. Applied to staging and
production on 16 October 2026; `phoenix_crm_rep_entry_days()` returned 277 entry rows, md5 of the function body
`362949c1365a82a1b0eb79398219171f`. No data row was touched — the change restates figures through two views, and
production has no PITR.

## Phoenix is the source of trust

Owner, 22 October 2026, about 04:00 Cairo: *"CRM Master page and all crm old sources once got data from phoenix crm
then phoenix is the source of trust and its data override old crm data"*.

### What was wrong

Phoenix CRM was treated as a blank-filler. The hourly contact refresh and the add-path trigger both carried the arm
`name = coalesce(c.name, excluded.name)` — "a name the vendor already carries is left alone" — so a doctor a rep had
corrected in Phoenix kept the vendor's spelling and speciality in `crm_contacts`, and the three old-CRM doors
(`crm_visits_unified`, `crm_checkins_unified`, `crm_plan_entries_unified`) printed the vendor's text on every
iReports360 row. Read on production the same night:

- Dr Tharwat Milad (contact 1000036186, Phoenix-born, validated) was changed to General Surgery in Phoenix and still
  read Internal Medicine in `crm_contacts`.
- 2,269 vendor contacts have a validated Phoenix customer. In `crm_contacts` 18 of their names and 3 specialities
  differed from Phoenix's; 22,857 iReports360 visits are to them, and 15,816 of those carry a different spelling of the
  doctor (22 a different speciality).
- 12,649 iReports360 visits were made before the account's current holder was hired. 6,040 of them carry the EARLIER
  holder's hr id beside the vendor's re-stamped name of the current holder (iReports360 relabels an account's old rows
  when it changes hands); 6,609 carry no hr id at all. Osama Mohamed Ali's account, re-assigned to him on 1 October
  2026, printed his name on 825 visits from May to August.

### What changed

- **Trusted means validated.** `public.crm_contact_phoenix_truth` holds one row per vendor contact that a VALIDATED
  Phoenix customer references (an active row beats a dropped one, then the latest validation), served by the partial
  index `phoenix_crm_customers_validated_reference_idx`. The 10,164 pending reference rows are unvalidated copies of the
  vendor list, and some name a different doctor (contact 71036: one name in the vendor list, another on a pending row),
  so they override nothing.
- **The doors** (`20261022163000`) print the doctor's name and speciality from that view (check-ins: the name), and on
  the visits door the agent and the double-visit partner print the Phoenix employee's own name whenever the row's hr id
  resolves, keeping the vendor's trailing "( territory )". The grade is not replaced: it is a dated period, governed by
  `crm_contact_assignments` from each team's start.
- **The contact master** (`20261022163100`, `crm_contact_master_refresh`) reads the customer snapshot first, builds
  `crm_refresh_phoenix_truth` (Phoenix-born or validated, the view's order), and the vendor list pass takes Phoenix's
  name, speciality and phone where Phoenix holds them. The name-row pass offers a trusted row's values as they are and
  its arm is now `name = coalesce(excluded.name, c.name)` — Phoenix wins, a blank never erases a value. A pending copy
  is offered as the value on file, else Phoenix's, so it still only fills a blank.
- **The add path** (`20261022163200`) re-emits `phoenix_crm_customers_write_contact_name_row()` with that same arm,
  byte for byte; `tests/phoenix-crm-add-path-name-row.test.ts` holds the two identical.
- **The CRM Master page** prints "Previous holder ( territory )" for a row with NO hr id whose label names only people
  Phoenix had not hired that day (`isHandedOverLabel` in `src/lib/crm/identity.ts`, applied by `relabelHandedOverRows`
  in `src/lib/crm/master.ts` on the visit datasets, the vacations page and every export). The door keeps the vendor
  label for those rows on purpose: reconciliation check 9 reads it there and settles a relabelled row by the person it
  names.

### A test that compared against a dead body

`tests/phoenix-crm-add-path-name-row.test.ts` found "the newest refresh" by matching `contact_refresh` in FILE NAMES.
`20261016233000_crm_contact_master_refresh_skips_idle_work.sql` does not contain that string, so from 16 to 22 October the
byte-identity check compared the trigger with the superseded `20261015132445` body. It now finds the newest definer by
content, like `tests/crm-contact-master-refresh-speed.test.ts`.

### Applied

Staging first, then production on 22 October 2026 between 04:40 and 04:54 Cairo, on the owner's pick "Apply staging
then prod". The doors (`20261022163000`) and the add-path trigger (`20261022163200`) went through `apply_migration` and
sit in both ledgers by name. The refresh (`20261022163100`) went through `scripts/apply-sql-file.mjs`, the standing route,
because the MCP declined it twice (its body holds six `drop table if exists pg_temp.…` lines), so it has an evidenced
`ACKNOWLEDGED_EXCEPTIONS` entry instead of a ledger row.

- Bodies, identical on both projects: refresh `md5(prosrc)` `a99ddecb38b6332a972a787e52443806` (33,564 chars), trigger
  function `1deb2cb14f08a160fa6d6d517e55e2fe`; views `md5(pg_get_viewdef)` visits `f3eab007ee2dfe9d2cfbd665b86bf75c`,
  check-ins `271464594b70e74396965b475a238bde`, plans `6031389f0361de226619147d1a4a1d8a`, truth
  `73ec1273c926c1db6f44b10106b7ec9c`. Before: refresh `8f343dc21428862adb1d4df1a66190b8`, trigger
  `55d95c4201ee9923e7229ef121f8ce03`, visits `31314651…`, check-ins `031a3091…`, plans `070b2c67…`.
- Pre-image: the 66 `crm_contacts` rows Phoenix was about to change (62 vendor contacts and 4 Phoenix-born), saved with
  their Phoenix values before the apply.
- First refresh: 64 vendor contacts changed (the 62, plus the two below) and the 4 Phoenix-born; afterwards **0**
  contacts differ from what Phoenix holds. Dr Tharwat Milad (1000036186) reads General Surgery.
- Second refresh 15 s later: 2 changed, both a blank-fill loop that predates this change — Peter Alphonse (95487) and
  Mahmoud Khalafa (105208) have a phone only on a PENDING Phoenix copy, so the vendor pass blanks it and the name-row pass
  fills it back, with the same end state each run. Staging's second run changed 0.
- The visits door: of 143,664 iReports360 visits, 16,152 now print the doctor's Phoenix name, 22 his Phoenix speciality
  and 136,374 the rep's Phoenix name. The truth view holds 2,269 doctors and answers from the new index in 7 ms; a
  September read of the whole visits door runs in 280 ms.
