---
name: employee-hr-id-compact-is-lowercase-so-upper-joins-nothing
description: "`deductions_candidates.employee_hr_id_compact` is LOWERCASE (`a12`, `cn0003`), so joining `upper(replace(salary_records.hr_id,'-',''))` to it matches NOTHING and every payslip value reads null — which looks exactly like \"not one EGP was ever paid\"; use `lower(...)`, and prove the join by checking a row you know was paid."
metadata:
  node_type: memory
  type: project
  originSessionId: 09976a7d-dce2-490f-8f9d-b61bf151e220
  modified: 2026-10-07T21:23:00.601Z
---

Hit on 2026-10-08 while sweeping the published months for approved deductions that never reached a
payslip. `salary_records.hr_id` carries the hyphen (`A-12`, `CN-0003`); the candidate tables carry
both `employee_hr_id` (`A-12`) and `employee_hr_id_compact`, and **the compact form is lowercase** —
`a12`, `b10`, `cn0003`.

So `upper(replace(sr.hr_id,'-','')) = c.employee_hr_id_compact` produces `A12 = a12` and matches
**zero rows**. Every `sheet_value` and `net_salary` in the sweep came back null, which is
indistinguishable from the answer the query was looking for: *nothing was paid*. The first run of
that sweep said 100% of approved deductions in two published months were never collected. With
`lower(...)` the same query showed most of them **were** collected to the exact piastre.

**Prove a money join before believing its verdict**: include a row you already know the answer for
(someone whose deduction you can see on the payslip) and check that row is non-null. A join that
silently matches nothing answers every "was this paid?" question with "no". Same family as
[[a-mismatch-query-hides-the-row-that-matches]] and the `employees.crm_id` trap in
[[the-crm-departed-exclusion-is-119-ids-not-56]].

`deductions_categories.salary_records_column` is the authoritative category → payslip column map
(`crm`→`crm`, `fingerprint`→`finger_print`, `unpaid_vacation`/`insufficient_balance_vacation`→
`unpaid_vacations`, `loan`→`loans`, `no_records_activity`/`other`→`other_deductions`) — read it
rather than hand-mapping, and note `crm` is the one category with `requires_approval = false`.
