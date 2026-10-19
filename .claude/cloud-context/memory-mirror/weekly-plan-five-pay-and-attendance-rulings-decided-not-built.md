---
name: weekly-plan-five-pay-and-attendance-rulings-decided-not-built
description: "Owner 2026-10-19, SHIPPED 19 Oct 09:05 Cairo (PR 6103, carried by roll-up 6109; worktree and branch retired): half-day leave does not complete a Group Product Manager's day; a half-Office day is judged on its office half in the reports AND the deductions; a Meeting half beside Office counts as office; attendance follows the approved weekly plan, monthly shown beside it; Employee 360 team plan tiles count Phoenix CRM weeks; deadline 23:59:59 Cairo. Rasha Sabry Sayed Khalifa's Pending 2 Aug full-day row (1,387.10 EGP) would become no deduction on a fresh August collection; it is untouched and decided on the Deductions screen."
metadata:
  node_type: memory
  type: project
  originSessionId: ebec7ccf-3c18-4300-a436-8b50d37c9f49
  modified: 2026-10-19T06:14:22.326Z
---

The five items parked after the weekly plan audit (PR 6095, PR 6099) were put to the owner as choices on 2026-10-19. He chose all five and said "build the five weekly plan rulings in one PR". The risk review then raised two more questions, and he answered those too. Everything was built in **PR 6103** (commits `e723d1354` and `103a67b2a`). It was carried by roll-up **PR 6109**, merged 19 Oct 08:46 Cairo as `5ceb260c2`, and live from 09:05 Cairo (production revision `7fe0bf7e5` contains it). The worktree `_wt-weekly-plan-rulings` and the branch `codex/weekly-plan-rulings` are retired.

1. **Half-day leave alone does not complete a Group Product Manager's day.** A half-day vacation or excuse covers only its own half (`planDayGapText`'s third argument, `isPlanLeaveActivity`).
2. **A half-Office day is judged on its office half, in the Day-by-Day Report AND in the deductions.** He answered "Deductions follow it too" when told that the fingerprint report, the deduction engine, had ignored the plan by design since 24 Jul 2026. This applies on an office-days-only seat only, through `judgedHalfDayPart`, which is passed to both of the engine's judgments. A half-day vacation keeps its own half, and the cancel rule still reads the real vacation.
3. **On a day with an Office half, a Meeting or Meeting with Team half counts as office.** His answer was "Meetings count as office". Office plus a meeting is a full office day; a meeting alone never makes one. This covers the Plans tab and a Phoenix CRM manager's admin "meeting" half.
4. **Attendance follows the approved weekly plan; the monthly plan only fills dates with no weekly plan**, and the report shows both when they disagree (`resolvePlanOfficeDay`, `planOfficeDayLabel`).
5. **Employee 360's team "Plans submitted / approved" tiles count the reps' Phoenix CRM weeks, once per week** (`countTeamPlanCompliance`). The old source, `employee_plan_headers`, refuses Medical Reps, so it read 0 for every field team.
6. **The no-weekly-plan deadline is 23:59:59.999 Cairo on the Monday** (`planDeductionGraceDeadlineForMonday`).

**Production impact, measured 2026-10-19:**
- Six seats are judged on office days only (A-8, A-10, A-12, B-122, B-155, B-157). They have 5 half-Office days since 1 Aug.
- One live charge is affected. Rasha Sabry Sayed Khalifa, 2 Aug 2026: she punched 10:04 to 14:00 on a day planned Office in the morning and Field in the afternoon. On record is "Deduct full day", 1,387.10 EGP, still Pending and never published. The real engine with her policy now gives Complete, with no deduction.
- Hany Saad Mohamed Omar has 16 September days where the monthly plan said Office and the weekly plan said Field. His seat is judged every working day, so only the label changes.

**Why:** these touch attendance and pay, so the owner decided each one. Before answering the Employee 360 item he asked what "amended" means: an amendment is a second copy of an approved plan that goes through approval again, and the old plan is cancelled when the amendment is approved.

**How to apply:** once 6103 merges this note is history, and the rules live in `.claude/rules/weekly-planning.md`, `time-off.md`, `employees.md` and `phoenix-crm-manager-plan.md`. Never offer the Rasha row as a chat decision: it is money, decided on the Deductions screen.
