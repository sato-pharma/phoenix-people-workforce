---
name: employee-import-blanks-salaries-and-job-title-creates-positions
description: "Seven employees had every salary column blanked on 2026-08-10 by the EMPLOYEE SAVE path (not the importer) writing money columns unconditionally — FIXED and live 2026-09-06, PR #3324, now keyed on the payload. A 2026-09-06 sweep found MORE victims on two more dates: 3 active + 1 unrelated with just social_insurance_wage nulled from the same 08-10 batch, and 6 RESIGNED employees with real payslip history hit by a separate, undocumented 2026-08-28 incident. Owner: not urgent, just noted. Also: the importer cannot overwrite an existing position/department/line, and a Job Title matching no position code silently creates a new position with no department."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0961e0bb-11bf-46ab-8811-622e9c283ca8
  modified: 2026-09-05T22:02:21.739Z
---

**⚠ "NEVER OVERWRITES" IS ABOUT ORG ENTITIES ONLY — THE IMPORT DOES BLANK AN EMPLOYEE'S OWN SALARY.**
Measured in production 2026-08-28. The import that finished **2026-08-10 16:16:46** Cairo
(`employee_import_completed`, actor `A-16`) wrote employee rows at 16:16:42–16:16:45. Of ~95 rows
touched, **7 came out with `base_salary`, `basic_salary`, `gross_salary`, `net_salary`,
`medical_insurance`, `social_insurance` and `taxes` all NULL**, while the other ~88 kept theirs
intact. A blank column in the sheet is written as NULL over a real value — the
[[optional-field-written-unconditionally-is-a-silent-erase]] shape, on money.

The seven are the head-office/executive group, i.e. exactly the people whose pay is not in the
uploaded sheet: `A-12` National Sales Manager, `A-9` Marketing Manager, `B-10` HR Manager, `AA` CEO,
`AB` R&D Manager, `B-185` Finance and Admin Manager, `OF-0002` Financial Advisor. **`extra_cost_of_living`,
`fuel_allowance`, `payment_mode` and `social_insurance_wage` survived on all seven**, which is what
proves the rows had been fully set up and were cleared rather than never filled.

**Nothing failed and nothing warned.** The three actively-paid ones (`A-12`, `A-9`, `B-10` — seven
payslips each) had drawn a correct July salary hours earlier; the run published 10:11 and the wipe
landed 16:16. `recommend.ts:174-189` prices a person only when one of base/basic/gross/net exceeds
zero, so from that moment **August would have paid all three nothing, silently** — 184,000 EGP a
month between them. **Restored 2026-08-28** from each person's own published July payslip
(`basic = base x 0.70`, the rate every healthy peer row carries; `social_insurance_wage =
min(basic, 16700)`, which only `B-10` was missing). The other four have zero salary records ever, so
there is no payslip to restore them from — ask the owner, never guess a salary.

**Before the next employee upload, snapshot these columns and diff them after.** The importer keeps
no history (see below), so a wipe is invisible unless you look, and `updated_at` only tells you the
row was touched — not which column changed.

**Reading `upsertPositions` in isolation is how you get this wrong.** `app/api/imports/employees/confirm/route.ts`
upserts positions/departments/lines with `{ onConflict: "code" }`, which *looks* like it overwrites a
curated `title` and `department_id` from the spreadsheet. **It cannot.** The caller filters existing
codes out first: `collectOrganizationEntities` → `addEntity(entity, rawValue, exists)` in
`src/lib/imports/employee-validator.ts` returns early when the code is already in `existingState`.
So the upsert only ever receives codes that do not exist, and its update branch is unreachable.

I reported the opposite to the owner on 2026-08-28 — told him a re-import would silently revert the
day's organogram cleanup — and he spent a task on a defect that was not there. **Prove a write path
by running the caller, not by reading the writer.**

Three more facts from the same measurement:

- **Departments are never touched at all.** There is no `addEntity` call for departments in the
  collector loop (deliberate: "must not create new departments from typo values"), so
  `upsertDepartments` receives `[]` on every run and is dead code.
- **`upsertAreas` is resolve-only by design** — areas are the fixed canonical set; it writes nothing
  and has a comment saying so. Do not "fix" it into a real upsert.
