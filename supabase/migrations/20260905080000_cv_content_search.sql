-- Recruitment / ATS — search what the CV actually SAYS, not just who sent it.
--
-- ── WHAT WAS AND WAS NOT THERE ──────────────────────────────────────────────────────────────────
--
-- The plan for this called for "full-text search over extracted CV text", on the premise that the
-- text exists and is merely unsearchable. Measured on production 2026-09-05, that premise is wrong:
-- there is NO raw CV text anywhere. `ats_candidate_cv_extractions` holds `extracted_fields` jsonb
-- and nothing else; `ats_files` holds metadata and the document itself lives in Drive.
--
-- What DOES exist is the structured reading — skills, work history, education, university, degree,
-- employer, job title — 514 kB across 581 live candidates, averaging 827 characters each. That is
-- richer than raw text for this purpose: searching "cardiology" across a parsed skills list beats
-- searching it across page furniture, headers and OCR noise.
--
-- ── WHY SERVER-SIDE ─────────────────────────────────────────────────────────────────────────────
--
-- The screening page already ships roughly 683 kB of candidate data. Adding 514 kB to every load —
-- for a search nobody runs on most visits — is a 75% increase, and Phase 7 aims this module at 5,000
-- candidates, where the same text would be about 4.4 MB. So the text stays in the database.
--
-- ── WHY SUBSTRING AND NOT tsvector ──────────────────────────────────────────────────────────────
--
-- A recruiter types "cardio", not "cardiology"; "pharma", not "pharmaceutical". `to_tsquery` matches
-- lexemes, so "cardio" finds nothing while the candidate sits there with "Cardiology" in their
-- skills — a search that silently returns nothing is the worst failure this screen can have, because
-- it reads as "we have nobody like that" rather than as a limitation.
--
-- ILIKE over 581 rows and 514 kB is a sequential scan of half a megabyte, which is free. An index
-- would be premature here; when the pool reaches the thousands, `pg_trgm` (already installed) gives
-- a GIN index over exactly this expression without changing the query's meaning.
--
-- ── EVERY TERM MUST MATCH ───────────────────────────────────────────────────────────────────────
--
-- "pharmacist cairo" means both, not either. An OR would return most of the pool for any two-word
-- query and teach the recruiter that search does not work.

create or replace function public.ats_candidate_cv_search_text(p_fields jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  -- One flattened haystack per candidate. The three list-shaped fields go through the same helpers
  -- the CV lifecycle view uses, so what is searched is exactly what a human is shown elsewhere
  -- rather than a second rendering that can drift from it.
  select concat_ws(' ',
    nullif(p_fields -> 'currentJobTitle' ->> 'value', ''),
    nullif(p_fields -> 'currentEmployer' ->> 'value', ''),
    nullif(p_fields -> 'university'      ->> 'value', ''),
    nullif(p_fields -> 'degree'          ->> 'value', ''),
    -- `faculty` is on 416 of 581 and is what people actually search here — "Faculty of Pharmacy",
    -- "Faculty of Science". The first draft of this list had `fieldOfStudy` and `summary`, neither of
    -- which exists in a single extraction on production, and omitted this one.
    nullif(p_fields -> 'faculty'         ->> 'value', ''),
    -- Skills are stored as [{"name": "..."}]; the raw JSON would make every candidate match the
    -- word "name", so the names are pulled out rather than the blob being cast to text.
    (select string_agg(s ->> 'name', ' ')
       from jsonb_array_elements(
              case when jsonb_typeof(p_fields -> 'skills' -> 'value') = 'array'
                   then p_fields -> 'skills' -> 'value' else '[]'::jsonb end) s),
    public.ats_cv_work_text(p_fields -> 'workHistory' -> 'value'),
    public.ats_cv_education_text(p_fields -> 'educationHistory' -> 'value')
  );
$$;

comment on function public.ats_candidate_cv_search_text(jsonb) is
  'Flattens one CV extraction into a single searchable string: job title, employer, university, degree, faculty, skill NAMES (not the raw [{"name":...}] JSON, which would make every candidate match the word "name"), plus work and education rendered through the same helpers the CV lifecycle view uses. Added 2026-09-05 — there is no raw CV text in this database, so the structured reading IS the searchable content.';

-- ── THE SEARCH ──────────────────────────────────────────────────────────────────────────────────

create or replace function public.ats_search_candidate_cvs(p_query text, p_limit integer default 200)
returns table (candidate_id uuid, matched_on text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_terms text[];
begin
  -- Terms of one character match almost everything and are never what somebody meant; dropping them
  -- is kinder than returning the whole pool. An empty query returns NOTHING rather than everything —
  -- "search for nothing" must not read as "here is everyone".
  select array_agg(t) into v_terms
    from unnest(regexp_split_to_array(coalesce(btrim(p_query), ''), '\s+')) t
   where length(t) > 1;

  if v_terms is null or cardinality(v_terms) = 0 then
    return;
  end if;

  return query
  with latest as (
    -- The NEWEST reading per candidate. A re-extraction writes another row rather than replacing
    -- one, so without this a candidate could match on a superseded reading of an older CV.
    select distinct on (f.candidate_id) f.candidate_id, f.extracted_fields
      from public.ats_candidate_cv_extractions f
     order by f.candidate_id, f.created_at desc
  ),
  haystack as (
    select l.candidate_id, public.ats_candidate_cv_search_text(l.extracted_fields) as body
      from latest l
  )
  select h.candidate_id,
         -- What was hit, so the screen can say WHY a candidate is in the results rather than
         -- presenting an unexplained list.
         left(regexp_replace(h.body, '\s+', ' ', 'g'), 160) as matched_on
    from haystack h
   where h.body is not null
     and h.body <> ''
     and (select bool_and(h.body ilike '%' || t || '%') from unnest(v_terms) t)
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

comment on function public.ats_search_candidate_cvs(text, integer) is
  'Candidates whose newest CV reading contains EVERY term in the query (substring, case-insensitive). AND not OR, because "pharmacist cairo" means both. Substring and not tsvector, because a recruiter types "cardio" and a lexeme match would silently return nothing. Returns the candidate id and a snippet of what was searched. Reads only; applies no permission of its own — the caller is the service, which asserts candidates:read first.';

-- ── WHO MAY CALL THEM ───────────────────────────────────────────────────────────────────────────
--
-- A function created in `public` inherits PostgreSQL's default EXECUTE grant to PUBLIC, and both
-- `anon` and `authenticated` are members of PUBLIC — so without these lines each is reachable over
-- PostgREST with the anonymous key. These read CV contents for the whole pool, so that would be a
-- disclosure, not merely an untidy grant. Revoking only anon and authenticated is a NO-OP: they
-- inherit through PUBLIC membership, so PUBLIC itself has to be named. Revoking PUBLIC from a
-- default ACL strips service_role with it, which is why it is granted back explicitly.

revoke execute on function public.ats_candidate_cv_search_text(jsonb) from public, anon, authenticated;
grant execute on function public.ats_candidate_cv_search_text(jsonb) to service_role;

revoke execute on function public.ats_search_candidate_cvs(text, integer) from public, anon, authenticated;
grant execute on function public.ats_search_candidate_cvs(text, integer) to service_role;
