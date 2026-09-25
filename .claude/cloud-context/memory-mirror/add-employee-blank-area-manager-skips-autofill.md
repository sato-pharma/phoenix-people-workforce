---
name: add-employee-blank-area-manager-skips-autofill
description: "Leaving Area or Manager blank on the Add Employee form silently skips the replacement-ownership autofill, so the new hire never inherits the departed manager's markers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5c194da8-1fb5-425a-af33-70873cfbeca3
  modified: 2026-08-09T12:01:16.318Z
---

Creating an employee with **Area or Manager left blank** on the Add Employee form makes the
employee-insert autofill **skip the replacement-ownership engine entirely**. The employee row and
login are created fine, so nothing looks wrong — but the engine that re-points a departed manager's
loose ends to the new person never runs.

Confirmed live 2026-08-09 on **AI-0008 Magdy El Senosey** (NSM, Anti Infective, hired to replace
B-157 Sameh Ezzat). `position_vacancies.VAC-B157-S0H` records the cause in its own note:
*"Filled by Magdy El Senosey (AI-0008) on 2026-08-04. The employee-insert autofill was skipped
because Area and Manager were left blank on the Add Employee form."*

**What it left behind, all silent:**
- `app_auth_users.manager_hr_id` = NULL and `user_access_profiles.manager_hr_id` = NULL (both his
  NSM peers A-12 and B-122 carry `AA`). Harmless for access — permissions and email delivery read
  `employees.manager_hr_id` and `employees.work_email`, never these — but it is the tell.
- Three open Giza rep vacancies (`SEAT-AIF-REP-GZ2/GZ4/GZ5`) still parked on the CEO and still
  marked `manager_replacement_for_hr_id = 'B-157'` a week after the NSM seat was filled. A hire
  against them would have been created reporting to the CEO instead of the active Giza DM, making
  them invisible to the new NSM. Repaired 2026-08-09 (owner-approved).

**How to apply:** after ANY hire that replaces a departed manager, do not assume the org re-pointed
itself. Check three things: `app_auth_users.manager_hr_id` / `user_access_profiles.manager_hr_id`
are populated, no open `position_vacancies` still carry the departed manager in
`manager_replacement_for_hr_id`, and every open vacancy's `manager_hr_id` equals whoever occupies
its seat's `parent_seat_id` in `au.seats`. That last join is the real correctness check — a field
that merely changed is not proof. See [[au-seat-drift-view-is-the-org-truth-check]].

**Why:** the form skipping the engine produces no error, no log line, and a record that reads as
complete. The damage only surfaces at the NEXT hire, weeks later, as "why can't the manager see his
own rep".
