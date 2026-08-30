-- Record WHICH VERSION of the employment contract a person actually signed.
--
-- WHY THIS EXISTS. Until 2026-08-30 there was one employment contract, so "reprint this employee's
-- contract" had one possible meaning. On that day the owner supplied a redrafted contract and asked
-- that the old one be archived rather than deleted: "make the other contract go to archived instead
-- of removing it from system … and any paper I replace, it goes to the archive."
--
-- The moment a second version exists, a reprint becomes ambiguous — and the dangerous half of the
-- ambiguity is silent. Reprinting somebody's contract with TODAY's text produces a document that
-- looks completely correct, carries their name and their salary, and is not the instrument they
-- signed: different clause wording, a different company recital, a different signatory title. There
-- is no error, no warning, and nothing on the page that says so. This column is what makes the
-- difference visible to the system, so `resolveContractTemplate` can reproduce the signed text.
--
-- WHAT THE VALUE IS. A template id from `src/lib/hiring-pack/template-registry.ts` — 'contract-v1'
-- or 'contract-v2' today. Deliberately a plain text id and NOT a foreign key: the versions are
-- source code, not rows, because the thing being versioned is a legal text that lives in the
-- repository under review, and a database table of contract texts would be editable by anyone with
-- a SQL prompt and invisible to code review.
--
-- WHY NULL IS ALLOWED AND NOT BACKFILLED. Null means "no version was recorded", which is the honest
-- state for two populations: everybody who has not signed yet, and everybody who signed before this
-- column existed. Both print the current version, which is right for the first group and harmless
-- for the second — the only text in use before today is the one now archived, and its content is
-- unchanged in the repository. Writing 'contract-v1' into every existing row would look like a
-- record and be a guess: nothing in the database says those contracts were printed at all, let
-- alone signed against a specific text. A guess that is indistinguishable from an observation is
-- worse than a null.
--
-- WHO WRITES IT. `markHiringPackSigned`, once, when a contract signature is FIRST recorded — never
-- at print time (printing is not signing, and a draft is printed many times) and never again
-- afterwards (a later correction to the signature DATE must not move the version, or fixing a typo
-- would silently re-file the contract against whatever text is current on the day of the fix).

alter table public.employee_hiring_profile
  add column if not exists contract_template_version text;

comment on column public.employee_hiring_profile.contract_template_version is
  'Which version of the employment contract this person signed - a template id from src/lib/hiring-pack/template-registry.ts (contract-v1, contract-v2). Stamped once, when the signature is first recorded. NULL means no version was recorded: either unsigned, or signed before 2026-08-30 when this column was added. Never backfilled - a guess here is indistinguishable from an observation.';
