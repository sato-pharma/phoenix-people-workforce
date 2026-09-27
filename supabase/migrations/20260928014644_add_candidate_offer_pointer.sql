-- WHAT.  Adds `public.ats_candidates.offer_id` — a nullable FK to `public.offers(id)`, ON DELETE SET
--        NULL, with a partial index. No backfill: nothing on file can say which of the 27 standalone
--        offers belongs to whom without guessing, and guessing is the defect this replaces.
--
-- WHY.   THE DECISION, 2026-09-28. A standalone offer points at its candidate through a pointer the
--        RECRUITMENT side holds, named `offer_id`, exactly as `ats_applications.offer_id` already
--        does — moved from the application to the CANDIDATE, because an offer belongs to a PERSON and
--        not to an application.
--
--        The two constraints this satisfies, both of which the previous attempt broke:
--
--        1. THE OFFERS MODULE LEARNS NOTHING. `src/lib/offers/types.ts` carries the owner's
--           instruction that offers and recruitment are independent — an offer may be issued to
--           somebody who never entered the ATS, and "the two must not be merged". A `candidate_id`
--           column on `offers` breaks that and was reverted on 2026-09-28. This FK runs the other
--           way: recruitment -> offers, the one permitted direction, the same direction
--           `candidate-context.ts` already reads in through the offers module's own `getOffer`.
--
--        2. AN OFFER NEEDS NO APPLICATION. `ats_applications.offer_id` has existed since the table
--           was created and reads 0 of 15 rows on production, because it can only be written when an
--           application exists — and there are 27 offers against 15 applications. Keying the pointer
--           on the application is precisely why it was never written.
--
--        ONE POINTER PER CANDIDATE IS TRUTHFUL, not lossy. Measured on production 2026-09-28: all
--        four people holding more than one offer (Alaa Mohsen 3, Osama Mohamed Ali 3, Marina Osama 2,
--        Mohamed Abdelazim Abudeif 2) have exactly ONE distinct title-and-territory between them.
--        Every multiple is a RE-SEND of the same offer, not a history of different ones, so a single
--        column loses nothing real. A join table would model a history that does not exist.
--
--        ON DELETE SET NULL: deleting an offer letter must never delete the candidate. And because
--        the pointer sits ON the candidate row, a candidate MERGE carries it through
--        `mergeableFields` — the survivor inherits the offer only when it has none of its own, which
--        is the merge's standing never-overwrite rule.
--
-- NOT DONE HERE, deliberately: no backfill. Resolving the existing 27 offers to candidates needs a
--        person to say who they belong to. The e-mail is not enough either — one address,
--        achieverrr303@gmail.com, is the recipient on six different people's offers.
--
-- ROLLBACK.
--        alter table public.ats_candidates drop constraint if exists ats_candidates_offer_id_fkey;
--        drop index if exists public.ats_candidates_offer_idx;
--        alter table public.ats_candidates drop column if exists offer_id;
--        Reversible in full: adds one nullable column and writes no rows.

alter table public.ats_candidates
  add column if not exists offer_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ats_candidates_offer_id_fkey'
  ) then
    alter table public.ats_candidates
      add constraint ats_candidates_offer_id_fkey
      foreign key (offer_id) references public.offers(id) on delete set null;
  end if;
end $$;

-- Partial: null for almost every candidate, and every read of it asks for a real offer.
create index if not exists ats_candidates_offer_idx
  on public.ats_candidates (offer_id)
  where offer_id is not null;

comment on column public.ats_candidates.offer_id is
  'The job offer currently in play for this candidate. Recruitment holds the pointer and the offers '
  'module learns nothing — offers and recruitment are deliberately independent. Null is normal. '
  'Never resolve an offer to a candidate by NAME: see the migration header.';
