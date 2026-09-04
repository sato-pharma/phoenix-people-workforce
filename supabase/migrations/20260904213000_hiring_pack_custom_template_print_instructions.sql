-- How many copies an uploaded template needs, and whether it prints back-to-back.
--
-- The owner, 2026-09-04: "I can upload any template I work on and note it and tell him that it is
-- for example how many copies and it is only or face back."
--
-- HE COULD ALREADY WRITE THAT DOWN, and that was the problem. The upload screen has carried a free
-- text `note` since the table was created, so "two copies, double sided" could be typed into it —
-- and then nothing read it. The template still printed one copy, because `CUSTOM_DOCUMENT_DEFAULT_
-- COPIES` is a constant in the code, and the sheet count on screen still counted sides rather than
-- pieces of paper. A note that describes behaviour the system does not have is worse than no note:
-- it reads as a setting, and the person who trusts it prints the wrong thing.
--
-- The ten built-in papers have both facts compiled in — the custody receipt is two copies, Form 1 is
-- single-sided, and the cards say so — so this is the same knowledge, moved to where an uploaded
-- template can carry it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ONE OF THESE IS ENFORCED AND THE OTHER IS DISPLAYED, and the difference is worth stating because
-- it is not obvious from the column names.
--
--   default_copies  IS ENFORCED. The print route already repeats a document N times in one HTML
--                   document; this decides N when nobody has typed a different number into the
--                   Copies box. Nothing about it is advisory.
--
--   print_sides     IS AN INSTRUCTION TO A PERSON. There is no web API that makes a printer print
--                   duplex — the browser's own print dialog owns that setting, and neither CSS nor
--                   `window.print()` can reach it. So this is shown beside the Print button and on
--                   the template's row, in the same words the built-in cards use, and it is never
--                   claimed to have configured anything.
--
-- ON THE VERSION ROW, like every other fact here. Replacing a template's artwork creates a new
-- version, and a form that became double-sided in its second edition should reprint as the paper
-- that was signed when an archived version is asked for.
--
-- DEFAULTS ARE THE PRESENT BEHAVIOUR, not a guess: every template uploaded before today printed one
-- copy, and nobody has ever told this system a template was double-sided. So a row that predates
-- this migration keeps printing exactly as it printed yesterday.

begin;

alter table public.hiring_pack_custom_templates
  add column if not exists default_copies smallint not null default 1;

alter table public.hiring_pack_custom_templates
  add column if not exists print_sides text not null default 'single';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.hiring_pack_custom_templates'::regclass
      and conname = 'hiring_pack_custom_templates_default_copies_range'
  ) then
    -- TEN, NOT UNBOUNDED. The largest built-in is two copies. A form genuinely needing more than ten
    -- is a mailing rather than a hiring paper, and an unbounded number here is one fat-fingered zero
    -- away from a browser rendering four hundred copies of a scanned A4 page and hanging the tab.
    alter table public.hiring_pack_custom_templates
      add constraint hiring_pack_custom_templates_default_copies_range
      check (default_copies between 1 and 10);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.hiring_pack_custom_templates'::regclass
      and conname = 'hiring_pack_custom_templates_print_sides_known'
  ) then
    alter table public.hiring_pack_custom_templates
      add constraint hiring_pack_custom_templates_print_sides_known
      check (print_sides in ('single', 'double'));
  end if;
end
$$;

comment on column public.hiring_pack_custom_templates.default_copies is
  'How many copies this template prints when nobody types a different number. Enforced by the print '
  'route. 1 to 10; the largest built-in paper is 2.';

comment on column public.hiring_pack_custom_templates.print_sides is
  'single = one side per sheet, double = printed back-to-back. DISPLAYED, never enforced: no web API '
  'can set a printer duplex, so this is the instruction shown beside the Print button.';

commit;