- **`upsertTeams` was the ONE real overwrite path — FIXED 2026-08-28, PR #2555 / `b6863151`.**
  `loadTeamState` skips `is_active === false` rows when building the exists-set, but `upsertTeams`
  still found them by code and updated with `is_active: true` — so a deliberately deactivated team was
  silently resurrected and its name and area overwritten. Now insert-only via `splitInsertOnly()`
  (`src/lib/imports/org-entity-write-guard.ts`), pinned by
  `tests/employee-import-team-resurrection-guard.test.ts`, and the confirm response reports
  `preservedTeams`.

  **The exposure was measured twice within the hour and moved 2 → 57. Do not quote the 2.** At
  ~11:30 Cairo exactly **2 of 120** teams were inactive (both **Delta (1)**, while Delta (3) was going
  live) — that is the figure baked into the commit message, the PR body, and the comments in
  `org-entity-write-guard.ts` and the test, and it was true when written. By ~12:15 Cairo it was
  **57 of 120**, and the guard had merged at 12:16. **The near-miss is the point:** the 37 rows flipped
  in that window are the importer's own junk teams (`helwan_giza`, `fayoum_giza`, `imbaba_giza`, one
  "Cairo"/"Giza"/"Upper Egypt"/"ALEX-BHR" per area), i.e. somebody cleaning up exactly the mess this
  memory documents — and **the next employee upload would have reactivated every one of them**, because
  a deactivated team is what this bug resurrects. The cleanup was hours from being silently undone.

  **That bulk deactivation wrote no `audit_logs` row and did not bump `updated_at`**, so 37 rows still
  read `updated_at` = 2026-06-12 / 2026-07-17 while being freshly written — a plain SQL `UPDATE`, not
  an application write (every app path here sets `updated_at`). **`updated_at` is therefore not a
  reliable "when did this change" signal on `teams`.** Use `age(xmin)`: the flipped rows read **91**
  transactions of age against **1,257,230** for genuinely untouched rows — four orders of magnitude, so
  the test is unambiguous. No employee was stranded: all 138 team-assigned employees sit on active
  teams.

**The real hazard is creation, not overwriting.** The `Position` column is OPTIONAL, and **`Job Title`
substitutes for it** — measured, a payroll-shaped sheet with no Position column still drives position
creation. So any job title whose `createOrgCode(...)` matches no existing `positions.code` silently
inserts a NEW position row with **no department, no line, no area**, and every employee on that row is
linked to it instead of the real seat.

**But the null `department_id` is NOT the damage — do not go and fill those columns in.** Full audit of
`positions` on 2026-08-28 (21 rows, all active at the time): **nothing reads `positions.department_id`,
`line_id`, `area_id` or `team_id`.** Only `id`, `code`, `title` and `is_active` are ever selected, by
exactly four consumers — `employee-import-existing-state.ts:55`, `requisitions.ts:121`
(`listPositionCatalogue`), `requisitions.ts:199`, and the view `v_active_organogram`, which takes
department/line/area/team from the EMPLOYEE (`e.department_id`, …) and only `p.title` from the
position. Position 2 `Medical Representative` proves it independently: it carries line `Pedia` and area
`Assuit 2` while holding 111 employees across every line and area. Those columns are vestigial.

**`is_active` is the field that actually does something**, and it is where the real damage was:
`listPositionCatalogue()` returns every position with `is_active = true` minus the single owner-curated
exclusion in `NON_RECRUITABLE_POSITION_CODES` (which contains only `"ceo"`), so **a junk position is
offered in the recruitment requisition Position dropdown as a hireable role.**

Of the three importer-created seats, only ONE was junk. 236 `Regional Sales Manager` (Hany Saad Mohamed
Omar, PD-0001) and 237 `Financial Advisor` (Adel El Sayed, OF-0002) are legitimate — each was created by
the same import that created its holder, both are active people, and 237's null department is inert per
above. **235 `system_administrator` had no holder ever**, active or historical, no `employee_history`, no
`position_vacancies`, no `ats_requisitions` — created 2026-05-15 03:51 Cairo on an overnight import and
unused for three months. **Deactivated 2026-08-28 12:45:54 Cairo with owner approval** (`is_active =
false`, guarded on all four reference counts being zero); dropdown went 20 options to 19, and the table
still holds 21 rows because nothing here is ever deleted. Code/title alignment is now 21 of 21.

