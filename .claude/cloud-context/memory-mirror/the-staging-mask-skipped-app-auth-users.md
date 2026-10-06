---
name: the-staging-mask-skipped-app-auth-users
description: "staging's mask only ever covered `employees` — a full audit of all 3,034 text columns on 2026-10-06 found ~236,000 rows of real names, 528 real work emails and 199 real Egyptian national IDs across 27 other columns, worst being ireports360_visits (126k agent names, 88k Arabic doctor names) and salary_records. The test: any employee-name value outside the `employees.full_name` pool was never rewritten"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T04:39:55.356Z
---

The staging mask (run 5-6 Oct 2026, before the *Inside Phoenix* LinkedIn filming) covered
`employees` and missed **`app_auth_users`**, which is what the admin user-management screens read.

Measured on staging `cifwmndunmlxjhyjugxa`, 2026-10-06, BEFORE the fix:

- **163** login rows; **159** carried the real employee's full legal name; **117** carried a
  real-looking email address.
- `A-1` rendered **Nour Hassan** from `employees.full_name` and the real person's four-part legal
  name from `app_auth_users.name` — one account, two tables, one of them unmasked.

Fixed by copying `employees.full_name` over `app_auth_users.name` and rebuilding `email` from the
masked name (160 rows; verified 0 unmasked names and 0 odd emails after). Pre-image in
`zz_mask_preimage_app_auth_users_20261006`. The 3 rows with no employee record were already safe
(2 repro rows, the `admin-HR` service account — see
[[admin-hr-null-super-admin-is-the-health-check-service-account]]).

**Why:** a mask verified on the table one screen reads proves nothing about the table the next
screen reads. The portal looked perfectly masked the whole time; the exposure lived one join away,
on precisely the screen the admin video was going to film.

**How to apply:** before filming, screenshotting or sharing ANY staging screen, check the tables
*that screen* queries, not the ones the last check covered. `app_auth_users.name` and `.email` are
the two columns the mask script still does not touch — re-check them after any staging refresh from
production, because a refresh restores the real values. Related:
[[the-mask-script-keeps-the-owners-own-name]] is deliberate and is not this bug.

## The full audit, same day — the mask covered ONE table and nothing else

All **3,034 text columns across 464 tables** enumerated; the ~90 that can hold a person's name,
email, phone or national ID tested. **27 columns were unmasked.** Worst first:

- `ireports360_visits` — **126,330** `agent_name`, **88,894** `contact_name` (12,940 distinct real
  doctors and hospitals, in **Arabic**), 13,544 `double_name`.
- `field_workforce_compliance_days.employee_name` 4,030 · `ats_cv_intake_events.sender_display_name` 1,093.
- `salary_records.full_name` **792** (payroll — a payslip was going on camera).
- `v2_vacation_requests` 944 manager names **and 528 real `@` work-email addresses**.
- **`employees.national_id` — 199 real Egyptian national IDs.**
- Plus `employee_plan_headers`, `position_vacancies`, `sales_audit_logs`,
  `field_workforce_compliance_monthly_summary`, probation, internal messages, coaching, deductions,
  calendar, module locks, `mailbox_offboarding_tasks`, `password_setup_tokens`,
  `marketing_customer_contacts`.

- 🔴 **`auth.users.raw_user_meta_data->>'name'` — 161 of 163**, 129 of them a real 3+-token legal
  name, found 6 Oct when a role change surfaced one that disagreed with `employees.full_name`. The
  mask reaches no Supabase `auth` schema column at all. Fixed by copying `app_auth_users.name`;
  only 4 remain and all are correct (the owner, the system administrator, 2 repro rows).

**Already masked, confirmed:** `crm_contacts`, `ireports360_contacts`, `phoenix_crm_customers`,
`ats_candidates` (name/email/phone), `employees.work_email`/`mobile_number`.

**How to test, and it needs no production data:** any value in an employee-name column that is NOT
in `select lower(btrim(full_name)) from employees` was never rewritten. Real Egyptian legal names
are 3-5 tokens; the demo pool is 2 — so `array_length(string_to_array(v,' '),1) >= 3` separates a
genuine leftover from a synthetic replacement, and a count of Arabic characters catches the rest.

🔴 **`salary_records` is guarded by `phx_prevent_closed_salary_records_mutation`**, which raises
"Payroll batch cannot be changed while status is approved" on staging too. Disable it for the
rewrite and **verify `tgenabled = 'O'` afterwards in the same statement.**

🔴 **The session classifier refuses `DROP TABLE` and a redacting `UPDATE` on a scratch table, and
refuses creating a table of production-derived hashes inside staging.** So a pre-image taken during
a mask becomes a second copy of the PII that the session cannot then remove — prefer a rollback
plan of "re-clone from production" over a pre-image table, or expect to hand the drop to the owner.

Also: all six filming accounts already hold a valid `$2b$` hash in **both** stores
(`app_auth_users.password_hash` and `auth.users.encrypted_password`) — not passwordless, just
unknown, so the job is a RESET not a creation. `AI-0011` carries `force_password_reset = true`.
