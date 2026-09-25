---
name: marketing-approver-hrid-casing-fk
description: "REPO-WIDE trap: writing a lower-cased HR_ID into any employees(hr_id) FK breaks the feature 100%, disguised as \"schema not ready\". Hit marketing, resignations, probation feedback."
metadata:
  node_type: memory
  type: project
  originSessionId: b87d285f-1478-474e-b82a-93a69235ee66
  modified: 2026-08-05T11:53:58.517Z
---

**This is NOT a marketing bug — the file name is historical.** It is a repo-wide class that has now
broken four separate features. If you are touching ANY `*_hr_id` write, read this first.

**THE RULE:** never write `normalizeHrId(...)` / `canonicalHrIdKey(...)` output (both LOWER-case)
into a column that FKs to `employees(hr_id)` — that column is exact, case-sensitive, and stored
UPPER-case (171 of 172 rows; the lone exception `c-o1` is a system placeholder with no login).
Resolve to the stored spelling first with **`resolveStoredHrId` in `src/lib/hr-id.ts`** (the shared
one — there are 4+ near-duplicate local resolvers, and growing a 5th is how this keeps recurring).

**Why it hides:** reads use `.ilike` / `hrIdsMatch`, which are deliberately fuzzy (case,
punctuation, `aaa`→`aa` alias). So the *check* passes and the *write* dies with SQLSTATE 23503.
Worse, app error-mappers keep mislabeling the constraint violation as **"schema is not ready"** /
"schema not applied", sending diagnosis after a migration that was never missing. Fixed in
resignations 2026-08-05 (`isResignationsSchemaMissing` no longer treats a bare table-name mention
as missing schema) — assume other modules still lie this way.

**Confirmed instances (all 100% broken, most never worked once):**
- 2026-06-19 marketing `assigned_hr_id`/`decision_by_hr_id`/`updated_by_hr_id` (PR #334)
- 2026-08-05 `employee_resignations.submitted_by_hr_id` — 32 rows, column NEVER once written (#1755)
- 2026-08-05 `probation_feedback_submissions.employee_hr_id`/`.submitter_hr_id` +
  `probation_feedback_comments.commenter_hr_id` — table had **0 rows ever** (#1766)
- 2026-08-05 `user_access_profiles.hr_id` — latent, admin-typed value, caught before it fired (#1772)

**How to hunt it (done 2026-08-05, found zero further instances):**
1. `pg_constraint` for FKs to `employees(hr_id)` → **72 columns across 40 tables**. Only these matter.
2. Grep insert/update/upsert payloads setting those columns; trace each value to origin.
3. **Resolve which `normalizeHrId` is in scope — there are 11 definitions, 5 lower-case, 6 UPPER.**
   `employee-directory.ts` and `attendance/raw-punches` shadow it with UPPER-casing versions and are
   SAFE; do not "fix" them.
4. Data tell: an FK column that is 100% NULL across many rows was probably never written successfully.

Related: [[dsms-performance-hyphen-stripped-hrid-bug]] [[hr-id-normalization-fix-2026-07]]
[[employees-line-name-not-line]] [[supabase-dual-project-schema]]