**The awkward position titles are GENERATED, not typed — the generator ran until PR #2563 (see the
end of this file).** `toTitleCase()` (then at `org-rule-engine.ts:64`, duplicated byte-for-byte at
`employee-normalizers.ts:91`; both copies are now gone) upper-cased the
first letter of each word and lower-cases the rest, and at `org-rule-engine.ts:110` and `:127` it is fed
`toTitleCase(code.replace(/_/g, " "))` — the CODE, not anything a human wrote. That is where
`hr_manager` → "Hr Manager", `qppv` → "Qppv", `ceo` → "Ceo" and `r_and_d_manager` → "R And D Manager"
came from. **Fixed in production 2026-08-28 with owner approval** to `HR Manager`, `QPPV`, `CEO`,
`R&D Manager`, `SFE Manager`; `createOrgCode()` lowercases before slugging and maps `&` to " and ", so
every one of the five kept its exact code (verified `code_still_matches_title` true on all five, and
`codes_not_matching_title` = 0 across all 21). The corrected titles are live in `v_active_organogram`.

**The per-row fix is durable.** A future import cannot rewrite those five, because
`collectOrganizationEntities` drops codes that already exist — the same filter that makes the
departments/lines/positions upserts insert-only.

**The GENERATOR is fixed too — PR #2563 MERGED 2026-08-28 13:10:48 Cairo, squash `a0b11e6b`.** All
four required checks green, and the new test was confirmed BY NAME in the `validate` job log
(`PASS org title casing keeps acronyms … (2ms)`) rather than inferred from a green job.
**Live in production 13:13:16 Cairo** — `/api/healthz` revision `a0b11e6b425a…`, ~2m28s
merge-to-serving, confirmed by ancestry rather than a SHA match because three other merges landed
inside that window (`f85fa8cd` → `b1684807` → `a0b11e6b`).
New shared module `src/lib/imports/org-title-case.ts`
exports `toOrgTitleCase()`; both private copies of `toTitleCase` are deleted and both files import it.
Pinned by `tests/org-title-case-acronyms.test.ts`, registered in `tests/run-tests.ts`, so it runs in
the required CI `validate` job.

Four things worth not rediscovering:

- **The acronym set is grounded in production data, not invented** — `ceo`, `hr`, `qppv`, `sfe`,
  `cns`, `bhr`. **`it` is deliberately excluded**: it is also an ordinary English word and this runs
  over every word of every department, line, area, team and position name, so the false positive costs
  more than hand-fixing one "It Manager". Weigh any other two-letter addition the same way.
- **`R&D` needs a PHRASE rule, not a word rule.** `createOrgCode` maps `&` to `" and "`, so the code
  `r_and_d_manager` reaches the caser as the three words `"r and d"` and no per-word set can rebuild
  it. The set separately carries `r&d` so the function is idempotent — without it a second pass
  degrades `R&D Manager` to `R&d Manager`.
- **The round trip is the real invariant, not the prettiness.** `collectOrganizationEntities` matches
  BY CODE, so a display name that no longer slugs back to its own code stops matching and the next
  upload inserts a DUPLICATE seat with employees split across the two. The test asserts
  `createOrgCode(toOrgTitleCase(code.replace(/_/g," "))) === code` for every case.
- **The duplication was the real defect.** Two byte-identical private copies meant "fixed" could mean
  "fixed in one of two places" with no signal. A source pin now fails if a local `toTitleCase` returns.

Measured across 177 production employees on 2026-08-28: only **3** job titles resolved to a
non-existent position code. Two were fixed by aligning the SEAT to the person, never the reverse —
position 12 `office_co_ordinator` → `hr_operations_coordinator`, and position 15 `finance_manager` →
`finance_and_admin_manager` with its title moved to "Finance and Admin Manager" to match its sole
holder B-185. The remaining two are inactive (A-13 resigned, A-15 historical payroll record) and were
deliberately left: rewriting a leaver's job title to match a seat they never held falsifies the record
to satisfy a string match.

**Nothing in the database references a position by `code`** — every reference is `position_id`
(`employees`, `employee_history`, `position_vacancies`, `ats_requisitions`, `v_active_organogram`,
`v_payroll_eligible_employees`), and no source file hardcodes one. So realigning a position code is
safe; what it changes is only which spreadsheet spelling matches on the next import.

