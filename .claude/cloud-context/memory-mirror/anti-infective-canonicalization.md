---
name: anti-infective-canonicalization
description: "The anti-infective line DISPLAY spelling is 'Anti Infective' (both words capitalized) everywhere — owner's 2026-07-18 choice, applied to code + prod. Durable: NEVER change the lowercase alias KEYS ('anti inf'/'anti infective') — they match historical uploads; a full-table DB audit here must sweep ALL schemas (au/analytics), not just public; a case-insensitive JOIN key with two casings FANS OUT (au.sos_official_line_map doubled a whole line); and a label fix to closed payroll rows needs the session_replication_role='replica' txn pattern."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1f81d292-1528-4418-8ca1-a59a159d0cc0
  modified: 2026-09-26T05:33:10.870Z
---

Owner standardized the anti-infective line DISPLAY to **"Anti Infective"** (both words capitalized)
everywhere, 2026-07-18 ("fix permanently"). It was a NEW 4th variant chosen over the pre-existing
"Anti infective" (sales/SoS canon), "Anti Inf" (abbrev) and "Anti-Infective" (RBAC bucket). Applied to code
(canonical OUTPUT values in `org-rules.ts`, `sales/access-scope.ts`, `admin/access-control.ts`, admin UI
labels, rbac SQL) and to prod data across ~27 tables. A guard test
(`imports-line-canonicalization.test.ts`) pins `lineRules` value slugs to a real `lines.code`, and
`canonicalizeSalaryLineLabel` in `payroll/salary-import.ts` stops payroll uploads reintroducing "Anti Inf"
([[lines-import-canonicalization]] is the org-import recurrence guard).

## The load-bearing rule — never break this

🔴 **Every LINE-MATCHING path is case-insensitive** (`normalizeLineKey`, the SoS RPCs' `lower(btrim())`,
`normalizeDepartmentLookupKey`, `canonicalSalesLine`), and **all LOWERCASE ALIAS KEYS are load-bearing** —
they catch legacy sheet data. Flipping DISPLAY casing is safe; **NEVER change the lowercase alias keys**
(`"anti inf"`, `"anti infective"` in the access-scope/marketing/admin maps) — they must keep matching
historical uploads.

## Reusable lessons this task produced

- 🔴 **A full-table DB audit here must sweep ALL schemas, not just `public`.** The first "zero residual"
  sweep was scoped to `information_schema` with an implicit `public` filter and MISSED the **`au` schema**
  (area-unification seats/org-tree/lines — `au.lines`, `au.seats`, `au.occupancy_history`,
  `au.sos_official_line_map`), which duplicates line data independently and feeds `au.v_org_tree` →
  `au_v_org_tree` → the live Organogram page's line picker. **Query `pg_namespace`/`pg_class`/`pg_attribute`
  directly** (or enumerate `select distinct table_schema`) — this DB has real non-public schemas with
  independent copies of reference data: `au` ([[area-unification-42-areas-design]]), `analytics` (views —
  trace to already-fixed public fact tables), `supabase_migrations`.
- 🔴 **A case-insensitive JOIN key that holds two casings is a FANOUT, not a harmless duplicate.**
  `au.sos_official_line_map.official_line` held BOTH `Anti infective` and `Anti Infective`; because the join
  lowercases both sides, every Anti-Infective fact row matched TWICE, so `au.f_monthly_attribution` returned
  exactly 2× the real units in every 2026 month — it only never shipped because the rollup hadn't refreshed
  since 2026-08-14. Fixed by deleting the duplicate and adding a unique index on `lower(btrim(official_line))`.
  So a column deliberately left alone as "a pure case-insensitive matching key" is NOT automatically safe —
  a duplicate casing inside it doubles the line. [[a-case-duplicate-line-map-row-doubled-a-whole-line]]
- **A composite or cached-string column needs a substring `replace()`, not a column overwrite** —
  `group_key` is `"CODE|Name|Line"`, `geo_locations.address_text` is `"Sohag 2, Anti Inf, Egypt"`; overwriting
  the whole column is wrong.
- **Columns correctly left untouched (structural/historical, not display):** `au.seats.seat_label`
  (unreferenced), `payroll_copilot_flags.question` (audit sentences that describe a past change — rewriting
  falsifies history), `position_vacancies.vacancy_code` (structural slug).

## The closed-payroll mutation pattern

Approved/locked/paid `salary_records` rows are blocked by trigger
`phx_prevent_closed_salary_detail_mutation`, which lists `line` as an immutable Part-1 field. For a
label-only fix to closed payroll rows (owner-approved), do it in a single txn with
`SET LOCAL session_replication_role='replica'` (auto-restores on commit) — **never leave the trigger disabled
outside a txn.** ([[incentive-policy-lock]]: `salary-import.ts` imports from the locked `policy.ts` only.)

**Email surfaces are clean and structurally can't reintroduce it.** Most templates resolve the line via a
LIVE join to `lines.name` at send time (offers, resignations, `contract_renewal`) so a master fix reaches
them automatically; probation is the exception — its `{{line}}` reads a PERSISTED `line_name` column off
`probation_cases`/`probation_evaluations`, so correctness there depends on the stored value (verified
canonical). Payslip email cannot fire at all (policy is in-app/telegram only, plus `enforcePayslipEmailBlock`).
