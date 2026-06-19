-- Allow Field Coaching Report score items to use the full 0-5 scale.
--
-- Existing data already fits the wider range, so no score rows need rewriting.
-- This only relaxes the check constraint that currently rejects imported zeroes.

begin;

alter table public.coaching_score_items
  drop constraint if exists coaching_score_items_score_check;

alter table public.coaching_score_items
  add constraint coaching_score_items_score_check check (score between 0 and 5);

comment on table public.coaching_score_items is
  'Dynamic score rows for each coaching report. Expected total is 20 items scored from 0 to 5.';

commit;
