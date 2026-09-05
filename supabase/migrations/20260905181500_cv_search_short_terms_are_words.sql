-- A short search term means the WORD, not a prefix of it. Owner's decision, 2026-09-05.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
--
-- `rep` matched 401 of 745 candidates — over half the pool — because the previous ILIKE matched a
-- SUBSTRING and `%rep%` also hits "prepare", "reporting" and "repeat". Making the last term a
-- prefix (20260905174500) kept that noise at 382: `rep:*` still reaches "representative" and
-- "reporting". A recruiter searching for medical reps got the pool back either way.
--
-- Now `rep` is the lexeme `rep`, and returns 48 — people whose CV actually says "Medical Rep".
--
-- ── WHY A LENGTH RULE AND NOT SIMPLY DROPPING THE PREFIX ────────────────────────────────────────
--
-- Dropping it entirely would have taken the noise AND the reason the prefix was added. Measured on
-- production, same corpus:
--
--   term          before   no prefix at all   prefix only when the lexeme is 4+
--   rep              401            48                    48
--   gyn               12             4                     4
--   cardio             7             1                     7
--   pharma           326           155                   322
--   cairo            106           106                   106
--   pharmacist        62            62                    62
--
-- Without the length rule, "cardio" stops finding "Cardiology" — which is the exact objection the
-- original ILIKE implementation was built around, recorded in tests/recruitment-cv-search.test.ts.
-- Four characters is where a prefix stops being a wildcard: `rep:*` reaches most of the pool,
-- `card:*` reaches cardiology and cardiac and little else.
--
-- The threshold is measured on the LEXEME, after stemming, because that is what goes into the
-- query: "sales" stems to `sale` (4) and still prefixes; "reps" stems to `rep` (3) and does not,
-- so both spellings of the same word behave the same way.
--
-- The trade is deliberate and visible: a three-letter search is now exact. "gyn" returns 4 rather
-- than 12. Somebody wanting gynaecology types more of it.

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
    -- regexp_match returns NULL when the query has no trailing quoted lexeme; length(NULL) is NULL,
    -- the comparison is NULL, and the CASE falls through to the exact query. Never an error.
    select case
             when base::text = '' then base
             when length((regexp_match(base::text, '''([^'']+)''\s*$'))[1]) >= 4
               then (base::text || ':*')::tsquery
             else base
           end as tsq
    from parsed
  ),
  matched as (
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
         ts_headline(
           'english',
           public.ats_candidate_cv_search_text(m.extracted_fields),
           q.tsq,
           'StartSel="", StopSel="", MaxWords=26, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" · "'
         ) as matched_on
  from matched m
  join newest n on n.candidate_id = m.candidate_id and n.created_at = m.created_at,
       q
  order by ts_rank(m.search_tsv, q.tsq) desc, m.candidate_id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$function$;

revoke execute on function public.ats_search_candidate_cvs(text, integer) from public, anon, authenticated;
grant execute on function public.ats_search_candidate_cvs(text, integer) to service_role;
