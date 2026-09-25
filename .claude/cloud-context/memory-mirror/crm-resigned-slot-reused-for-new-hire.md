---
name: crm-resigned-slot-reused-for-new-hire
description: "SETTLED — NOT A FINDING, do not re-raise (owner, 2026-09-21: 'this is correct'). The CRM admin DELIBERATELY reuses a resigned rep's CRM account for the replacement hired into the same area and line; a resolved agent_hr_id pointing at a resigned employee therefore belongs to someone else, by design. Verify by HIRING DATES — visits must not cross the leaver's last working date — then report the reuse itself as normal, never as a defect"
metadata:
  type: feedback
  originSessionId: acf84ee7-aa00-4fe6-a7e9-f2d84d29236f
  modified: 2026-09-21T00:06:50.345Z
---

When a Phoenix employee resigns and a replacement is hired into the same
territory, whoever administers iReports360 (the CRM) manually overrides the
resigned employee's CRM account onto the new hire — reusing the same
`crm_id`/account rather than creating a new one. Owner-confirmed 2026-07-22:
"the one responsible for crm when an employee resigns and a new employee is
hired in his place he override the new hired on the resigned account to
have the same data i know this is stupid."

**Why this matters:** `ireports360_visits.agent_hr_id` (and `double_hr_id`)
are resolved at sync time from `agent_crm_id`/`double_crm_id` against
`employees.crm_id`. If that resolution is stale — computed before the
account got reassigned, or the `employees.crm_id` row was never updated to
reflect the reassignment — a CURRENT, real visit by the NEW hire gets
attributed to the OLD (resigned) employee. The visit row itself is genuine;
only the identity resolution is wrong.

**How this was caught (2026-07-22):** Private Calendar showed employee A-7
"performing" double visits on 2026-07-20/21 with resigned agents B-85 and
PD-0003. Owner said with certainty this never happened; the real CRM UI
showed the double partners as "Soad.Atef (Cairo East 1/A)" and
"Essam.Youssef (Dokki/P)" — completely different people. Checking the raw
`ireports360_visits.agent_name` column (the CRM's own live display name,
independent of the resolved `agent_hr_id`) confirmed it: `agent_name` said
exactly "Soad.Atef ( Cairo East 1 / A )" / "Essam.Youssef ( Dokki / P )",
while `agent_hr_id` had resolved to B-85/PD-0003 (both resigned). The area
names matched the real employees perfectly — only the hr_id resolution was
wrong.

