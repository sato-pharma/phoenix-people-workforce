---
name: employee-import-blanks-salaries-and-job-title-creates-positions
description: "SETTLED, do not re-raise. The salary-blanking bug was the EMPLOYEE SAVE path (not the importer) writing money columns unconditionally - FIXED and live 2026-09-06 (PR #3324), now keyed on the payload, so the old 'snapshot salaries before every upload' ritual is RETIRED and the importer must not be re-suspected. Residual historical victims across three dates are owner-ruled NOT URGENT / closed. Durable importer facts that still bite: it NEVER overwrites an existing position/department/line, but a Job Title matching no position code silently CREATES a junk position - and the damage is that is_active offers it in the recruitment dropdown, NOT its null department_id (those org columns on positions are VESTIGIAL - nothing reads them; do not fill them). Never guess a salary - ask the owner."
metadata:
  node_type: memory
  type: project
  originSessionId: 0961e0bb-11bf-46ab-8811-622e9c283ca8
  modified: 2026-09-25T23:00:23.541Z
---

**SETTLED — the salary-blanking bug is FIXED, the importer was innocent, and the residue is owner-closed.
Do not re-raise, do not re-suspect the importer, do not reinstate the snapshot ritual.**

## What actually happened, and the one durable lesson

Seven head-office/executive people had every salary column nulled on 2026-08-10 (a blank sheet cell
written as NULL over a real value — the [[optional-field-written-unconditionally-is-a-silent-erase]]
shape, on money). **It was NOT the importer.** The confirm route
(`app/api/imports/employees/confirm/route.ts`) has guarded every money field with a conditional spread
since 2026-05-15. The real writer was the **Employees-screen Save** path — `employeePayload()` /
`resolveEmployeeCompensationInput()` in `src/lib/employees/employee-directory.ts` — which wrote the
money columns unconditionally, turning an omitted/blank field into a null. A first investigation
pointed the owner at the innocent confirm route and cost him a wasted task. **The lesson: prove a
write path by running the CALLER, not by reading the writer** — and `"import never overwrites"` is
true of ORG ENTITIES only, never of an employee's own salary.

## Fixed and live — PR #3324 (2026-09-06)

`employeeCompensationColumns(input, isUpdate)` now keys the write on the **payload, not the viewer**:
on UPDATE a money column (incl. `social_insurance_wage`) is written only when the save carries a
value, so an omitted/blanked field **preserves** the stored figure; on CREATE everything is still
written so a new hire's pay is never implicit. All three write paths are now safe (import always was;
`bulkUpdateEmployees` never touches salary). **So the "snapshot salaries before every upload" ritual
is no longer needed.**

⚠ **Deliberate live consequence:** clearing a salary is no longer reachable from the Employees screen
— an empty box preserves rather than clears (the safe direction: a failed clear is a visible no-op, a
failed preserve destroys pay nobody notices until payday). An actual blanking needs a governed path
that **does not exist yet** — if the owner asks to zero a salary, that is the answer, not a bug.

## Residual victims — owner-ruled NOT URGENT, closed (do not alarm on these)

A narrower signature (`social_insurance_wage` null while base/basic/gross/net survive) found more
victims across two further dates: **Group A** — 3 still-active people from the same 08-10 batch (`A-8`,
`A-10`, `AI-0001`), pay unaffected, statutory wage gone; plus `OF-0004` (typed base directly instead
of the net box). **Group B** — a separate, undocumented 2026-08-28 script hit 6 RESIGNED people with
real payslip history. Impact is limited: `salary_records` has no wage column of its own, so historical
payslips are preserved regardless of what `employees.social_insurance_wage` reads today — a
data-integrity gap on departed people, not an ongoing miscalculation. **Owner, 2026-09-06: just noted,
no fix, no decision sheet.** #3324 protects all of them going forward.

The four still-NULL actives (`AA`, `AB`, `B-185`, `OF-0002`) are all `payroll_eligible = false` — nobody
is underpaid, they have no payslip to restore from, **never guess a salary, ask the owner.**

