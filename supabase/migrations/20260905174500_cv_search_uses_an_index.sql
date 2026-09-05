-- CV search: same corpus, same semantics, now index-backed, stemmed and ranked.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
--
-- It is NOT a new feature. Searching inside CVs already shipped: `ats_search_candidate_cvs`,
-- `src/lib/recruitment/cv-search.ts`, `GET /api/recruitment/candidates/cv-search`, and a wired
-- control in the screening workstation. This changes only HOW that function matches.
--
-- ── WHAT WAS WRONG WITH IT ──────────────────────────────────────────────────────────────────────
--
-- It matched with `body ILIKE '%term%'` over text rebuilt for EVERY candidate on EVERY search, with
-- no index and no ordering. Two consequences, both measured on production 2026-09-05:
--
--   NO STEMMING.  "managing" found 15 candidates, "managed" found 8, and neither found somebody who
--                 wrote "manager". Three spellings of one idea, three different answers.
--   SUBSTRING NOISE.  "rep" matched 395 candidates, because '%rep%' also hits "prepare",
--                 "reporting" and "repeat". A recruiter looking for medical reps got half the pool.
--
-- And with no ORDER BY, the 200-row cap kept an arbitrary 200 rather than the best 200.
--
-- ── WHY THE CORPUS IS UNTOUCHED ─────────────────────────────────────────────────────────────────
--
-- The generated column is built on the EXISTING `ats_candidate_cv_search_text`, which indexes a
-- deliberate list: currentJobTitle, currentEmployer, university, degree, faculty, skills,
-- workHistory, educationHistory. It does NOT include professionalSummary,
-- currentRoleResponsibilities, certifications or address.
--
-- Widening that would be a PRODUCT decision — adding `address` alone moves "cairo" from 71 hits to
-- 289, which is a different search wearing the same name. This change is about speed and matching
-- quality; what is searched stays exactly as it was, so nobody's saved habit silently changes.
--
-- ── WHY THE LAST TERM IS A PREFIX ───────────────────────────────────────────────────────────────
--
-- Word matching alone would have been a regression for a real habit: typing part of a word.
-- Measured on staging, same corpus, same newest-only rule:
--
--   term            ILIKE   word-only   last-term prefix
--   pharmacist        31       31            31
--   representative   147      147           147
--   cairo             71       71            71
--   pharma           204      107          202      <- word-only LOSES this
--   cardio             4        1            4      <- and this
--   managing          10      329          329      <- stemming gains this either way
--
-- So `:*` on the final lexeme, the typeahead convention: complete words behave exactly as before,
-- partial words keep working, and word forms start finding each other. It is appended to the
-- NORMALISED tsquery text rather than to user input, and only when that text is non-empty — an
-- empty query would otherwise become ':*', which does not cast and would 500 the search box.
--
-- `websearch_to_tsquery`, never `to_tsquery`: it accepts what a person types. Quoted phrases become
-- adjacency, `or` becomes OR, a leading `-` becomes NOT, and punctuation typed by accident
-- ("sales & marketing", "!!!", an unclosed quote) parses to an empty query that matches NOTHING
-- rather than raising. `to_tsquery` throws on every one of those.
--
-- ── AND, NOT OR — PRESERVED ─────────────────────────────────────────────────────────────────────
--
-- "pharmacist cairo" still means both: websearch_to_tsquery ANDs bare terms, which is what the
-- previous implementation did by requiring every term. Verified against the figures the service's
-- own comments record: pharmacist alone 31 on staging, pharmacist cairo 4. Both reproduce exactly.

alter table public.ats_candidate_cv_extractions drop column if exists search_tsv;

alter table public.ats_candidate_cv_extractions
  add column search_tsv tsvector
  generated always as (
    to_tsvector('english', public.ats_candidate_cv_search_text(extracted_fields))
  ) stored;

comment on column public.ats_candidate_cv_extractions.search_tsv is
  'Full-text index of ats_candidate_cv_search_text(extracted_fields). GENERATED and STORED, so it '
  'can never drift from the fields the way a trigger-maintained column can, and the search stops '
  'rebuilding every candidate''s text on every query.';

create index if not exists ats_candidate_cv_extractions_search_tsv_idx
  on public.ats_candidate_cv_extractions using gin (search_tsv);

-- The newest-extraction rule and the candidate join are the other half of every search.
create index if not exists ats_candidate_cv_extractions_candidate_id_idx
  on public.ats_candidate_cv_extractions (candidate_id);

create or replace function public.ats_search_candidate_cvs(p_query text, p_limit integer default 200)
returns table (candidate_id uuid, matched_on text)
language sql
stable
set search_path to ''
as $function$
  with parsed as (
    select websearch_to_tsquery('english', coalesce(btrim(p_query), '')) as base
  ),
  q as (
    -- Only when non-empty: ':*' on its own is not a valid tsquery and the cast would raise.
    select case when base::text = '' then base else (base::text || ':*')::tsquery end as tsq
    from parsed
  ),
  matched as (
    -- Index-backed, and FIRST, so the newest-per-candidate pass runs over the matches rather than
    -- the whole table.
    select e.candidate_id, e.extracted_fields, e.search_tsv, e.created_at
    from public.ats_candidate_cv_extractions e, q
    where q.tsq != ''::tsquery
      and e.search_tsv @@ q.tsq
      and e.candidate_id is not null
  ),
  newest as (
    select distinct on (e.candidate_id) e.candidate_id, e.created_at
    from public.ats_candidate_cv_extractions e
    order by e.candidate_id, e.created_at desc
  )
  select m.candidate_id,
         -- WHY this candidate matched, not merely the first 160 characters of their record. The
         -- delimiter is the house separator, never an ellipsis: text is never truncated with one.
         -- StartSel/StopSel are emptied because the caller renders this as plain text, and the
         -- default wraps matches in <b> tags that would show up literally on screen.
         ts_headline(
           'english',
           public.ats_candidate_cv_search_text(m.extracted_fields),
           q.tsq,
           'StartSel="", StopSel="", MaxWords=26, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" · "'
         ) as matched_on
  from matched m
  join newest n on n.candidate_id = m.candidate_id and n.created_at = m.created_at,
       q
  -- Ranked, so the cap keeps the BEST rows. Without an ORDER BY the previous version's cap kept an
  -- arbitrary 200 and the caller's "truncated" flag told the recruiter they were missing an
  -- unknown set rather than the tail.
  order by ts_rank(m.search_tsv, q.tsq) desc, m.candidate_id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$function$;

comment on function public.ats_search_candidate_cvs(text, integer) is
  'Candidates whose NEWEST CV reading matches every term, best first, with the matching text as '
  'matched_on. Index-backed; the last term is a prefix so partial words keep working.';

-- Restated, not assumed. `create or replace` PRESERVES an existing ACL, and it was verified on
-- production that anon and authenticated still cannot execute this after the replace. But a fresh
-- database builds from these files in order, and a function created in `public` inherits the
-- default EXECUTE grant to PUBLIC — so the revoke is repeated here rather than left to the earlier
-- migration, which a future edit could reorder or squash.
revoke execute on function public.ats_search_candidate_cvs(text, integer) from public, anon, authenticated;
grant execute on function public.ats_search_candidate_cvs(text, integer) to service_role;
