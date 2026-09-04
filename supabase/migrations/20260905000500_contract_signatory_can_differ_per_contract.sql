-- Who signs a contract FOR THE COMPANY is not always the same person.
--
-- Until now the contract's first party was answered entirely from `src/config/system-settings.ts`:
-- one name, one capacity, compiled in, identical on every contract Phoenix has ever printed. The
-- owner's rule (2026-09-04): "sometimes another one may sign" — a delegate, an acting manager, a
-- second authorised signatory — and the paper has to be able to say so.
--
-- These two columns are an OVERRIDE, not a replacement. Both are NULL for every existing row and
-- for every new hire, and NULL means "use the standing signatory from system-settings", so nothing
-- about the usual contract changes and no backfill is needed or wanted. A value here is a statement
-- about ONE contract: this instrument was signed for the company by this person, in this capacity.
--
-- It belongs on the hiring profile rather than in settings because it is per-contract. Settings are
-- shared by every employee and every document — typing a delegate's name there to print one
-- contract would silently rewrite the company's representative on everybody else's paper too. That
-- is the exact failure `src/lib/hiring-pack/paper-fields.ts` was written to prevent, and it is why
-- these are columns and not a settings edit.
--
-- The recital (الطرف الأول), the signature grid's الاسم cell and the "يوقّع عن الطرف الأول" note all
-- read the SAME two values, so an override moves all three together. A contract naming one person
-- in its recital and another over the signature line would be a defective instrument.

alter table public.employee_hiring_profile
  add column if not exists contract_signatory_name_ar text,
  add column if not exists contract_signatory_title_ar text;

comment on column public.employee_hiring_profile.contract_signatory_name_ar is
  'Who signed this contract for the company, when it was not the standing signatory. NULL means use systemLegalEntity.contractRecital.signatoryNameAr.';

comment on column public.employee_hiring_profile.contract_signatory_title_ar is
  'The capacity that signatory signed in. NULL means use systemLegalEntity.contractRecital.signatoryTitleAr.';