**How to apply — if `agent_hr_id`/`double_hr_id` on a CRM visit/check-in
row resolves to a RESIGNED employee, do not assume the historical
resignation just happens to be part of the story (e.g. "this visit
predates their resignation" or "the manager visited them right before they
left").** Cross-check first:
1. Compare the raw `agent_name` (or `double_name`) column — the CRM's own
   live display string, format `"FirstName.LastName ( Area / Line )"` —
   against the resolved employee's actual name. A mismatch means the
   `agent_crm_id`/`double_crm_id` has been reassigned to someone new and
   the resolution is stale.
2. Search `employees` by the raw name/area from `agent_name` to find who
   the crm_id SHOULD resolve to now.
3. This is the same failure class already fixed once for crm_id 1477 (see
   the comment in `CRM_RESIGNED_AGENT_CRM_IDS`,
   `src/lib/crm/reads.ts:66-69` — "reused CRM agent slot now resolving to
   ACTIVE employee B-164... keeping it here was hiding an active rep's
   data"). It will keep recurring since the reuse practice is ongoing, not
   a one-time historical artifact.

## Update 2026-08-01 — two things above are now out of date

**1. There IS a reliable automated signal** (the "no reliable automated way"
claim below is superseded, for one half of the problem). Work dated AFTER an
employee's `last_working_date` cannot be theirs. `resolveEmployeeAttribution`
(`src/lib/crm/identity.ts`) now refuses that attribution on both AUTOMATIC tiers
(`employees.crm_id`, unique `crm_username`) and reports the blocked hr id so the
sync counts it and the digest alerts. Explicit tier-1 overrides are exempt on
purpose — a human's decision must not be vetoed by a stale roster date. This does
NOT solve the other half: a reused slot whose work predates the leaver's exit is
still indistinguishable automatically and still needs the name cross-check below.

**⚠️ SUPERSEDED 2026-08-04 — the "never two names" claim below broke in production.** Slots
1102, 1395 and 1399 now each carry TWO distinct `agent_name` values (placeholder/leaver era →
replacement era). 1399 is the dangerous shape: 1,229 rows attributed to B-97 (Nada, left 06-28)
plus the replacement Mohamed.Yasser's new rows. An UNSCOPED override would let the weekly wide
reconcile re-stamp the leaver's history onto the replacement. Fix shipped in PR #1676: the tier-1
override is **label-scoped** (applies only to rows whose `agent_name` normalizes to the
resolution's stored `crm_name`; check-ins, having no name, keep the unconditional path), the
admin "mapped" backfill stamps only label-matching rows, and the sync now pushes an
unmapped-agent alert (new / reused-resigned / label-drift, weekly idempotency). Re-run the
two-names query below before ever assuming slot exclusivity again.

**2. (superseded — see above) A CRM slot is NEVER shared by two people — do not build effective-dating.**
The 13-phase plan assumed slot 1536 held Mayar's June visits plus Essam's July
visits, and specified date-windowed identity overrides
(`effective_from`/`effective_to`) to separate them. Production says otherwise:
across ~111k visits exactly ONE slot (1470) has ever carried two distinct
`agent_name` values, and both are the same person (one row lost its name prefix).
Slots 1391 and 1536 each carried a single name for their whole history. So an
unscoped override is correct for a slot's entire history, and re-sync re-stamping
is self-healing rather than corrupting — there is no "the reconcile will
re-break June" expiry. Re-verify with:
`select agent_crm_id, count(distinct agent_name) from ireports360_visits group by 1 having count(distinct agent_name) > 1;`

**3. The DV-Analytics-only band-aid is gone.**
`CRM_AGENT_ID_HR_ID_CORRECTIONS` (hardcoded in
`src/lib/double-visit-analytics/service.ts`) was retired 2026-08-01; that module
now reads `ireports360_crm_identity_resolutions` like everything else, and its
test asserts no employee hr id may be hardcoded there. Fixing one module in
isolation is what let the same bad data stay invisible everywhere else for
months — fix identity in the shared override table, never per-consumer.

**Consequence for private-calendar-actual-activity-style features:**
attempting to "fix" a resigned-agent double-visit by simply showing it
anyway with a "this person resigned" flag is WRONG when the row is
actually a stale-identity case — it displays a real visit attributed to a
name that both never happened AND isn't even the currently-correct
attribution. The safe default is to keep excluding resigned-agent-resolved
visits (the CRM door's existing behavior) rather than surface them,
because there is no reliable automated way to distinguish "genuinely
visited someone before they resigned" from "crm_id got silently reused for
a new hire" without this manual name cross-check. A `git revert`-style
walk-back of the `includeResignedAgents` opt-in added to
`getDoubleVisitRows`/`getLiveDoubleVisitRows`/`loadDoubleVisitPrivateCalendarItems`
happened the same session this was discovered — see PR history around
2026-07-22 for the private calendar "actual activity" work.

## Update 2026-08-21 — a SIXTH reused slot, found by the Rep Doctor Lists board

`crm_id 1523` sits on the hard-floor `CRM_RESIGNED_AGENT_CRM_IDS` list, but production says it now
carries an ACTIVE employee:

| field | value |
| --- | --- |
| `employees.hr_id` | `AI-0011` |
| `full_name` | Mohamed Khaled |
| `job_title` | Medical Representative |
| `employment_status` | **active** |
| `employees.crm_id` | **1523** |

August 2026 alone: **112 campaign visits (type -8) and 21 planned contacts**, all invisible. The
plan rows resolve cleanly too — `agent_hr_id = 'AI-0011'` on all 21, so nothing about the data is
ambiguous; only the hard-floor list hides him.

Same class as 1477 / 1102 / 1395 / 1521 / 1247, found the same way each time: auditing the static
list against live employment status. The list OUTRANKS `employment_status`, so the live-union
handed-over-slot carve-out cannot rescue it — only deleting the id from the array can.

**Why this one is urgent:** per the comment block in `reads.ts`, an excluded slot is hidden from
Double Visit Analytics AND the Field Workforce Compliance matrix that feeds automated payroll's
no-activity deduction detector. An invisible active rep is a candidate for a no-activity deduction
against real salary.

**How to apply:** removing 1523 needs the owner's confirmation — every prior removal is recorded in
that file as "owner decision" / "owner confirmed". Do NOT edit the list unilaterally. And audit the
WHOLE list, not just this id, since that is how each previous instance surfaced:
`select hr_id, full_name, employment_status, crm_id from employees where crm_id ~ '^[0-9]+$' and crm_id::int in (<the array>) and employment_status = 'active';`

Distinct from crm 1550, checked the same day: 1550 has **no employee row at all** (62 campaign
visits, 63 plan rows, `agent_hr_id` NULL on every one) — genuinely unmapped, which is the honest
state the unmapped-agent alert reports, not this bug.

Related: [[campaign-visits-make-a-working-rep-look-like-a-zero]] ·
[[crm-live-departed-agent-exclusion]] · [[crm-resigned-agents-exclusion-list]]

**RESOLVED 2026-08-21 — 1523 is out.** Owner approved the removal in conversation; shipped as
PR #2262, squash `3348420b`, live on production 10:11 Cairo (`/api/healthz` revision matched).
Verified from the merged commit: the array is 73 ids, `1523` absent, `1436` still present. His 113
visits already carry `agent_hr_id = 'AI-0011'`, so he attributes under his real name rather than
appearing as an unmapped agent; only 2 stray April rows from the slot's placeholder era stay
unmapped. NOTE the effective exclusion is cached ~5 min, so visibility lags the deploy slightly.

His first visit is 2026-08-17 — he was invisible for his entire time employed. On the Rep Doctor
Lists board he now reads 11 planned doctors / 0 visited / 0% adherence / 112 campaign calls, which
is the honest shape, not a performance verdict: a brand-new rep doing campaign work.

**The lesson that outlives this fix:** this list has now been wrong SIX times in the same way. Audit
it against live employment status whenever a rep looks impossibly idle — that is how 1477, 1102,
1395, 1521, 1247 and 1523 were each found.

## 🔴 MEASURED SCOPE 2026-08-23 — 34 people carry 1,619 visits dated BEFORE their own hire date

The one query that sizes this whole failure class, and the one to re-run rather than re-deriving:

```sql
select count(distinct e.hr_id) as people, count(*) as visits,
       count(*) filter (where v.visit_type = -8) as campaign,
       count(*) filter (where v.visit_type = 0)  as real_visits
from employees e join ireports360_visits v on upper(v.agent_hr_id)=upper(e.hr_id)
where e.hire_date is not null and v.visit_date < e.hire_date;
```

**34 people · 1,619 visits · 380 campaign · 1,114 real customer visits.** Worst offenders:

| Person | Hire date | Slot | Visits before hire | Earliest |
| --- | --- | --- | --- | --- |
| Soad Atef `AI-0003` | 2026-06-20 | 1391 | **1,136** | 2026-01-01 |
| Mohamed Yasser `AI-0006` | 2026-08-02 | 1399 | **232** | 2026-05-25 |
| Mohamed Raffat `PD-0009` | 2026-08-01 | 1395 | **154** | 2026-01-06 |
| Hanan Safwat `AI-0012` | 2026-08-17 | 1550 | 25 (all campaign) | 2026-08-11 |
| Mahmoud Abdelreheem `AI-0005` | 2026-08-01 | 1247 | 11 | 2026-01-06 |

Slots 1391, 1395, 1399, 1247, 1102 recur — the same reused-slot family listed further down this file
(1477, 1102, 1395, 1521, 1247, 1523). **A visit dated before its agent's hire date is the cheapest
possible detector for a reused slot** and needs no name comparison at all. Nothing in the app runs it.

**This retires a scare, and that matters more than the count.** Soad Atef's visits reaching back to
01 January were read earlier the same day as possible evidence she had worked unpaid since January.
**They are almost certainly slot 1391's history, not her work.** Her exposure is the narrow one —
June (part) and July — per [[reps-who-never-appear-in-any-salary-record]]. Do not use CRM activity to
date anyone's employment; the arrow only points the other way.

## Update 2026-08-23 — the `employees.crm_id` link repair, and why slot 1399 cannot be linked at all

Separate from the exclusion list: **`employees.crm_id` itself was unset for 33 people who have real
CRM visits under their own `agent_hr_id`.** Repaired on the owner's instruction ("fix the mapping").
Matched **only on `agent_hr_id`** — deliberately NOT `double_hr_id`, which would hand a manager the
rep's slot. 31 rows written by a fill-only UPDATE with four guards (`crm_id is null`; exactly one
crm_id per person; that crm_id claimed by exactly one person in the batch; nobody outside the batch
already holds it). After: **139 employees linked, 0 duplicate crm_ids, 2 left unwritten.**

**The 2 left are slot 1399, and the owner's answer was "neither".** Asked which of the two holds it,
he replied: *"Mohammed Yesser accepted the offer, and then after the second day, he apologized so the
area is still vacant."* **A vacant area has no one to link — so 1399 stays unlinked, deliberately,
and that is the finished state, not an open item.**

**The two-person framing was wrong. Slot 1399 (Tanta) has FOUR label×attribution eras:**

| Label the CRM stored | Resolved to | Visits | Window |
| --- | --- | --- | --- |
| `Nada.Mohammed ( Tanta / E )` | `B-97` | 796 | 01 Jan – 24 May |
| `Mohamed.Yasser ( Tanta / A )` | `B-97` | 201 | 04 Apr – 04 May |
| `Omar.Tamer ( Tanta / A )` | **`AI-0006`** | 202 | 25 May – 24 Jun |
| `Mohamed.Yasser ( Tanta / A )` | `AI-0006` | 54 | 25 Jun – 06 Aug |

**Mohamed Yasser (`AI-0006`) was hired 2026-08-02 and his `last_working_date` is 2026-08-02** — the
two days the owner describes. His real work is the **24 visits of 02–06 Aug**. The other **232** are
not his: 202 carry the CRM's own `Omar.Tamer` label, and 30 more are dated 25–28 June, **five weeks
before he was hired**. `employees_crm_id_unique_idx` is UNIQUE where not null, so only one holder is
possible anyway — but the right count here is zero.

**What keeps the misattribution alive** is a single row in `ireports360_crm_identity_resolutions`:
`crm_id 1399 → mapped_hr_id AI-0006`, `crm_name = 'Mohamed.Yasser ( Tanta / A )'`, set by `B-10` on
2026-08-03. It is label-scoped by design (PR #1676), yet the 202 `Omar.Tamer`-labelled rows still
resolve to `AI-0006` — so **the label scoping is not holding on the base sync path.** Verify before
assuming a scoped override protects anything.

**No payroll exposure from it, checked:** `AI-0006` has **zero** deduction candidates in the
canonical table AND zero in the legacy singular table. His leaver scan window is a single day
(hired and left 02 Aug) and he made 6 visits that day, so no no-activity day can be raised.

## 🔴 Omar Tamer worked 25 May – 24 June 2026 and was NEVER PAID — confirmed 2026-08-23

Owner-confirmed: *"omar tamer worked that month"*, and separately that his `AI-0010` record
(hire_date **2026-09-01**, created 2026-08-18) is a **RE-hire that has not started yet** — it does
not cover the May–June stint. He asked directly whether that month was paid. **It was not.**

Proof, four independent ways:

1. **No `salary_records` row bearing his name in ANY month of 2026.** Searched Latin `%tamer%` /
   `%omar%` and Arabic `%تامر%` / `%عمر %`. The only Omar on payroll is **Omar Anwar Gawish (`B-10`,
   Head Office — the owner himself)**; the other two hits carry Omar as a middle name (`PD-0001` Hany
   Saad Mohamed Omar, `A-10` Nahed Tarek Hassan Omar Hattab). **No Tamer exists in payroll at all.**
2. **Not among `automated_payroll_non_employees`** — that table holds 7 rows, all July 2026, none him.
   This is the table an off-books payment would land in, so its absence is meaningful.
3. **No employee record could have picked him up.** `AI-0010` was created 2026-08-18, weeks after the
   May and June runs closed.
4. **The seat's salary went to someone else.** The Tanta / Anti-Infective seat was paid **every month
   Jan–June 2026 to `B-97` Nada Elsharkawy** — 16,373 EGP in both May and June, a full month each
   time. Her `last_working_date` is 2026-06-28.

**So for 25 May – 24 June two people worked that territory: Nada, paid in full, and Omar Tamer, doing
202 recorded visits for nothing.** May and June batches are `locked`; July is `approved`.

**Do NOT infer the amount owed from the seat rate.** The seat carries 16,500 net, but his agreed
salary is not in the system anywhere. Swept 2026-08-23 after the owner asked *"whats missing here"* —
the first answer had checked payroll only, which was too narrow:

- **`employee_salary_structure`: no row** for `AI-0010`, `AI-0006`, **or even `B-97`** — so that
  table is sparsely populated and its emptiness proves nothing on its own. Do not treat it as the
  authority on anyone's pay.
- **ATS: one candidate, `OMAR TAMER MAGDY`, created 2026-08-14, status `new`** — for the SEPTEMBER
  re-hire, not the May–June stint. **No `ats_applications` row and no `ats_offers` row**, so
  `ats_offers.monthly_gross` — the field that would carry his agreed pay — was never written.
- **`expense_claims`: ZERO, ever**, for him, for `AI-0006`, for `B-97`, and none at all filed against
  Tanta/Gharbia for May–July 2026. **A rep doing 202 field visits over a month incurred transport and
  fuel that was never reimbursed** — the unpaid salary is not the whole debt.

**A structural gap the seat itself shows: JULY 2026 has no Anti-Infective Tanta row at all.** Nada
left 28 June, Mohamed Yasser arrived 2 August, and July's batch covers Tanta only through Pedia
(`B-170`) and CNS (`B-145`). The visit data agrees — **slot 1399 has zero July visits.** The seat
was genuinely empty for a month, so no one is owed July.

**The 30 visits dated 25–28 June are almost certainly Nada's, not Mohamed Yasser's.** They carry his
label but he was hired 2 August, and they fall after Omar Tamer's last day (24 June). Nada's
`last_working_date` is **2026-06-28** — an exact match to the block's final day.

**Unrelated near-miss worth knowing:** a July 2026 `automated_payroll_draft_rows` row exists for
`AI-0006` (Mohamed Yasser), created 2026-08-04 — for a man hired 2026-08-02. It is empty
(`base_for_month` null, not excluded, not on hold) and he is absent from the approved July batch, so
**nothing was paid**. A draft row for a month someone did not work is not itself a payment, but it is
the shape that becomes one if a run is re-approved without review.

**Characterising what is still unlinked — the important part is that none of it is live.** 24 Medical
Reps of 121 still have no `crm_id`, but **zero are currently-working reps**: 10 are
`historical_payroll_record` (no hire date, payroll-only, never CRM users), 11 resigned, 1 terminated,
and 2 have not started yet (`AI-0010` Omar Tamer hired 01 Sep, `PD-0011` Mohamed Eldomiaty hired
24 Aug). Do not "fix" these — there is nothing to link.

**A residual the link repair did NOT solve, and a caution against overclaiming it.** 7,555 visits
carry no `agent_hr_id` at all; the crm_id link recovers only **161** of them. The other **7,394**
belong to **70 crm_ids that match no employee row anywhere.** That block is historical, not
operational: newest orphan visit **2026-07-14**, exactly **1** since 01 June, **0** in August. 6,659
of them (39 slots) carry a *nameless* label — `agent_name` is bare territory like
`( Cairo East 1 / F )` with no person prefix, i.e. the agent was deleted in the source CRM and the
mirror kept the slot. Same root cause as [[crm-connector-leaver-branch-attaches-no-employee-name]]:
a name that is resolved rather than snapshotted disappears when the source changes.

**Why:** linking `employees.crm_id` fixes the employee→slot direction only. It does not make orphan
visits attributable, and reporting "the mapping is fixed" without separating those two would
overstate it by 7,394 rows.

**How to apply:** after any crm_id link work, run the four checks — employees linked, duplicates
(must be 0), still-unlinked-with-visits, and orphan visits by `max(visit_date)`. An orphan block that
stops months ago is history; one reaching into the current month is a live attribution bug and feeds
the no-activity deduction detector. Related: [[crm-boards-key-the-same-rep-two-different-ways]] ·
[[campaign-visits-make-a-working-rep-look-like-a-zero]].

## Update 2026-09-03 — the SEVENTH, and the first that needed NO code change

Slot **1485**: Samia Raafat `B-171` (resigned 2026-07-11, 835 visits) → Manar Sadek Abdallah
`CN-0007` (Medical Representative, active, hired 2026-09-01). Fixed with a two-row `employees`
write and nothing else — **`1485` was never on the hard-floor list**, so unlike 1477 / 1102 / 1395 /
1521 / 1247 / 1523 there was no array to edit and no owner decision to seek.

**Why the data fix alone is sufficient, and the two facts that make it safe:**

1. **`resolveLiveDepartedExclusion` self-heals.** `B-171` is departed and her visits carry
   `agent_crm_id 1485`, so the live scan finds 1485 — then drops it, because an ACTIVE employee now
   owns `employees.crm_id = '1485'` (`isActiveLifecycleStatus` = `active`|`on_leave`). No code
   change can be needed for an id the static list never held.
2. **Tier 2 of the identity waterfall is employment-gated**, so setting `employees.crm_id` credits
   only post-hire rows. `isAttributableOn` blocks on `visitDay < hireDate` **strictly**, so the hire
   date itself is attributable and anything earlier is refused and reported.

**The order matters and is the system's own rule:** release the leaver's `crm_id` FIRST
(`employees_crm_id_unique_idx` is unique where not-null across ALL statuses, regardless of
employment), then claim it. `crm_username` is NOT cleared on the leaver — clearing it once stranded
587 visits. The new holder gets **her own** label; 96 of the 98 active slot-holders carry one.

### 🔴 A handover ALWAYS leaves one pre-hire artefact row. It is correct, and it must stay unmapped.

Slot 1485 carries exactly two unmapped visits, and they are **one per handover**:

| Date | Type | `contact_crm_id` | What it is |
| --- | --- | --- | --- |
| 2026-02-25 | `-5` | 0 | account (re)created for B-171, who was hired 2026-03-01 |
| 2026-08-27 | `-5` | 0 | account (re)created for CN-0007, who was hired 2026-09-01 |

The CRM admin recreates the account days before the new rep starts, and that act writes a
`visit_type -5` (Public Holiday) row against `contact_crm_id 0` dated that day. **Two instances on
one slot is what makes it structural rather than a one-off** — expect one on every reused slot.

**How to apply — do not "fix" either side of it.** The row predates its owner's hire date, so
`findPreHireMappingConflict` refuses the admin mapping flow and its message offers the two wrong
answers: map it to whoever held it, or correct the hiring date. **Neither.** Leave it unmapped —
that is the honest state the unmapped-agent alert reports, and the owner rule is *trust the hiring
date* ([[coaching-dates-legitimately-predate-the-hire-date]]). The direct `employees.crm_id` write
sidesteps the guard without defeating it: the gate that refuses the row is the same one the sync
applies, so the artefact stays unmapped either way.

**Also measured here:** a slot's already-stamped rows survive the handover, because
`sync.ts` refuses to write a NULL over a good `agent_hr_id` (the guard at ~line 677). After the
release, a deep resync of B-171's July rows resolves 1485 → CN-0007 → blocked pre-hire → null, and
that null is **not** written. Her 835 visits and 825 check-ins are unharmed — verified after the
fact, not assumed.

**One asymmetry worth knowing:** B-171 has 56 unmapped check-ins (2026-07-06 → 07-12) beginning the
day after her last mapped one. Check-ins carry no display name, so the post-exit label escape hatch
in `isAttributableOn` (`if (!ownLabel || !recordLabel) return false`) cannot fire for them, while her
visits past that date still attribute. Pre-existing, by design, and unrelated to the handover — do
not read it as damage from a slot release.

Related: [[a-cv-import-overwrote-a-candidates-whole-identity]] ·
[[campaign-visits-make-a-working-rep-look-like-a-zero]]

### Correction, same day — the pre-hire artefact is an ACCOUNT-CREATION signature, not a handover one

The section above calls it "one per handover". Measured wider the same afternoon, that is too narrow.
Slot **1552** (`Maha.Metwaly`, AI-0015, District Sales Manager, hired 2026-09-01) is a **brand-new
agent id that was never handed over by anyone**, and it carries the identical row:

```
agent_crm_id 1552 · agent_name 'Maha.Metwaly' · visit_date 2026-08-27
visit_type -5 · contact_crm_id 0 · crm_save_date 2026-08-27 00:00:00+00 · agent_hr_id NULL
```

Byte-for-byte the shape of Manar's (1485) and of the previous occupant's (2026-02-25). So the rule is:
**creating a CRM agent account writes one `visit_type -5` / `contact_crm_id 0` row dated the day of
creation** — on a fresh id and a recycled one alike. It goes unmapped whenever the account is created
before its owner's hire date, which is the normal case since the CRM admin sets accounts up in
advance. Do not read one on a new slot as evidence of a hidden previous occupant.

**Do not chase these.** On 2026-08-27 a single bulk event wrote one such row across many accounts at
once — six of them inside one district alone (1475, 1481, 1485, 1490, 1499, 1502). Most map cleanly
because their owner was already hired and linked; the ones that stay unmapped are the accounts
created ahead of a start date. That is the honest state and the unmapped-agent alert reports it.

### 🔴 SUPERSEDES BOTH SECTIONS ABOVE — the `-5` row is a COMPANY-WIDE PUBLIC HOLIDAY stamp

Both earlier explanations of that unmapped row are **WRONG**. It is neither a handover signature nor
an account-creation artefact. Measured on production 2026-09-03:

| date | rows | distinct agents | `visit_type -5` | `contact_crm_id 0` |
| --- | ---: | ---: | ---: | ---: |
| 2026-08-26 (normal) | 631 | 73 | 0 | 54 |
| **2026-08-27** | **171** | **168** | **168** | **171** |
| 2026-08-29 (normal) | 759 | 76 | 0 | 66 |
| 2026-02-24 (normal) | 638 | 78 | 0 | 309 |
| **2026-02-25** | **203** | **147** | **147** | **203** |

A normal day is ~700 rows across ~75 ACTIVE agents. Those two days are ~1 row across ~every account
in the system. `visit_type -5` is **Public Holiday**, so the CRM stamps a holiday once against every
agent account on the roster — working and departed alike. Both dates I read as per-slot artefacts are
that same stamp; the 2026-02-25 row on slot 1485 has nothing to do with its handover.

**How to recognise it:** a date whose row count collapses to roughly the agent count while
`distinct_agents` jumps to the whole roster, with `visit_type -5` and `contact_crm_id 0` on nearly
every row. Query the DATE, never the slot — one slot's view of it is indistinguishable from a
per-account event, which is exactly the mistake made here.

**Everything the earlier sections said to DO is still right; only the cause was wrong.** Such a row
stays unmapped whenever it predates its account holder's hire date, `findPreHireMappingConflict` will
still refuse the admin mapping flow because of it, and the answer remains neither to back-stamp it
nor to "correct" the hiring date. Its presence is normal and says nothing about slot reuse.

**Related standing rule:** `-5` (Public Holiday) and `-6` (Casual Leave) are WORKING days, never
absence — see [[crm-visit-type-maps-there-are-three-not-two]]. A company-wide `-5` day is therefore
not a gap in anyone's coverage, and must not be scored as one.

## Update 2026-09-13 — the EIGHTH (slot 1166), and a mapping does NOT stamp old rows by itself

Slot **1166** (leaver's Qalyubia slot, manual resolution status `resigned`) now carries Samah Ashraf
`AI-0018` (active, hired 2026-09-02). Owner decision via the CRM decisions workbook; removed from
`CRM_RESIGNED_AGENT_CRM_IDS` in PR #3799 (squash `03c41afe1`, live 06:57 Cairo). Same morning three
other September hires were linked by `employees.crm_id` write only (1539 AI-0016, 1555 AI-0014,
1399 AI-0020 — 1399's 27 Aug row stays blocked pre-hire, correct).

🔴 **Trap: writing `employees.crm_id` does not attribute a single existing row.** Reads filter on the
sync-stamped `agent_hr_id`. Only rows a later sync re-reads get stamped: the light poll covers
yesterday..today, the deep rolling run (every 3h from 06:00 Cairo) covers today-10..today. Measured
06:57: all four reps had only their 12 Sep rows stamped; 5–10 Sep waited for the next deep run.
Rows older than 10 days need the wide reconcile slice or the re-stamp routine in `sync.ts`. **Never
tell the owner "visible now, no sync needed" after a mapping** — check `sync_runs` for a deep run
started after the `employees.updated_at` of the mapping.

---

## 2026-09-21 — the owner closed this, and it must never be audited open again

A deep CRM audit reported slot reuse as a finding ("a reused slot hides an active rep"). He
answered: *"nothing wrong … the person responsible for crm when a emp is hired in the same area of
a rep resigned same line he put him on his area so this is correct chevk hiring dates"* — and,
separately, *"I want to know all these rules were settled from long time ago. And why, why, why are
we starting these rules from scratch?"* The reuse is **CRM administration working as intended.**
The only thing to verify is the HANDOVER, by hiring dates.

Verified on production the same day — all three reused slots are clean:

| Slot | Leaver (hired → last working) | Visits | Successor (hired) | First visit |
| --- | --- | --- | --- | --- |
| 1391 | Tayseer Khaled 2025-10-11 → 2026-06-02 | 01-01→06-01 | Soad Atef 2026-06-20 (LWD 08-09) | 07-20 |
| 1399 | Nada Elsharkawy 2025-12-14 → 2026-06-28 | 01-31→03-01 | Ahmed Elakraa 2026-09-05 | 09-06 |
| 1503 | Ashraf Radwan 2026-04-14 → 2026-08-09 | 04-14→07-29 | Esraa Fotooh 2026-09-13 | 09-13 |

**Zero working visits after any leaver's last working date.** The single boundary-crossing row is
Soad Atef's 2026-08-27 — `visit_type = -5`, comment "اجازة بمناسبة المولد النبوي الشريف": the
vendor's public-holiday marker, not a visit (see `crm-visit-type-maps-there-are-three-not-two`).

**The lesson is about the DESCRIPTION, not the fact.** This memory already said a resolved
`agent_hr_id` on a resigned employee "may actually belong to someone else entirely" — which is
exactly what the audit "discovered". It read as a hazard warning, so recall produced an
investigation instead of a recognition. A settled rule's `description` must open with the VERDICT
("settled, not a finding"), or it will be re-litigated by the next session that reads it.
See [[acting-dm-authority-is-app-role-not-job-title]], which had the same defect and the same fix.