**The employee importer keeps no history.** No `*_import*` table covers employees and `audit_logs`
holds no employee-import row, so there is no way to read back what the last upload contained. Simulate
instead: call `createEmployeeImportPlan(rows, { existingState })` against a live
`loadEmployeeImportExistingState(...)` and read `organizationEntitiesToCreate` — read-only, and it
answers exactly what a given sheet would write.

Related: [[never-change-the-organogram-skeleton]] · [[au-org-tree-is-sales-only]] ·
[[optional-field-written-unconditionally-is-a-silent-erase]]

---

## CORRECTION 2026-09-06 — THE IMPORT DID NOT DO THIS. The save path did.

**The measurement above stands; the ATTRIBUTION was wrong.** Seven people really were blanked on
2026-08-10. It was not the importer, and pointing the next session at
`app/api/imports/employees/confirm/route.ts` sent them to a file that was already correct.

**Proof the import is innocent.** The confirm route's conditional-spread guards on all seven money
fields were present that day — reconstructed from the commit that was HEAD at 16:16 Cairo
(`8c8caa654193c81c482026142f954669c9ac3094`), positive control 42,237 bytes read. It also has its
OWN `upsertEmployees` and never calls `upsertEmployee`.

**The real writer is `employeePayload()`** (`src/lib/employees/employee-directory.ts:1731`), which
writes `base_salary, basic_salary, gross_salary, net_salary, medical_insurance, social_insurance,
taxes, social_insurance_wage` **UNCONDITIONALLY** — exactly the columns that were nulled.
`resolveEmployeeCompensationInput()` (line 1684) returns raw `numberOrNull(input.*)` — i.e. null —
whenever `fixedSalary.baseSalary <= 0`. Two callers only: `app/api/employees/route.ts:156` (the
Employees screen Save) and `src/lib/hiring-pack/service.ts:1304` (already hardened; its comments are
the model for the fix).

🔴 **THE HOLE, AND IT IS STILL OPEN.** `app/api/employees/route.ts` ~134 DOES splice the stored
salary back in — but only `if (isSalaryRedactedForViewer(access, hrId))`, and that predicate
(`permissions.ts:2024`) returns false for every role except **HR Advisory** and **HR Operations**,
and then only for ids on `HR_SEAT_SALARY_REDACTED_HR_IDS`. **The protection is keyed on WHO IS
VIEWING, not on whether the payload carries values.** For every other role — Super Admin and CEO
included — a save with blank money fields writes nulls straight through.

**Why it fits:** the 2026-08-10 actor `A-16` held **Talent Acquisition**, live then (retired
2026-08-28), and NOT one of the two roles the guard covers — so the splice never fired for her, on
anybody. The seven were head-office/executive people whose pay was not in her sheet. `audit_logs`
holds no employee-write row in that window, which is why it was never traced.

**So: keep snapshotting until the fix lands, but stop suspecting the importer.** Fix task raised
2026-09-06, branch `codex/employee-save-salary-preserve`. The four still-null actives (`AA`, `AB`,
`B-185`, `OF-0002`) are all `payroll_eligible = false` — nobody is underpaid; never guess a salary.
Same shape as [[optional-field-written-unconditionally-is-a-silent-erase]], which is the pattern this
is an instance of.

### FIXED AND LIVE 2026-09-06

PR #3324 `fix(employees): write a money column only when the save actually carries one` merged
2026-09-05T21:40:19Z (00:40 Cairo) and is **serving in production** — merge commit `14217c12`,
verified an ancestor of live revision `98124102` via `git merge-base --is-ancestor` (ancestry, not a
SHA match, because several merges landed in that window). All four required checks green.

`employeeCompensationColumns(input, isUpdate)` now keys the write on the **payload**, not the viewer:
on an UPDATE a money column is written only when the save actually carries a value, so an omitted or
blanked field preserves the stored figure. On a CREATE everything is still written, so a new hire's
pay is never implicit. `social_insurance_wage` is protected on the same terms — it alone decides the
statutory filing. The route's viewer-keyed splice is deliberately left in place as belt-and-braces.

**So the "snapshot salaries before every upload" ritual is no longer needed.** All three known write
paths are safe: the IMPORT never had the bug (its confirm route has guarded every money field since
2026-05-15), the Employees screen Save is fixed by #3324, and `bulkUpdateEmployees` never touches
salary columns at all.

