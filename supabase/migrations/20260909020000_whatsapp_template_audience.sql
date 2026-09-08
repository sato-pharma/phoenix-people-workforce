-- Which screens a message template is offered on, when its BODY cannot say.
--
-- WHY THE DERIVED RULE IS NOT ENOUGH. `requiresEmployeeTarget` keeps a template off the candidate
-- screen when its body uses a field only an employee record can answer — `probation_end_date`,
-- `contract_renewal_date`. That is the right default and it stays: it needs no upkeep, survives a
-- category being renamed, and covers any employee-only field added later.
--
-- It cannot express a template whose fields are all TYPED. A salary increase is exactly that shape:
-- the amount and the effective month are both typed at send time, because nothing in the database
-- records that a raise happened or when. Every placeholder in it is answerable for a candidate, so
-- the derivation offers it on the CV screen — where a recruiter could send a serving employee's pay
-- rise to a job applicant. Nothing would error; the message would simply be wrong and unrecallable.
--
-- SO: an EXPLICIT marker, and the derived rule stays as well. A template is employee-only when it is
-- marked one OR when its body needs an employee-only field. Two independent reasons, either
-- sufficient — a template can never become MORE widely offered by adding this column.
--
-- 'any' IS THE DEFAULT, so every existing row keeps its current behaviour exactly, and a template
-- the owner writes in the editor is offered everywhere unless he says otherwise.
--
-- CHECKED, unlike `category` above, which is deliberately free text so he can invent a group by
-- typing one. This is not a label — it decides who can be sent a message — so an unrecognised value
-- must be refused at write time rather than silently falling through to a default at read time.

begin;

alter table public.ats_whatsapp_message_templates
  add column if not exists audience text not null default 'any';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ats_whatsapp_message_templates'::regclass
      and conname = 'ats_whatsapp_message_templates_audience_check'
  ) then
    alter table public.ats_whatsapp_message_templates
      add constraint ats_whatsapp_message_templates_audience_check
      check (audience in ('any', 'employee'));
  end if;
end $$;

comment on column public.ats_whatsapp_message_templates.audience is
  'Who this template may be sent to: ''any'' (candidates and employees) or ''employee'' (kept off the candidate screen). Complements the derived rule in requiresEmployeeTarget, which keys on employee-only placeholders and cannot see a template whose fields are all typed — a salary increase being the case that forced this. Either signal is sufficient; neither can widen a template''s audience.';

commit;
