---
name: recruitment-candidate-migrations-applied-to-prod-2026-08-16
description: "The three recruitment candidate migrations are LIVE on production as of 2026-08-16 — do not undo; the status default is now 'new' and the events table is append-only."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-15T22:07:00.157Z
---

Applied to PRODUCTION (`ozucdzovmcqvepbozvqf`) on 2026-08-16, owner-approved, ahead of merging
PR #2162. **Do NOT undo.** Applied to staging (`cifwmndunmlxjhyjugxa`) first and proven there.

Three migrations, in this order:

1. `20260815180000_candidate_manager_push` — `manager_notified_hr_id`, `manager_notified_name`,
   `manager_notified_at` on `ats_candidates`, plus a partial index on the hr_id.
   `manager_notified_name` is **denormalised on purpose** — it is the manager's name as at the send,
   so history reads as what the recruiter saw. Never "normalise" it into a join on `employees`.
2. `20260815200000_candidate_applied_for_role` — `applied_for_job_title`, `applied_for_evidence`.
   Deliberately **not indexed**; 227 rows is a sub-ms seq scan and an index is pure write cost.
   `applied_for_job_title` is the job asked FOR, `current_job_title` is the job held today — the two
   must never be merged, and the evidence column exists because the title is INFERRED, not
   transcribed.
3. `20260815210000_candidate_status_vocabulary` — `status_note`, `status_changed_at`,
   `status_changed_by_hr_id`, index `ats_candidates_created_at_idx`, and the new table
   `public.ats_candidate_status_events`.

**Proof, not ledger** (`list_migrations` was not used): before = 44 columns, `status` default
`'Candidate Created'::text`, events table absent, 0/8 new columns. After = **52 columns, 8/8 new
columns, default `'new'::text`, events table present with RLS on, all 3 indexes, function
SECURITY DEFINER, both triggers**. Candidate rows **227 before and after**, status distribution
identical (226 "Candidate Created" + 1 "Not Eligible — Non-Egyptian (Dubai, UAE)") — no row touched.

**`ats_candidate_status_events` is append-only and it is REAL, not aspirational.** Proven on staging
by attacking it: INSERT succeeds, then UPDATE, DELETE **and TRUNCATE** each fail with
`23001 … is append-only; <OP> is not permitted`, and the row survived unchanged. TRUNCATE needs its
own **statement-level** trigger — see [[append-only-tables-need-a-truncate-trigger]]. A permanent,
clearly-labelled proof row (candidate id `00000000-…-00ff`, actor `TEST`) now lives in staging's copy
forever; it cannot be deleted, which is the point. Production's copy is **0 rows** — deliberately
never test-written.

`candidate_id` carries **no foreign key**, on purpose: a candidate can be hard-deleted, and an audit
row that dies with the record it describes cannot testify about the deletion. Do not "fix" the
missing FK.

**Security is clean and it is the `revoke` that does it.** Production `get_advisors(security)` after
the change mentions neither the new table nor the new function anywhere — no `rls_enabled_no_policy`
(it has the service_role policy) and no `authenticated_security_definer_function_executable`, which
14 *other* functions in this database do trip. That is the explicit
`revoke execute … from public, anon, authenticated` working. `anon`/`authenticated`/`public` hold
**no grants at all** on the table — see [[ad-hoc-backup-tables-are-anon-readable]] for why this gets
checked every time.

**The ordering is migration → deploy → backfill, and it is not interchangeable.** The migration sets
`status` default to `'new'` while production still runs the old code, so any CV arriving in the gap
lands on `new` and the old UI renders it as a raw lowercase `new` pill instead of "Candidate
Created". That is cosmetic and self-resolving on merge. The reverse order is a hard failure — new
code reading columns that do not exist. `candidate-status.ts` maps the legacy `'Candidate Created'`
onto `new` at read time, so new code is correct against old rows; old code against new values is only
ugly.

**The status backfill RAN on 2026-08-16, owner-approved — do NOT re-run and do NOT undo.** Result:
**219 `new` · 7 `shortlisted` · 1 `rejected`**, 227 rows unchanged in count, 0 legacy values left, 0
off-vocabulary values. Before-state snapshot lives in schema
`candidate_status_backup_20260816.ats_candidates_status_before` (227 rows) — a **private schema on
purpose**, since a `zz_backup_…` table in `public` is anon-readable; verified NONE granted to
anon/authenticated/public at both schema and table level.

Three judgement calls in that backfill, each deliberate:

* **7 rows went to `shortlisted`, not `new`.** They already carried an application (stages
  `in_candidate_pool`, `cv_screening`, `hr_interview` — one with a real interview). Flattening them
  to `new` would have told a recruiter nobody had looked at people who had been worked. This was not
  a risk the backfill introduced — `normalizeCandidateStatus` maps `'candidate created'` → `new`, so
  those 7 were ALREADY displaying as New and counting as unreviewed before the backfill. The
  backfill fixed a pre-existing lie. Their `status_note` records the pipeline stage it was derived
  from, so it is auditable and overrulable.
* **`status_changed_at` / `status_changed_by_hr_id` were left NULL on every backfilled row** (verified
  0 non-null). A relabelling is not a decision; stamping `now()` would manufacture a decision that
  never happened, and the column contract is NULL = "never changed" / "not recorded", never "system".
* **`status_note` was set as `status_note = status`, copying the STORED value** rather than a retyped
  literal — the em-dash in `Not Eligible — Non-Egyptian (Dubai, UAE)` cannot survive transcription
  reliably. Verified `preserved_verbatim = true` against the backup.

One `ats_candidate_status_events` row was written, for that single rejection only — it is the only
human-authored decision in the module, and without an event the next status change overwrites
`status_note` and the reason is gone. `from_status` holds the original sentence, `actor_hr_id` is
NULL because the original actor and date were never recorded. **No events were manufactured for the
other 226** — nothing happened to them today, and the events table records decisions, not
relabellings.

The vocabulary lives in `src/lib/recruitment/candidate-status.ts`, **not** as a DB enum or CHECK —
renaming a label is a reviewed PR, not a hand-applied production migration. The DB default must stay
equal to `DEFAULT_CANDIDATE_STATUS` in that file.

Related: [[railway-deploy-applies-no-migrations]] is why these went by hand first ·
[[migration-file-written-is-not-migration-applied]] · [[list-migrations-reports-ledger-not-reality]]