**Do NOT chase these look-alikes:** `medical_insurance` null is normal (never auto-derived for anyone —
`SALARY_AUTOFILL_KEYS`); `base_salary = 0` + `net_salary = 2500` + zero payslips is the standard
day-one-exit placeholder; a `%HIST%` hr_id (`B-HIST-MG`) is a one-off historical placeholder, not a
convention.

## The importer's org-entity behaviour — still true, still a trap

- **The real hazard is CREATION, not overwriting.** `Position` is optional and **`Job Title` substitutes
  for it**, so any job title whose `createOrgCode(...)` matches no existing `positions.code` silently
  inserts a NEW position with no department/line/area, and links its employees to it instead of the
  real seat. It never overwrites an existing position/department/line (`collectOrganizationEntities`
  drops already-existing codes, so the upsert's update branch is unreachable). `upsertDepartments`
  receives `[]` (dead code, by design); `upsertAreas` is resolve-only — do not "fix" either into a real
  upsert.
- 🔴 **The null `department_id` is NOT the damage — do not fill those columns.** Nothing reads
  `positions.department_id`/`line_id`/`area_id`/`team_id` — only `id`, `code`, `title`, `is_active` are
  ever selected, and `v_active_organogram` takes department/line/area from the EMPLOYEE. Those columns
  are vestigial. **`is_active` is the field that bites:** `listPositionCatalogue()` offers every active
  position (minus `NON_RECRUITABLE_POSITION_CODES`, which holds only `"ceo"`) in the recruitment
  requisition dropdown, so a junk seat shows up as a hireable role. Deactivate a genuinely unheld junk
  seat (guarded on all four reference counts being zero) rather than deleting — nothing here is ever
  deleted.
- **Team upsert was the ONE real overwrite path — FIXED insert-only 2026-08-28 (PR #2555,
  `splitInsertOnly()`), pinned by `tests/employee-import-team-resurrection-guard.test.ts`.** It used to
  resurrect a deliberately deactivated team and overwrite its name/area. Durable forensic note from
  that chase: a bulk `UPDATE` outside the app writes no `audit_logs` row and does not bump
  `updated_at`, so **`updated_at` is not a reliable "when changed" signal on `teams` — use `age(xmin)`**
  (flipped rows read ~91 txns of age vs ~1.25M for untouched).
- **Position titles are GENERATED from the code, not typed** (`toTitleCase(code.replace(/_/g," "))` —
  that is where "Hr Manager", "Qppv", "Ceo", "R And D Manager" came from). Fixed 2026-08-28 to the
  shared `src/lib/imports/org-title-case.ts` `toOrgTitleCase()` (PR #2563), pinned by
  `tests/org-title-case-acronyms.test.ts`. If you ever touch it: the acronym set is grounded in
  production data (`ceo hr qppv sfe cns bhr`), **`it` is deliberately excluded** (also an English word,
  runs over every org name); `R&D` needs a phrase rule (`r&d` in the set) or a second pass degrades it;
  and the real invariant is the round trip **`createOrgCode(toOrgTitleCase(code.replace(/_/g," "))) ===
  code`** — a title that no longer slugs back to its own code makes the next import insert a DUPLICATE
  seat.

## The importer keeps NO history

No `*_import*` table covers employees and `audit_logs` holds no employee-import row — a wipe is
invisible unless you look, and `updated_at` only says the row was touched, not which column. To learn
what a sheet WOULD write, simulate: `createEmployeeImportPlan(rows, { existingState })` against a live
`loadEmployeeImportExistingState(...)`, then read `organizationEntitiesToCreate` (read-only). Never
realign a leaver's job title to match a seat they never held — that falsifies the record to satisfy a
string match; nothing references a position by `code` anyway (every FK is `position_id`), so a realign
only changes which spreadsheet spelling matches next import.

Related: [[never-change-the-organogram-skeleton]] · [[au-org-tree-is-sales-only]] ·
[[optional-field-written-unconditionally-is-a-silent-erase]] · [[people-with-no-salary-figure-are-priced-at-nothing]]
