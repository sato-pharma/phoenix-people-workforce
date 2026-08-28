-- Canonicalize ats_candidates.phone_norm for Egyptian mobiles.
--
-- WHY. phone_norm is the dedup key, and findMatchingCandidate compares it by exact string
-- equality. A CV carrying "01234567890" therefore never matched the WhatsApp record stamped
-- "201234567890" from Meta's wa_id — the same handset, two keys, so the same person was
-- inserted twice. Meta cannot be asked to send the local form, so the international form is
-- canonical and everything else folds onto it.
--
-- This migration is the backfill half. The other half is normalizePhone() in
-- src/lib/recruitment/candidate-matching.ts, which must ship WITH it: updateCandidatePayload
-- recomputes phone_norm from phone on every edit that touches the phone, so a database-only
-- rewrite would silently revert to the local form one row at a time, invisibly.
--
-- Scope, measured on production 2026-08-28 (389 non-null phone_norm rows):
--     253  01xxxxxxxxx        local
--       7  00201xxxxxxxxx     international dialling prefix
--       5  2001xxxxxxxxx      +20 written in front of the local 0, country code doubled
--     265  total rewritten;  61 already canonical;  63 other shapes left untouched
--   two-to-one collisions: 0     landing on an existing row: 0
--
-- phone itself is NOT touched. It stays in whatever form the person wrote it, because that is
-- what a human reads on the candidate card; phone_norm is the machine key.
--
-- The 13 non-mobile 11-digit numbers (e.g. 03034443506) are deliberately excluded — they are
-- not Egyptian mobiles, WhatsApp never delivers one, and folding them would entrench a typo.

do $$
declare
  v_changed   integer := 0;
  v_skipped   integer := 0;
  v_remaining integer := 0;
begin
  -- Collision-safe by construction. recruitment_candidates_phone_norm_uidx is UNIQUE on
  -- phone_norm WHERE phone_norm IS NOT NULL, so a single colliding row would abort the whole
  -- statement. Production shows 0 collisions today, but rows keep arriving between now and
  -- apply, so the guard is real rather than ceremonial: a row whose canonical form is already
  -- held by someone else is left alone and reported, not merged. Two records for one person is
  -- a duplicate a human can merge; merging two different people is not recoverable.
  with candidate_rewrite as (
    select
      c.id,
      '20' || substring(c.phone_norm from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$') as canonical
    from ats_candidates c
    where c.phone_norm is not null
      and c.phone_norm ~ '^(?:00)?(?:(?:20)?0|20)1[0-9]{9}$'
  ),
  eligible as (
    select r.id, r.canonical
    from candidate_rewrite r
    where r.canonical is not null
      and r.canonical <> (select phone_norm from ats_candidates where id = r.id)
      -- not already taken by a different candidate
      and not exists (
        select 1 from ats_candidates other
        where other.phone_norm = r.canonical and other.id <> r.id
      )
      -- and no second row in this same batch wants it either
      and (select count(*) from candidate_rewrite d where d.canonical = r.canonical) = 1
  ),
  updated as (
    update ats_candidates c
       set phone_norm = e.canonical
      from eligible e
     where c.id = e.id
    returning c.id
  )
  select count(*) into v_changed from updated;

  -- Anything the rule matches, that still is not canonical, was skipped by a guard above.
  select count(*) into v_skipped
  from ats_candidates c
  where c.phone_norm is not null
    and c.phone_norm ~ '^(?:00)?(?:(?:20)?0|20)1[0-9]{9}$'
    and c.phone_norm <> '20' || substring(c.phone_norm from '^(?:00)?(?:(?:20)?0|20)(1[0-9]{9})$');

  select count(*) into v_remaining
  from ats_candidates
  where phone_norm is not null and phone_norm ~ '^01[0-9]{9}$';

  raise notice 'phone_norm canonicalized: % rewritten, % skipped on collision, % local-form rows left',
    v_changed, v_skipped, v_remaining;

  if v_skipped > 0 then
    raise warning 'phone_norm: % row(s) were left in non-canonical form because the canonical value is already held by another candidate. Review and merge those by hand.', v_skipped;
  end if;
end $$;