⚠ **One deliberate consequence: clearing a salary is no longer reachable from the Employees screen.**
An empty box preserves rather than clears — the safe direction, since a failed clear is a visible
no-op while a failed preserve destroys pay nobody notices until payday. If a salary must actually be
blanked, that now needs a governed path that does not exist yet.

The four still-NULL actives (`AA`, `AB`, `B-185`, `OF-0002`) are unchanged and unaffected — all
`payroll_eligible = false`, so nobody is underpaid. Never guess a salary; ask the owner.

### SWEEP 2026-09-06 — MORE VICTIMS FOUND, ON TWO DIFFERENT DATES. OWNER: NOT URGENT.

Swept production for the same signature after the fix shipped. The exact 4-column-null match is
still only the same four above — clean. But a NARROWER signature (`social_insurance_wage` null
while base/basic/gross/net survive) turned up two more, previously undiscovered groups. **This
corrects the "the other ~88 kept theirs intact" line near the top of this file — some of those 88
lost one column, not zero.**

**Group A — 3 more from the SAME 2026-08-10 13:16 UTC batch**, active and payroll_eligible today, pay
unaffected, statutory wage silently gone since that day: `A-8` Rasha Sabry Sayed Khalifa (Group
Product Manager), `A-10` Nahed Tarek Hassan Omar Hattab (Product Manager), `AI-0001` Momen
Abdelhady Mohamed Shehata (District Sales Manager). `A-8` and `A-10` also read `social_insurance =
0`, possibly a downstream echo of the missing wage. One more, unrelated: `OF-0004` (hired
2026-08-11, AFTER the incident) shows the same symptom from a different cause — most likely a save
that typed base salary directly instead of the net-salary box that drives the autofill chain.

**Group B — a THIRD, previously undocumented incident, 2026-08-28, hitting RESIGNED employees who
had real payslip history**: `B-174` (2 payslips, wiped 2026-08-05 — a day on its own), then five
more within 5 minutes of each other on 2026-08-28 — `B-153` (5 payslips), `OF-0003` (1), `CN-0005`
(1), `AI-0003` (0, but real salary + `social_insurance` intact), `PD-0006` (1). Each of the five
2026-08-28 rows carries its OWN distinct timestamp seconds-to-minutes apart — unlike the identical
single-microsecond batch above — consistent with a script processing them one at a time, each
losing whatever its payload did not carry. Root cause not chased further (they're resigned; no
future payslip is at stake).

**Impact is lower for Group B than for anyone still active: `salary_records` (the actual payslip
table) has NO wage column of its own** — only a per-month `social_insurance` deduction amount — so
whatever was filed historically for these six is preserved in their old payslips regardless of
what `employees.social_insurance_wage` reads today. This is a data-integrity gap (the live table
can no longer answer "what was this departed person's insured wage"), not an ongoing
miscalculation.

**Ruled out as noise: `medical_insurance` being null is NOT this pattern.** Confirmed in source
(`SALARY_AUTOFILL_KEYS` in `src/components/employees/employee-management.tsx`) — it is the one
salary-adjacent field never auto-derived for anyone, so it reads null for the large majority of
employees regardless of any incident. Do not chase it.

**Also swept, and separately closed:** three resigned employees confirmed clean — `PD-0011`,
`AI-0010`, `B-HIST-MG` — zero `salary_records` rows ever for any of them, so nothing was wiped;
consistent with a same-day hire-then-exit (or, for `B-HIST-MG`, a historical placeholder record —
the only `%HIST%`-pattern `hr_id` in the whole database, a one-off, not a convention). A separate,
minor, non-bug pattern: three more day-one exits (`AI-0004`, `PD-0007`, `AI-0006`) all show
`base_salary = 0`, `net_salary = 2500`, zero payslips — looks like a standard placeholder figure
for someone who leaves within days of joining, not a data-integrity problem.

**Owner's decision, 2026-09-06: not urgent — just noted, no fix, no decision sheet.** Do not raise
this as an alarm in a future session; it is a closed, acknowledged, low-priority item. PR #3324
already protects every one of these people going forward — the payload-keyed write means a future
save (even from whatever script hit Group B) now preserves rather than nulls these columns. What
remains is purely historical residue on people already resigned or on a handful of active people
whose pay was never at risk.
