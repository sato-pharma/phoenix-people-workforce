-- Hiring pack — WHY A POST IS ON A FIXED TERM, stored so the renewal annex can print it.
--
-- WHY. Article 87 of Labour Law 14/2025 permits a fixed-term contract only «إذا اقتضت طبيعة العمل
-- ذلك» — where the nature of the work requires it. The renewal annex shipped on 2026-09-05 states
-- that ground in its preamble, and until now it printed as a dotted rule for somebody to complete by
-- hand. The owner asked the same day for a dropdown of standard reasons instead.
--
-- ── WHY A CODE AND NOT THE SENTENCE ─────────────────────────────────────────────────────────────
--
-- The column holds a CODE from `src/lib/hiring-pack/renewal-reasons.ts`, and the Arabic clause is
-- resolved at print time. Storing the sentence would freeze eight paragraphs of legal Arabic into a
-- table that no one reviews, and correcting a typo would then mean an UPDATE across every employee.
--
-- The cost of that choice is real and is written down where it matters: rewording a clause silently
-- changes what an already-signed annex reproduces when reprinted. `renewal-reasons.ts` is therefore
-- APPEND-ONLY, and `tests/hr-forms-renewal.test.ts` pins every clause verbatim so a reword goes red
-- rather than rewriting history.
--
-- ── WHY PER EMPLOYEE AND NOT PER RENEWAL ────────────────────────────────────────────────────────
--
-- `contract_renewal_requests` would be the obvious home — one row per renewal — and it is the wrong
-- one. Article 87 asks why the nature of THIS WORK requires a term. That is a fact about the post,
-- not about this year's decision, so it belongs beside the other contract terms on the employee's
-- hiring profile: it is answered once and reused by every annex that person ever signs. Putting it
-- on the request would invite a different ground each year for the same unchanged job, which is a
-- contradiction the employee's own file would then carry.
--
-- ── NO CHECK CONSTRAINT, DELIBERATELY ───────────────────────────────────────────────────────────
--
-- The valid codes live in TypeScript and the list is expected to grow on the company lawyer's
-- advice. A CHECK here would make adding a ninth reason a migration, and — worse — would make the
-- database the second place the list is written down, free to disagree with the first. Validation is
-- in `service.ts`, on BOTH sides: an unrecognised code is refused on write and read back as "nothing
-- chosen", so the failure mode of a hand-written value is a blank on the paper rather than a raw
-- identifier printed onto an Arabic legal instrument.
--
-- SAFE TO APPLY: one nullable text column on a satellite table. Postgres adds a nullable column with
-- no default without rewriting the table, so there is no lock of consequence and no row is touched.
-- Nothing reads it until somebody chooses a reason; every existing row keeps printing the dotted
-- rule, which is exactly what it printed yesterday.

alter table public.employee_hiring_profile
  add column if not exists contract_objective_reason_code text;

comment on column public.employee_hiring_profile.contract_objective_reason_code is
  'Why this post is on a fixed term, as a code from src/lib/hiring-pack/renewal-reasons.ts (Labour Law 14/2025 art. 87). Resolved to its Arabic clause at print time by the renewal annex. NULL prints a blank rule. No CHECK on purpose: the catalogue lives in code and service.ts validates both directions.';
