---
name: new-hire-gets-no-organogram-seat-unless-replacing-someone
description: "Adding an employee is a 6-step chain with three silent breaks; Talent Acquisition could never finish a hire alone"
metadata: 
  node_type: memory
  type: project
  originSessionId: 152814ca-c602-4434-9eb3-c6b4b3627856
  modified: 2026-08-04T11:20:48.119Z
---

Adding an employee is a **chain**, not one action: `employees` INSERT →
`phx_autofill_replacement_vacancy_from_employee_insert` flips the matching `position_vacancies`
row to `filled` → `trg_position_vacancies_hire_into_seat` fires → `au.hire_into_seat` writes the
AU seat → the app separately calls `provisionNewHireAccess` for the login. On 2026-08-04 three
independent links were broken, each **returning silently with no error and no audit row**.

1. **The seat trigger gave up unless the hire replaced someone.** `phx_hire_into_seat_on_vacancy_filled()`
   returned early when `replacement_for_hr_id` was null — above its own exception handler, so not
   even a failure audit. Only resignation-opened vacancies carry a predecessor. Hit **CN-0006 Adel Srour**.
2. **A vacancy's manager is a frozen snapshot.** The autofill required
   `v.manager_hr_id is not distinct from new.manager_hr_id`; a box created while its DM seat was
   empty keeps `manager_hr_id` NULL forever, so nothing matched and the seat trigger **never fired
   at all**. Hit **PD-0007 Bahaa Gamal**. A box naming a *departed* manager fails the same way.
3. **Only Super Admin could create a login.** `upsertAccessUser` opens with
   `assertSuperAdminUserAdminActor`. Talent Acquisition (Youmna, A-16) can add employees but the
   login attempt always threw; the error was caught and shown as a note she had no permission to
   act on. **100% of her hires, every time.** She also lacked `recruitment:approve`, so she could
   not mark a candidate hired either — she could never complete a hire without the owner.

All fixed and **shipped in PR #1705 (merge c8342598, live 2026-08-04 14:17 Cairo)**: seat matching
is now three sequential tiers (exact manager → NULL manager → departed manager, each demanding
exactly one candidate), an unresolved seat always writes an `au_seat_hire_unresolved` audit row,
and `provisionEmployeeAccountForRecruiting` gives Talent Acquisition a create-only, rank-bounded
login path.

**Why:** the AU seat model, not `employees`, is the source of truth for org structure and vacancy
([[organogram-vacancy-occupancy-truth]]) — a missing seat makes a real employee invisible and leaves
a phantom vacancy. See [[no-data-must-never-render-as-absence-or-zero]].

**How to apply:** on "I added X but they are not showing", check `au.occupancy_history` for an open
row first — the `employees` row is almost always fine. **Zero audit rows = the chain broke BEFORE
the seat trigger** (look at the vacancy match); an `au_seat_hire_unresolved` row = it reached the
seat trigger and could not resolve a seat. Never widen a matching tier into a wildcard: areas
1096/1097 hold both a NULL-manager and a departed-manager vacancy, so a wildcard makes them
ambiguous and breaks paths that work — tiers must stay sequential. `upsertEmployee` writes **no
audit log at all**, so employee creation is undiagnosable after the fact. Non-REP tiers (DM/NSM/head
office) still have no seat fallback. An auto-provisioned login is always role **"Employee"**
(`resolveEmployeeAccessRole` ignores job title by design) — for a rep the only gap vs "Medical Rep"
is `weekly_sales: read, export`, still a Super Admin step.
