---
name: ats-candidate-children-one-has-no-fk-and-one-is-a-view
description: "ats_candidate_status_events has NO foreign key onto ats_candidates ON PURPOSE — adding ON DELETE CASCADE does not tidy the orphans, it BREAKS deleteCandidate with SQLSTATE 23001. And ats_candidate_source_context is a VIEW, not a table."
metadata: 
  node_type: memory
  type: project
  originSessionId: b37bf0c4-a7f9-4d42-b7e5-280ac5ac183a
  modified: 2026-08-21T21:40:00.000Z
---

Verified against production (`ozucdzovmcqvepbozvqf`) on **2026-08-21**. **Corrected the same day** —
the earlier version of this file called the missing FK a defect and cited a merge service that does
not exist. Both were wrong; a task was raised off it that would have broken production.

**Four tables cascade or null themselves when a candidate goes:**

| child | column | on delete |
| --- | --- | --- |
| `ats_applications` | `candidate_id` | CASCADE (and with it `ats_application_events`, `ats_interviews`, `ats_files`) |
| `ats_candidate_cv_extractions` | `candidate_id` | CASCADE |
| `ats_files` | `candidate_id` | CASCADE |
| `ats_cv_intake_events` | `candidate_id` | SET NULL — the row **survives**, detached |

**Two do not:**

1. 🔒 **`ats_candidate_status_events` has NO foreign key — DELIBERATELY. Do not add one.**
   Its creating migration `supabase/migrations/20260815210000_candidate_status_vocabulary.sql` says
   so in the DDL itself (`-- No FK, on purpose — see above.`) and in the table comment: *an audit row
   that dies with the record it describes cannot testify about the deletion*. Yes, production holds
   7 status events and 1 is orphaned — **that is the designed outcome, not a bug.**

   **Adding `on delete cascade` breaks `deleteCandidate` outright.** The table carries an append-only
   `BEFORE UPDATE OR DELETE` row trigger (`ats_candidate_status_events_immutable`), which fires on
   the *cascaded* delete. Proven on staging 2026-08-21 with a faithful scratch replica:

   - `ON DELETE CASCADE` → `23001: child is append-only; DELETE is not permitted`; **the candidate is not deleted at all.**
   - deleting the orphan first (the migration's own prerequisite) → `23001: DELETE is not permitted`.
   - `ON DELETE SET NULL` instead → `23001: UPDATE is not permitted` (and `candidate_id` is `NOT NULL` anyway).

   So all three routes are blocked by design. If an orphan ever needs to stay *meaningful*, the fix
   is to snapshot the candidate's identity onto the event row at write time — never a foreign key.

2. **`ats_candidate_source_context` is a VIEW over `ats_cv_intake_events`, not a table.** It has a
   `candidate_id` column so it looks like another child to reassign; an `UPDATE` against it throws.
   It follows `ats_cv_intake_events` on its own and must never be added to a move list.

**There is no candidate merge feature in this repo.** `src/lib/recruitment/candidate-merge-service.ts`
and `tests/recruitment-candidate-merge.test.ts` do **not** exist, and no `mergeCandidates` function
exists anywhere — checked repo-wide 2026-08-21. `src/lib/recruitment/cv-extraction-merge.ts` merges
extraction *fields*, not candidates. Any prompt citing that merge service is repeating this file's
old error.

The `deduction_*` and `early_birds_*` tables also have a `candidate_id` column. Different domain
entirely — "candidate" there is not an applicant. Never touch them from recruitment code.

Real, still-verified constraints on `ats_candidates` / `ats_applications`:
`recruitment_applications_active_uidx` is UNIQUE on `(requisition_id, candidate_id)` WHERE stage is
not one of the five terminal stages, and `recruitment_candidates_{email,phone,national_id}_norm_uidx`
are partial UNIQUE — so a value can only be borrowed from a duplicate *after* the duplicate row is gone.

Related: [[ats-candidates-full-name-holds-the-whole-intake-envelope]] ·
[[append-only-tables-need-a-truncate-trigger]]
