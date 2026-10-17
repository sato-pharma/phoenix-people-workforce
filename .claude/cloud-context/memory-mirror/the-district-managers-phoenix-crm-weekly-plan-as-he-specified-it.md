---
name: the-district-managers-phoenix-crm-weekly-plan-as-he-specified-it
description: "The DM's weekly plan in Phoenix CRM — the rep's numbered form inverted (pick a REP, tick that rep's doctors per half-day, or Admin, or a Single visit); the owner's rulings of 2026-10-16, BUILT on branch claude/district-manager-weekly-plan-69415c on 2026-10-17 as seven phoenix_crm_manager_* tables; migration applied to staging and production 2026-10-17; merged as #6025 at 11:12 Cairo the same day and live since about 11:23; his 'never skip the NSM after a regional manager' rule (week, edit asks, removals) merged as #6032 at 12:20 Cairo, its migration 20261017120000 on production since 12:06."
metadata:
  node_type: memory
  type: project
  originSessionId: 551fda9a-c5f4-4b2d-b228-a1f47c253abd
  modified: 2026-10-17T09:20:57.146Z
---

Owner, **2026-10-16**, specifying the managers' weekly plan starting with the district manager:
*"exactly like the numbered form that the medical reps use … instead of the doctors appearing like
medical reps, will appear the medical reps and the bricks they are going to today"*, and
*"I press on week three, then Saturday. Under Saturday will appear all the medical reps in my team
and where they are going this day. If I select the medical rep of Nasr City, then my plan as a
district manager for this day is Nasr City."* Every ruling below is his own word, given in chat over
five rounds that day. **Built 2026-10-17** on branch `claude/district-manager-weekly-plan-69415c`
(module memory `phoenix-crm-manager-plan`, account `docs/phoenix-crm-manager-plan.md`); merged on his
word as #6025 at 11:12 Cairo. The migration `20261017000000_phoenix_crm_manager_plan.sql` is applied on BOTH
databases — production on 2026-10-17 about 01:14 Cairo, on his words "apply the district manager plan
migration to production", via `scripts/apply-sql-file.mjs` after the MCP declined it (the merge
function body holds `delete`s). No ledger row on either; all eight function digests equal the file
(as-is LF), recorded in `ACKNOWLEDGED_EXCEPTIONS`.

**The form — four numbered steps, the rep's form inverted**

1. **Replaces** the DM's old Weekly/Monthly form (`employee_plan_headers`); it does not run beside it.
2. **One week only, the coming Saturday's**, due Thursday 23:55 Cairo like his reps'. Sat–Wed AM and
   PM, Thursday a morning, never Friday; a holiday holds nothing.
3. **A day is AM and PM, each its own choice** — rep A's morning, rep B's evening, or a morning out
   and an admin afternoon.
