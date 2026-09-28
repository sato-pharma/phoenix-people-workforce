-- add_offer_copy_recipients
--
-- WHAT THIS CHANGES:
--   Adds `public.offers.cc_recipients` and `public.offers.bcc_recipients`, both
--   `text[] not null default '{}'`. Written once, at send time, by `markOfferSent`
--   (src/lib/offers/service.ts) in the same UPDATE that stamps `sent_at`.
--
-- WHY:
--   Owner, 2026-09-28: "show who was copied on each offer in the offers list". CC and BCC on an
--   offer shipped the same day (PR 4663) with the copies recorded only in the send's audit row, so
--   the Offers list could not say who else received a salary. The owner ruled that an offer may be
--   copied to ANY address with no reason given, which makes this list the practical record of who
--   read it.
--
--   `not null default '{}'`, not nullable: every offer on file today was sent to the candidate
--   alone, so an empty list is the TRUTH for them, not a guess — and one shape means no reader has
--   to tell "nobody copied" from "not recorded". A constant default is catalog-only on Postgres 11+,
--   so the existing rows are not rewritten.
--
--   No grants and no RLS change: the offers module reads and writes through the service-role
--   client only, like every other column on this table.
--
-- ROLLBACK:
--   alter table public.offers drop column if exists cc_recipients;
--   alter table public.offers drop column if exists bcc_recipients;
--   Loses only the copy lists recorded after this migration; the same addresses stay in each
--   send's audit row (entity_type = 'job_offer', new_values.cc / new_values.bcc).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: two additive columns, no row written.

begin;

alter table public.offers
  add column if not exists cc_recipients text[] not null default '{}'::text[];

alter table public.offers
  add column if not exists bcc_recipients text[] not null default '{}'::text[];

comment on column public.offers.cc_recipients is
  'Addresses openly copied (CC) when the offer was sent. Empty for an offer sent to the candidate alone.';

comment on column public.offers.bcc_recipients is
  'Addresses secretly copied (BCC) when the offer was sent. Empty for an offer sent to the candidate alone.';

commit;
