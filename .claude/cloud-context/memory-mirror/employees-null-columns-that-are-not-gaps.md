---
name: employees-null-columns-that-are-not-gaps
description: "Three employees-table columns read as \"missing data\" but are normal — contract dates are unused company-wide, birth_date derives from national_id, has_bank_account='no' is a supported paid state"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7a36d76b-63a9-4212-9794-da0e758431bc
  modified: 2026-08-10T10:20:15.998Z
---

Measured on production (`ozucdzovmcqvepbozvqf`) 2026-08-10, n=172 employees. Before reporting an
`employees` row as incomplete, check these three — otherwise you invent gaps that do not exist.

**1. All contract date columns are 0/172 — unused company-wide.**
`contract_signed_date`, `contract_start_date`, `probation_end_date`, `contract_renewal_date`,
`contract_day`, `contract_month_number`, `contract_month_clean` are NULL for **every single
employee**. A new hire "missing" them is not behind anyone. Filling them for one person makes that
row the odd one out. Ask before starting to populate them.

**2. `birth_date` is derivable from `national_id` — never ask for it.**
Egyptian national ID digits 2–7 are YYMMDD, digit 1 is the century (2→1900s, 3→2000s). Verified
**119 of 119** rows that hold both: the stored `birth_date` equals the ID-encoded date exactly, zero
exceptions. So collect `national_id` and derive:
`make_date(case substr(nid,1,1) when '2' then 1900 when '3' then 2000 end + substr(nid,2,2)::int, substr(nid,4,2)::int, substr(nid,6,2)::int)`

**3. `has_bank_account='no'` is a supported state, not a defect.**
58 employees are `'no'` and **42 of them already have salary records** — they get paid without a
transfer account. `'yes'` ⟺ `bank_account` present is perfectly consistent (110/110 yes have one,
0/58 no have one). Only `bank_name` values in use are FAB (97) and CIB (13).

Also: `photo_path` is `<hr-id>/<uuid>.jpg`, generated on upload through the app — it is never a
typed value, and only 6/172 rows have one.

Check constraints worth knowing: `has_bank_account` ∈ {yes,no}; `social_insurance_status` and
`medical_insurance_status` ∈ {yes,no,pending} — `pending` is legal though no row uses it yet.
Every District Sales Manager sits on `social_insurance_wage = 16700.00`.

Related: [[ask-business-facts-via-xlsx-dropdown-sheet]],
[[account-creation-defaults-role-to-employee]], [[add-employee-blank-area-manager-skips-autofill]]