4. **With a rep:** his reps appear with where they are going; he picks one and **that rep's own
   doctors for that half appear — he marks some or Mark all** (*"for example 10. The district manager
   mark on, for example, 6, or mark all. And this is his plan for today."*). So the DM's plan item is
   the same shape as a rep's: a customer, a place, AM or PM.
5. **Admin:** the **seven day activities already in Phoenix CRM** (Meeting, Conference, Health day,
   Sales day, Training, Admin work, Travelling, half-day flag, note).
6. **Single visit:** an **area of his district**, then doctors from that area's rep list **or a
   doctor he types** — name, **Capture location optional but available** (the pin resolves address,
   area and brick server-side), specialty, contact info, optional comment.
7. **Send → his RSM / NSM, as today** (Hany Saad's DMs → Hany → Ali Mohamed Ali). **No HR
   acknowledge, no SFE step.** 🔴 **Widened 2026-10-17 about 11:20 Cairo, his words: "if regional manager
   applicable then after the rm approve the nsm also must approve never skip"** — after ANY RSM, the
   NSM above that seat approves too, read from the organogram (`managerPlanApprovers`), not a named
   pair. About 11:30 the same day he answered the two follow-ups in chat: scope **"Week + edit asks +
   removals"** — his ask to reopen a sent week and his ask to remove an own-list customer get the same
   RSM → NSM steps — and an empty NSM seat above a regional manager → **"The CEO"**. Migration
   `20261017120000` applied to staging about 11:45 and to PRODUCTION at 12:06 Cairo on his words
   "apply the manager asks second-approval migration to production" (apply-sql-file, no ledger row);
   the code merged as #6032 at 12:20 Cairo the same day on "merge the never-skip regional manager PR
   when green", opened early on his "open the never-skip regional manager PR now with the hold override".

**The rules he set around it**

8. **The rep never sees it** — his 2026-10-02 ruling, unchanged.
9. **Ticking a rep is NOT a double visit** — *"the double visit is only counted when the rep submit
   and log a visit and choose double visit and his manager"* — and he ordered **a separate report
   comparing the district manager's actual versus planned**, read by **him, his RSM, his NSM, the SFE
   Manager, the CEO and the Administrator**.
10. 🔴 **Every planned half-day has an actual, so nothing is unverifiable: HE logs the single visit
    when he is alone, and the REP logs the visit naming him when they are together** (his answer that
    closed the one gap the audit raised).
11. **His own log takes Capture location, optional — NO photo and no accuracy gate.** He is a manager,
    not a rep at a door.
12. **A rep who has not sent his week shows his DRAFT doctors, marked not sent**; a rep with **no plan
    at all is SKIPPED normally**, no flag and no empty day; **a rep who submits AFTER the DM sent his
    own week is caught by Ask to edit**, and **his RSM/NSM approves that reopening**.
13. **A rep who later drops a doctor the DM ticked: keep the DM's row and FLAG it**, never silently
    remove it.
14. **The grade on a doctor he adds is his: A/B/C AND the potential grade** — and **there is no
    validation step at all**, because he is a manager (*"there will not be validation because they are
    managers"*).

**Two lists — and they are NEVER merged**

15. 🔴 **The district manager has TWO lists: the union of all his reps' lists, and "Manager's own
    list" — the doctors he has single-visited — and the second is never merged into the first** (his
    own words: *"the district manager should have two lists. The list which is of all his medical reps
    and a separate list that he did the single visits before"*; he chose the name).
16. It lives as **a section in his Team tab, beside Customer lists** (where his reps' lists already
    show).
17. **A typed doctor who matches one already on a rep's list: offer the match and he picks the
    existing row** — folded the way `phoenix_crm_fold_name` already folds names, so one doctor never
    holds two rows and the duplicate board never reports him.
18. **Removing a doctor from Manager's own list needs his RSM/NSM's approval.**
19. **His own single visits count in his own report only** — confirmed in his last round, no longer
    an inference: never in a rep's or the district's coverage, call rate, frequency or target. And
    the old Phoenix CRM **"My own visit" is closed for a DM-seat holder**; the 25 already logged stay.

**The last round (2026-10-16)**

20. **Namesakes are real:** a typed name matching an existing customer is OFFERED first, never
    refused — "a different doctor with the same name" is allowed.
21. **Unplanned visits are shown apart; products optional.**
22. **The Administrator may approve or return in place of any holder**, shown as "by the
    Administrator".
23. **Mohamed Alaa Eleiwa stays on the old form until his team starts**; the switch is per DM, the
    day his own Phoenix CRM team is live.
24. **Nosiba Salah files BOTH** her rep week and her manager week.
25. 🔴 **The running week may be filed too, not only the coming one** (owner, 2026-10-17, asked in
    chat with the audit's finding that the build offers both — he chose "Coming week and the running
    week"). This corrects ruling 2's "one week only"; the build's behaviour is right, so do not narrow it.
26. 🔴 **Ticking a rep's customers offers doctors only — never his pharmacies** (owner, 2026-10-17, same
    round; he chose "Doctors only"). The build already never loads them; the pinned
    `halfOfListType("Pharmacy")` branch is dead code, not a rule.

**Why:** the DM files a plan today that nobody builds from his reps' real days, so his week and his
team's week are written twice and agree by hand.

**How to apply:** the half he already ordered exists — `phoenix_crm_double_visit_plans` (2026-10-02,
`manager_hr_id, week_start, plan_date, half, seat_id, rep_hr_id, line_code`) with its screen at
`/employee-portals/dv-planner`, holding **1 real row in two weeks** because it does only double
visits, is never sent or approved, and is not the plan a DM is judged on. It is RETIRED by this build
(its POST answers 410, its screen is deleted; the Visit report still reads its one old row). The
build uses **its own seven tables, not `phoenix_crm_plans`/`phoenix_crm_plan_items`** — every
rep-plan reader scans by seat or week and `phoenix_crm_save_plan` refuses a seat that owns no
customers. The rep's caps
(AM 5, PM 15, 3 per polyclinic) are **stood down** on a DM's plan: every doctor he ticks already sits
on a rep's capped day. Measured the same day: DMs filed **854 plan items over 42 days since 1
September** — Double Visit 450 (53%, 444 naming a rep, all 450 an area), Single Visit 164, the admin
family 222, Vacation 18, **Coaching 0** — so his three options are 98% of what they already do. **Six**
readers of the old plan were re-pointed through one adapter (`server/manager-plan-readers.ts`):
Planning Calendar, Approvals Hub, the landing plan card, Action Center / Decided for me, the private
and company calendars — attendance office days, the CEO Command Center and Employee 360 never
included DMs, so the first count of nine was wrong. **No payroll exposure** — the no-weekly-plan deduction is an allow-list of Product Manager
and Group Product Manager only, so no DM is ever charged. Related:
[[sos-monthly-closing-is-the-only-sales-truth]].
