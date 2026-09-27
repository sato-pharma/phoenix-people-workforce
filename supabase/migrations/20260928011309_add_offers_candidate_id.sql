-- WHAT.  Adds `public.offers.candidate_id` — a nullable FK to `public.ats_candidates(id)`, ON DELETE
--        SET NULL, with a partial index — and backfills it where the offer's own e-mail address
--        identifies exactly one candidate beyond doubt.
--
-- WHY.   An offer has never known which candidate it was written for. `offers` carries only the
--        free-text `candidate_name` and `candidate_email`, so the whole funnel — candidate, offer,
--        hire, organogram seat — could only be reassembled by matching names, and matching names is
--        actively dangerous here. Measured on production 2026-09-28: of 27 offers only 3 could be
--        traced to a candidate at all, eight offer recipients were already active seated employees
--        while seven of their offers still read `sent`, and a name match put an offer for a Medical
--        Representative onto the OWNER'S OWN employee record (B-10) and another onto a District
--        Manager. A text column cannot be made safe; an id can.
--
--        The column is NULLABLE on purpose. An offer may legitimately exist for somebody who never
--        came through the ATS — three of tonight's eight hires have no candidate record at all — and
--        a NOT NULL here would have refused to record them. Null means "not linked", never "no such
--        person".
--
--        ON DELETE SET NULL rather than CASCADE: deleting a candidate must never destroy the record
--        of an offer that was made to them. (A candidate MERGE repoints the offer instead of losing
--        it — `offers` joins `childTables` in candidate-merge-service.ts in the same change.)
--
-- ROLLBACK.
--        alter table public.offers drop constraint if exists offers_candidate_id_fkey;
--        drop index if exists public.offers_candidate_idx;
--        alter table public.offers drop column if exists candidate_id;
--        Reversible in full: this adds a column and writes it for 3 rows, and drops nothing. The
--        backfilled ids are recomputable from the same e-mail rule at any time.

alter table public.offers
  add column if not exists candidate_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'offers_candidate_id_fkey'
  ) then
    alter table public.offers
      add constraint offers_candidate_id_fkey
      foreign key (candidate_id) references public.ats_candidates(id) on delete set null;
  end if;
end $$;

-- Partial: the column is null for most rows and every read of it asks for a real candidate.
create index if not exists offers_candidate_idx
  on public.offers (candidate_id)
  where candidate_id is not null;

comment on column public.offers.candidate_id is
  'The candidate this offer was written for. Null where the offer was not raised from the ATS pool, '
  'which is legitimate. Never resolve an offer to a candidate by NAME — see the migration header.';

-- ── The backfill ─────────────────────────────────────────────────────────────────────────────────
-- E-MAIL ONLY, and only an address that belongs to ONE person. `ats_candidates.email_norm` carries a
-- partial UNIQUE index, so at most one candidate can hold an address — but an address can still be
-- the WRONG kind of evidence: on production one mailbox, achieverrr303@gmail.com, is the recipient on
-- six different people's offers, so it is provably not a personal address. Any address used by offers
-- for more than one distinct candidate_name is therefore excluded outright rather than trusted.
--
-- Names are NOT used at any point, deliberately. The three links this writes were each read back and
-- confirmed by hand before the migration was applied:
--   Aya Gaber -> Aya Gaber · MARINA OSAMA -> Marina Osama · Abdallah Saad -> ABDALLAH SAAD SHARQAWY MOHAMED
with shared_mailboxes as (
  select lower(btrim(candidate_email)) as email_key
  from public.offers
  where candidate_email is not null and btrim(candidate_email) <> ''
  group by 1
  having count(distinct lower(btrim(candidate_name))) > 1
),
resolved as (
  select o.id as offer_id, c.id as candidate_id
  from public.offers o
  join public.ats_candidates c on c.email_norm = lower(btrim(o.candidate_email))
  where o.candidate_email is not null
    and btrim(o.candidate_email) <> ''
    and lower(btrim(o.candidate_email)) not in (select email_key from shared_mailboxes)
)
update public.offers o
   set candidate_id = r.candidate_id
  from resolved r
 where r.offer_id = o.id
   and o.candidate_id is null;
