-- Bind a letter design to a job title.
--
-- WHY. From the module's founding instruction, the templates were to be "editable inside Phoenix,
-- savable PER ROLE". Everything else that varies by role already lives on `offer_job_titles` — the
-- cost of living, the reporting line, the contract term — and choosing the title on the offer form
-- fills all three. The DESIGN the letter is drawn in was the one thing that did not follow, so a
-- District Sales Manager offer and a National Sales Manager offer both opened on whichever row
-- happened to carry `is_default`, and whoever was writing it had to remember to switch.
--
-- WHAT NULL MEANS. "No preference — use whichever template is flagged `is_default`." That is a real
-- answer, not a missing one: most titles will never want their own design, and a null keeps
-- following the default if the default later moves. Storing the default's id here instead would
-- freeze a decision nobody made.
--
-- ON DELETE SET NULL, deliberately, and not either alternative:
--   cascade  would delete a JOB TITLE because somebody tidied up a template. That row carries the
--            cost of living that splits a signed offer's package into basic and transport; losing
--            it silently, as a side effect of a design change, is the worst outcome available here.
--   restrict would refuse the template deletion with a foreign-key error the designer has no way to
--            explain, on a screen whose whole promise is that nothing done there can cost anything.
-- Set-null unbinds the title and the offer falls back to the default — exactly what it did before
-- anyone bound it, which is the one behaviour that is certainly safe.

begin;

alter table public.offer_job_titles
  add column if not exists template_id uuid
  references public.offer_templates (id) on delete set null;

-- Partial: the overwhelming majority of titles will hold null, and this index exists to answer
-- "which titles point at the template about to be deleted", never to scan the nulls.
create index if not exists offer_job_titles_template_id_idx
  on public.offer_job_titles (template_id)
  where template_id is not null;

comment on column public.offer_job_titles.template_id is
  'The letter design new offers for this title open on. Null means use whichever template holds is_default. Cleared automatically if that template is deleted, which falls back to the same default.';

commit;
