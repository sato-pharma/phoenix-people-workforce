---
name: renaming-an-hr-id-is-eight-places-and-the-auth-email
description: "Renaming an employee's hr_id has NO governed workflow in the repo — the immutability trigger names one that does not exist; done once 2026-10-10 (OF-0005 to HR-011) in one DO block, and the order matters"
metadata:
  node_type: memory
  type: reference
  originSessionId: 38ad5b8c-2930-4ae6-bcff-40740f663cc9
  modified: 2026-10-10T18:10:40.720Z
---

`phx_employees_prevent_hr_id_update` refuses any `employees.hr_id` change and its message points at a "governed HR_ID rename workflow" that exists nowhere (no function in `public`/`au`, nothing in `src/` or `supabase/`). Owner asked 2026-10-10 to move Yomna Gamal from `OF-0005` to `HR-011` (the HR series is three digits: `HR-009`, `HR-010`); done by hand in ONE `do $$` block on production.

**The places a fresh hire's id lives (all scanned, one row each):** `employees.hr_id` (its cascading FKs move `app_auth_users.hr_id` and `user_access_profiles.hr_id` for free), `app_auth_users.login_id` + `auth_email`, `user_access_profiles.login_id`, `employee_compensation.employee_hr_id`, `employee_salary_change_log`, `new_hire_mailbox_tasks` (`employee_hr_id_key` is GENERATED, never write it), `position_vacancies.filled_by_hr_id` (+ the note text), the `new-hire-mailbox:<id>` row in `notification_events` (event_key, action_url, metadata), and GoTrue: `auth.users.email` + both metadata blobs + `auth.identities.identity_data.email`.

**Traps:** (1) `employee_compensation` FK has NO `ON UPDATE CASCADE` and is not deferrable — defer it with `alter constraint ... deferrable initially deferred` inside the transaction, then `set constraints ... immediate` and make it `not deferrable` again. (2) Re-enabling the trigger BEFORE the deferred checks fire fails with 55006 "pending trigger events" — re-enable after `set constraints immediate`. (3) The auth email is `phx-` + hex(lowercased login id) + `@auth.phoenix.local`, so it MUST move with the login or sign-in breaks. (4) A first attempt that deleted and re-inserted the pay row was declined by the classifier; deferring the FK deleted nothing and went through. (5) `audit_logs` and other history keep the old id on purpose.

**Why it was cheap:** she was three hours old and had never signed in. A person with sales rows, payroll runs or CRM history has many more `employee_hr_id` columns with no foreign key; scan every text column first, and size the scan (a full `ilike` over `source_of_sales_*` times out).

The head-office organogram holds no seat for HR people (`au.v_org_tree` is the sales seat model), so nothing there needed a change; the Employee Master and the organogram read `employees` live. Related: [[deleting-an-employee-needs-a-full-text-scan]], [[au-org-tree-is-sales-only]].
