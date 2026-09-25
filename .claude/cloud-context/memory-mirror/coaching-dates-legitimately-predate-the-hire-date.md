---
name: coaching-dates-legitimately-predate-the-hire-date
description: "OWNER RULED 2026-09-01: trust the hire date. 13 coaching reports dated before their rep's hire_date are CORRECT on both sides — never 'fix' either the coaching date or the hire date."
metadata:
  type: feedback
---

Fourteen rows in `public.coaching_reports` carry a `coaching_date` earlier than their rep's
`employees.hire_date`. They look exactly like a data defect. **Thirteen of them are correct and must
be left alone.**

The source workbook is `F:\coaching\Q1 Coaching Report 2026.xlsx`, sheet `Jan-Feb-March-April` —
named by `coaching_archived_evaluations.source_file`, 169 dated rows, 50 people, column 3 holding
real Excel date serials. Reconciled against all 116 reports on 2026-09-01: **18 reps match exactly**,
and the workbook confirms **13 of the 14 pre-hire dates verbatim** — same day, same month, same year.

The 13 sit on five people: **Hayam Hefnawy** (6 sessions Jul–Oct 2024, hired 2025-01-04),
**Mahmoud AlSlamony** (3 sessions Aug–Oct 2024, hired 2025-05-24), **Omnia Elsherbiny** (2, 30–36
days before hire), **Aml Elmashad** (1, 71 days), **Rana Adel** (1, 69 days).

**Why:** the owner was asked directly on 2026-09-01 whether Hayam was working through late 2024. He
first answered "hayam yes", then ruled **"trust hiring date… then no"** — the hire date as recorded
is authoritative, and no `hire_date` is to be changed. So a session coached before their contractual
start is a real and accepted shape here, not a contradiction: coaching happens during assessment and
trial, while HR's `hire_date` is the contract date. Both columns are right at the same time.

**How to apply:** never "reconcile" these two columns against each other. Do not shift a coaching
date forward to clear the flag, and above all do not touch `hire_date` — it drives probation,
vacation accrual, proration and seniority, and changing one doubles that person's probation
reminders ([[hire-date-change-doubles-probation-reminders]]). If a sweep reports pre-hire coaching
reports, the expected count is **13**, and the correct action is to report it as expected and stop.

**The 14th was a genuine error and is FIXED - do not re-raise it.** `CR-2026-000240` (Hadeer
Abdelnaser) read 2025-07-12, 112 days before her 2025-11-01 hire; the source workbook says
**2025-12-07**, which sits 16 days before her next session. The owner approved it on 2026-09-01 and
it was applied at 04:19 Cairo, guarded on the old value: one row, generated columns recomputing to
month 12 / quarter 4 / 2025. Pre-hire reports went 14 -> 13, people 6 -> 5, total still 116.

That row had ALSO been rewritten by direct SQL from another session at 03:10:15 Cairo the same
morning - twelve minutes after this session’s own batch of twelve, with no audit row and no way to
see what that session intended. So section 2 of the rollback
(`xlsx/coaching-datefix-2026-09-01-REVERT.sql`, copied to `F:\PHX backup\05-data-files`) restores
THAT session’s timestamp, not the 2026-07-18 import stamp the other twelve use.

Two more workbook facts worth keeping. **A real Excel date serial does NOT prove the value is right**
— it only records how that machine's locale read what was typed, so the workbook itself carries bad
cells (it holds a 2026-09-02 and a 2026-12-01 that are in the future). And the import is **not**
systematically day/month swapped: of 26 dates where such a swap would be invisible, **20 agree**.
Where the two disagree, judge the single cell on sequence and plausibility — on that test the
database is right for Ahmed Helal `CR-2026-000220`, Hana Ghoniem `CR-2026-000189` and Samir Saad
`CR-2026-000190`, and Omnia `CR-2026-000274` is still undecidable.

**Eman Ahmed `CR-2026-000199` is RESOLVED and FIXED - do not re-raise it.** It read 2026-04-05;
three sources put that session on **2026-05-04**: the 2026 double-visit book’s May sheet (a TEXT
cell, day > 12, so Excel never reparsed it), `Q1 Coaching Report 2026.xlsx` row 19 at score 80
matching the report’s own 80, and `x\May Cocahing Report 2026.xlsx`. Applied 2026-09-01 04:36
Cairo, guarded, one row, generated columns 5 / Q2 / 2026; total still 116 and Jan-Jun 2026 still 25.
Rollback is SECTION 3 of the same revert file.

**The 2024 and 2025 double-visit books were swept on 2026-09-01 and need no action.**
`Double Visits Full Coaching 2024.xlsx` (41 sessions, June-December) and `...2025.xlsx`
(71 sessions) use a different layout from the 2026 book - one row per session, headers
`Name | Line | Area | Date | Direct Manager` on row 1, month in the sheet name. They hold
**7 genuine day/month swaps** (4 in 2024: Ahmed Abdallah, Mayar Hussien, Mahmoud Abdel Rady,
Mohammed Adel; 3 in 2025: Ahmed Sherief twice, Mary Morad). **Not one of the seven reached the
database** - all seven are reps with no `coaching_reports` row at all. Do not "fix" them.

The reason is the population, and it is the thing to know before ever reconciling these books:
**the books and the database barely overlap.** 81 distinct reps appear across the two books;
only 15 people have a 2024/2025 report in the system, and just 8 names are in both. Where they
do overlap, **9 of 10 book dates match the database exactly and none conflicts** - so no swap
propagated. The system’s 2024/2025 reports came from the HISTORICAL rows at the bottom of
`Q1 Coaching Report 2026.xlsx` (rows 117-122 are Aya.Ibrahim’s six 2024 sessions, matching
`CR-2026-000228` through `000233` date for date), NOT from the double-visit books.

Two format notes for anyone re-parsing them. Both books were authored on **two machines**: 75
dates are correct real Excel dates including 48 with day > 12 (impossible from an m/d parse),
while all 25 text cells have day > 12 - the m/d machine’s signature, day <= 12 silently
swapped, day > 12 left as text. And the 2025 June sheet uses a bare `DD-M` shorthand with no
year (`17-6`, `18-6`, `23-6`, `24-6`, `25-6`); all five are day > 12 so unambiguous, and
Rana Adel’s `17-6` matches `CR-2026-000277` at 2025-06-17.

One coverage gap worth remembering rather than chasing: the 2025 December sheet records a
Hadeer Abdel Naser session on **2025-12-29** (October area, manager Taha Mohamed) that is in no
report. It does not contradict the `CR-2026-000240` correction above - the books record only
double visits, so they are a partial record in both directions.

Related: [[pre-hire-blocks-will-alarm-when-a-reconcile-reaches-january]] is the CRM-visit half of the
"pre-hire looks broken but is expected" family, and is a separate mechanism.
