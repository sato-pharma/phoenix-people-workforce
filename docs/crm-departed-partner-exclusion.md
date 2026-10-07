# The departed-agent exclusion and the double visits it erased

The account behind the hook in `.claude/rules/crm.md` ("THE DEPARTED-AGENT EXCLUSION IS KEYED ON
WHO *LOGGED* THE ROW") and its cue in `.claude/rules/payroll.md`. Shipped 2026-10-07 in PR 5447;
this file carries the measurement, the way to reproduce it, and the second money path it reached.

## The mechanism

A manager logs nothing of his own. His fieldwork is recorded on the **rep's** visit row, as that
row's `double_hr_id`. The exclusion that hides a departed person's CRM work is keyed on
`crm_visits_unified.exclusion_crm_id`, which **is** `agent_crm_id` — the person who *logged* the
row. So the day a rep resigned, every double visit his manager had done with him disappeared, the
manager's own working day read "no CRM activity", and the no-activity connector charged him.

It is **retroactive**, which is why it stayed invisible: the day was correct for weeks, then a
resignation months later rewrote it, after the month had closed.

`scanVisitsForRangeCreditingPartners` rescues such a row only when it names a real partner
(`REAL_DOUBLE_PARTNER_OR_FILTER`), nulls `agent_hr_id`, sets `partner_credit_only`, and **keeps
`agent_crm_id`** — the key `collapseDuplicateVisitSubmissions` groups a re-saved stop by. Nulling
it too would stop the duplicate collapse working on rescued rows and *inflate* the partner's count.

## The exclusion is two tiers, and they are different sizes

Measured on production 2026-10-07:

| | |
| --- | --- |
| `CRM_RESIGNED_AGENT_CRM_IDS` — the hand-maintained static list | **71** |
| The live tier (`scanDepartedAgentCrmIds` → `resolveLiveDepartedExclusion`) | **56** |
| **Effective exclusion (the union)** | **119** — they overlap by 8 |

🔴 **"56" is the LIVE TIER ALONE.** PR 5447's body first published it as the whole exclusion and was
corrected after the merge. A session that measures one tier and reports it as "currently excluded"
understates the exclusion by more than half.

## Reproducing it in SQL: join the MIRROR's `agent_hr_id`, never `employees.crm_id`

The live tier matches `ireports360_visits.agent_hr_id` against employees whose `employment_status`
∉ {`active`, `on_leave`}, then drops any id an **active** employee currently owns (the
handed-over-slot carve-out in `resolveLiveDepartedExclusion`).

🔴 **A query that joins `employees.crm_id = v.agent_crm_id` instead returns ZERO departed loggers
and reads as a clean bill of health.** Only 117 of 208 employee rows carry a `crm_id` at all, and a
leaver's is typically not among them. This was written once in this audit and nearly reported.

## What it cost — June to September 2026

| | |
| --- | --- |
| Days where **all** of an active employee's evidence was erased | **100**, across **18** people |
| Days where the count was merely understated | 78 |
| Of the 100, days that reached a deduction candidate | **12**, across **6** people |
| Of those 12, days carrying a decision | **2** |

🔴 **12, not 11 — and the reason is a population mismatch worth remembering.** The
"100 days / 18 people" figure is scoped to people **still active**, which is right for "who is being
wronged today". The money list must not be: Yehya Mohamed Kamal eldeen Saad Mohamed (B-23) resigned
2026-08-31, so he left the active measure while his 21 July day — 10 real visits — stayed an
**undecided 1,000.00 EGP deduction**. Counting both measures the same way lost one day and
1,000.00 EGP. **Say which population a figure is scoped to, and never reuse an "active employees"
count as the money total.**

### CRM no-activity — the 10 undecided days, 8,616.13 EGP, 74 real visits

Every one lost **100%** of its evidence; the whole day's work sat on one departed rep's rows.

| Day | Person | Visits erased | Logged by (since departed) | EGP |
| --- | --- | --- | --- | --- |
| 6 Jul | Sameh Shabaan El Hoseiny El Hoseiny | 7 | ( Dokki - Imbaba / C ) | 870.97 |
| 21 Jul | Yehya Mohamed Kamal eldeen Saad Mohamed | 10 | Gerges Sameh ( Sohag 1 / F ) | 1,000.00 |
| 4 Aug | Mahmoud Mohamed Said Mohamed Badawy | 7 | Mariem Ezzat ( Giza Centers / E ) | 856.45 |
| 8 Aug | Mahmoud Mohamed Said Mohamed Badawy | 5 | Mariem Ezzat ( Giza Centers / E ) | 856.45 |
| 10 Aug | Mina Farouk Nawar Rizkallah | 8 | Engy Said ( Cairo East 1 / C ) | 725.81 |
| 15 Aug | Mahmoud Mohamed Said Mohamed Badawy | 6 | Mariem Ezzat ( Giza Centers / E ) | 856.45 |
| 16 Aug | Mina Farouk Nawar Rizkallah | 10 | Engy Said ( Cairo East 1 / C ) | 725.81 |
| 16 Aug | Taha Mohamed Taha Elsayed AboElftouh | 9 | Mohamed Raafat ( Helwan-Maadi / P ) | 967.74 |
| 25 Aug | Mahmoud Mohamed Said Mohamed Badawy | 8 | Mariem Ezzat ( Giza Centers / E ) | 856.45 |
| 23 Sep | Sameh Shabaan El Hoseiny El Hoseiny | 4 | Adel Srour ( Down-town / C ) | 900.00 |

### The two decided days — Salim Salim Abdo Ibrahim Gomaa (B-76), District Sales Manager

7 and 13 September, **9 visits each**, both logged by Aml Mohamed Mohamed Eid elmashad, whose last
working day was 17 September — she was still employed on the days he worked, and her later
resignation is what erased his evidence. His September line reads 2,800.00 EGP for three days
(7, 13, 23 Sep); the 23rd is a genuine no-activity day, so **1,866.67 of the 2,800.00 is wrong.**
Six of his September days lost 100% of their rows this way — 6, 7, 13, 14, 22 and 26 September
(7, 9, 9, 2, 7 and 7 rows) — erased by **two** different departed reps, not one.

## The second money path: fingerprint deductions

`crmActivity` is **evidence shown to whoever approves**, not something that suppresses the charge —
the connector carries it so a reviewer does not get "late 207 min, 419.35 EGP" with nothing showing
the person was in the field. It reaches the screen through `getCrmActivityDayMaps`, and
`crm-day-maps.ts` credits **both** roles (`for (const rawHrId of [visit.agent_hr_id,
visit.double_hr_id])`), so a manager's double visit did count — until the exclusion hid the row.
The fix covers this path on both branches because it nulls only `agent_hr_id` and leaves
`double_hr_id` intact.

Audited 2026-10-07: **169 fingerprint candidate days across 16 people. Only 3 had the person as a
double partner at all — and all 3 lost 100% of that evidence.** Where a manager's only field proof
was a double visit, it was always erased.

| Day | Person | Visits erased | Logged by (since departed) | EGP | Status |
| --- | --- | --- | --- | --- | --- |
| 29 Jul | Ali Mohamed Ali Elsayed (A-12), National Sales Manager | 5 | Essam Youssef ( Dokki / P ) | 1,451.61 | **Approved** |
| 18 Aug | Ali Mohamed Ali Elsayed (A-12) | 2 | Ahmed Nagy | 1,451.61 | Pending |
| 22 Sep | Amr Mohamed Naguib Elsebaey (B-122), National Sales Manager | 4 | Adel Srour ( Down-town / C ) | 750.00 | Pending |

## None of it was ever paid — verified on the payslip, not the draft

July **and** August are published (10 August and 8 September 2026, both by B-10); September sits at
`phase: part2` with `part2_confirmed_at` and `published_at` null.

- Every *approved* CRM no-activity day resting on erased evidence is Salim's two, both in
  **unpublished** September. July and August produced none.
- The 29 July fingerprint charge was approved but `salary_records.finger_print` for A-12 reads
  **0** in July *and* August — it never reached the sheet. (B-122's July `finger_print` of 750 is a
  different July day with no double-visit evidence involved.)

🔴 **Checking that took two queries, and the first was wrong.** Filtering approved decisions on
`applied_amount > 0` returned **empty** — a false all-clear — because Salim's decision carries a
null there with the amount on the publication line. A money query must take the amount from
`deductions_publication_lines` as well as the decision, or it hides exactly the rows it is looking
for.

🔴 **One forward-looking risk.** Since "Approved for Payroll" became the pay gate again (pushed or
not, 2026-10-07), the 29 July approval is no longer inert: it would be picked up if July were ever
recomputed or republished, and it rests on erased evidence.

## Totals as of 2026-10-07

**15 days across two money paths — 12 still undecided (10,817.74 EGP) and 3 already decided
(3,318.28 EGP) — and not one EGP of it paid.** CRM no-activity: 10 undecided + 2 decided.
Fingerprint: 2 undecided + 1 decided. 🔴 **An earlier count in the session that produced this
said "13 days" — it added the 10 undecided CRM days to all 3 fingerprint days and dropped
Salim's 2. Count the decided and the undecided separately, per path, and add them once.** Nothing was reversed in the database by the fix or by this audit; every
one of those decisions is made on the Deductions screen.
