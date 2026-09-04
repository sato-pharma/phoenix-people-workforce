-- Which checklist slot each built-in paper files into — pinned, not guessed from the slot's name.
--
-- WHY NOT MATCH ON THE NAME. The seven signable papers already have a slot each, and the names line
-- up today: "Signed employment contract", "Signed social insurance Form 6", and so on. Resolving by
-- name would work this afternoon and is still the wrong mechanism, twice over:
--
--   • `hiring_document_definitions.name` is ADMIN-EDITABLE free text. Renaming a slot is an
--     ordinary, reasonable act — and it would silently stop the contract filing, with no error
--     anywhere, discovered eventually by somebody wondering why the last four months of contracts
--     are missing.
--   • The ids differ between staging and production, so hard-coding ids instead is not an option:
--     the same build would file into a different slot on each project, which is worse than not
--     filing at all.
--
-- So the LINK IS A COLUMN, seeded here by name — the one moment when matching on the name is safe,
-- because this migration is the moment the names are known to be the ones written above. After
-- this, the name is a label and the column is the mechanism.
--
-- UNIQUE, PARTIAL. One paper files into one slot. Two slots claiming `contract` is not a preference
-- to resolve at read time — it is a question with no right answer, so it is refused at write time.
-- The index is partial so the NULL that every other slot carries does not collide.
--
-- ADDITIVE AND REVERSIBLE. One nullable column, one index, and an UPDATE that touches at most the
-- seven rows named below and only where the column is still NULL. A slot that has been renamed
-- before this runs simply does not match and stays NULL — which the code reports as "this paper has
-- nowhere to file" rather than filing it somewhere wrong.

begin;

alter table public.hiring_document_definitions
  add column if not exists hiring_pack_document text;

comment on column public.hiring_document_definitions.hiring_pack_document is
  'Which built-in hiring-pack paper is filed into this slot when its signature is confirmed: one of contract, form1, form6, resignation, mutualTermination, clearanceEmployee, clearanceCompany. NULL means no paper files here automatically. Deliberately a column rather than a match on `name`, which is admin-editable free text — renaming a slot must not silently stop the filing. Company templates point the other way, via hiring_pack_custom_templates.files_under_document_id, because there are unboundedly many of them.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.hiring_document_definitions'::regclass
      and conname = 'hiring_document_definitions_hiring_pack_document_known'
  ) then
    alter table public.hiring_document_definitions
      add constraint hiring_document_definitions_hiring_pack_document_known
      check (
        hiring_pack_document is null
        or hiring_pack_document in (
          'contract', 'form1', 'form6', 'resignation',
          'mutualTermination', 'clearanceEmployee', 'clearanceCompany'
        )
      );
  end if;
end
$$;

create unique index if not exists hiring_document_definitions_one_slot_per_paper
  on public.hiring_document_definitions (hiring_pack_document)
  where hiring_pack_document is not null;

-- The seeding. `where hiring_pack_document is null` makes it re-runnable and makes it refuse to
-- overwrite a link somebody has since set by hand; the name match is exact against the names these
-- slots carry as this is written.
update public.hiring_document_definitions
   set hiring_pack_document = case name
         when 'Signed employment contract'            then 'contract'
         when 'Social insurance form'                 then 'form1'
         when 'Signed social insurance Form 6'        then 'form6'
         when 'Signed resignation request'            then 'resignation'
         when 'Signed mutual termination agreement'   then 'mutualTermination'
         when 'Signed employee clearance'             then 'clearanceEmployee'
         when 'Signed company clearance'              then 'clearanceCompany'
       end
 where hiring_pack_document is null
   and name in (
     'Signed employment contract', 'Social insurance form', 'Signed social insurance Form 6',
     'Signed resignation request', 'Signed mutual termination agreement',
     'Signed employee clearance', 'Signed company clearance'
   );

commit;

notify pgrst, 'reload schema';
