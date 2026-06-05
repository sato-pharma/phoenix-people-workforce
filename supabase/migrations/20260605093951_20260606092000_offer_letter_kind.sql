-- Recruitment Offer Pipeline (M5) — offer-letter document kind.
alter table public.recruitment_offer_letters
  add column if not exists kind text not null default 'offer_letter';

alter table public.recruitment_offer_letters
  drop constraint if exists recruitment_offer_letters_version_unique;
alter table public.recruitment_offer_letters
  add constraint recruitment_offer_letters_version_unique unique (offer_id, version, kind);

notify pgrst, 'reload schema';;
