-- Recruitment / ATS: a CV can be starred 1, 2 or 3.
--
-- The owner, 2026-09-12: "i want be able to favorite a cv more", and then, asked which of four
-- readings he meant, he chose stars 1/2/3 -- rank the CVs you like AGAINST EACH OTHER, so the best
-- rise to the top of the shortlist instead of all sitting in one flat pile.
--
-- WHY THIS IS NOT A STATUS. `ats_candidates.status` is the decision -- new, shortlisted,
-- sent_to_manager, rejected, hired -- and it is a single slot that moves forward. A star is not a
-- decision and does not move anything: it is how strongly the person who read the CV liked it, and
-- it has to survive the decision rather than be replaced by it. A three-star CV that is then sent
-- to a manager is still a three-star CV. So this is its own trio of columns beside the status trio,
-- not a sixth status and not a note.
--
-- THE SHAPE IS COPIED FROM THE STATUS TRIO ON PURPOSE. status / status_changed_by_hr_id /
-- status_changed_at already record "what, who, when" on this table, every reader knows that shape,
-- and the screening surfaces already project those three columns. rating / rated_by_hr_id /
-- rated_at is the same three facts about a different question.
--
-- WHOSE STAR IS IT. The CANDIDATE's, stamped with who set it -- not a private per-viewer bookmark.
-- That is the same call `status_changed_by_hr_id` makes and it is the right one here: screening is
-- a shared queue, the point of a star is that the next person to open the pile sees which CVs the
-- last reader rated highest, and a per-viewer table would make the top of the shortlist depend on
-- who is looking. A later star overwrites an earlier one and the stamp says who last touched it.
--
-- WHY A CHECK CONSTRAINT HERE, when candidate-status.ts deliberately refuses one for the status
-- vocabulary. That refusal is right for LABELS: renaming "shortlisted" or adding a sixth state
-- should be a code change, because the set is a vocabulary and the strings carry their own meaning.
-- A rating is not a vocabulary, it is a POSITION ON A LADDER, and the meaning of "2" depends
-- entirely on where the top of that ladder is. Widening 1-3 to 1-5 would silently restate every
-- star already given -- a two out of three is not a two out of five -- so widening it SHOULD cost a
-- migration and a deliberate decision about what happens to the existing rows. The constraint is
-- what makes that impossible to do by accident.
--
-- NULL IS UNRATED AND IS NOT ZERO. Nobody has starred this CV. Every candidate on file is unrated
-- the moment this applies, which is correct -- there is no rating to backfill and inventing one
-- would be inventing an opinion. Clearing a star writes NULL back, never 0, so "unrated" has
-- exactly one representation and a filter can ask for it.
--
-- ADDITIVE AND REVERSIBLE. Three nullable columns and one partial index. No existing column is
-- touched, no row is rewritten, nothing reads these until the code that writes them ships. Rolling
-- it back is three DROP COLUMNs.

alter table public.ats_candidates
  add column if not exists rating smallint,
  add column if not exists rated_by_hr_id text,
  add column if not exists rated_at timestamptz;

-- 1, 2, 3 or nothing. See the note above on why this ladder is pinned rather than left open.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ats_candidates'::regclass
      and conname = 'ats_candidates_rating_range'
  ) then
    alter table public.ats_candidates
      add constraint ats_candidates_rating_range check (rating is null or rating between 1 and 3);
  end if;
end $$;

comment on column public.ats_candidates.rating is
  'How strongly the reader rated this CV: 1, 2 or 3 stars. NULL is unrated, never 0. Not a status -- it survives the decision. See 20260912113000_ats_candidate_rating.sql.';
comment on column public.ats_candidates.rated_by_hr_id is
  'Who last set the star. Mirrors status_changed_by_hr_id; no FK, for the same reason that column has none.';
comment on column public.ats_candidates.rated_at is
  'When the star was last set, Cairo-agnostic timestamptz like every other stamp on this table.';

-- PARTIAL, because the question the screening queue asks is "which of these are starred", and the
-- overwhelming majority of rows will never be. Indexing the NULLs would be indexing the whole table
-- to answer a question about a handful of it.
create index if not exists ats_candidates_rating_idx
  on public.ats_candidates (rating desc, rated_at desc)
  where rating is not null;
