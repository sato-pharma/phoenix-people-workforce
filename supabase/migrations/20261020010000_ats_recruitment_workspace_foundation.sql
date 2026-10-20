-- Recruitment workspace rebuild — the data foundation (owner, 19–20 Oct 2026: "Recruitment workspace
-- you fully destroy and retire … then we will rebuild it from scratch", then "implement the full
-- phased recruitment plan").
--
-- WHY. The new workspace files every candidate into one of eight ROLE TABS, and inside Medical Rep
-- and District Manager into the AU organogram's regions and areas — and the owner ruled on 20 Oct
-- that the filing comes from the applicant's OWN replies only: "we do not look at the cv we folder
-- based on whatsapp replies". The old pool computed a candidate's role and region on every page load
-- from a mix of the WhatsApp answer and the AI's reading of the CV, which is exactly why its counts
-- disagreed with each other (72 vs 86 filed, 38 vs 4 unreviewed on 19 Oct). So the filing is now a
-- STORED fact, written when the applicant answers (or HR places them by hand), and every count and
-- every row is read through ONE filter function below — they cannot disagree because they cannot
-- be computed two ways.
--
-- WHAT IS HERE.
--   * ats_candidate_placements — one row per (candidate, role tab). No row = "Needs placing".
--   * ats_candidates gains: declared_role_family (the raw role the applicant tapped), answer_marks
--     (which answers HR typed, by whom, when), rejection_reason(+note), archived_at/by, and the
--     stored completeness (answers_expected, answers_given, missing_answer_keys).
--   * ats_candidate_call_results — the one-tap call outcomes.
--   * ats_recruitment_settings — key/value switches (the WhatsApp re-ask starts OFF: owner, "stays
--     off until you switch it on").
--   * ats_merge_screening_answer / ats_set_answer_mark — single-key writes, so an applicant's answer
--     and an HR edit can never clobber each other through a whole-map replace.
--   * ats_v_candidate_returns — the three ways a manager hands a CV back, as one row per candidate.
--   * ats_workspace_filter / ats_workspace_page / ats_workspace_counts — the one WHERE clause.
--
-- SAFE IN BOTH DIRECTIONS. Every object is new or an added nullable column; nothing existing is
-- altered or dropped, so the old pool keeps working while the new workspace is built beside it.
--
-- ACCESS. Service-role only, like every ats_ table: visibility here is application-scoped (the
-- Talent Acquisition fence and the allowed tabs are decided by the server from the session and
-- passed in), never RLS-scoped.

-- ---------------------------------------------------------------------------------------------
-- 1. Placements
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_candidate_placements (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     uuid not null references public.ats_candidates(id) on delete cascade,
  -- The eight tabs the owner named on 20 Oct 2026, RM/AM and NSM sharing one.
  role_tab         text not null,
  -- The bot's own role family as tapped (area_regional_manager, national_sales_manager, …), kept so
  -- the shared RM/AM + NSM tab can still say which of the two a person applied for.
  bot_role_family  text,
  -- The recruitment region code (CA GZ AB D1 D2 D3 UE OT). For a Medical Rep with an area it is the
  -- AREA's recruitment region (recruitmentRegionForArea), never the typed region, so the area tab
  -- always sits under the region tab it belongs to.
  region_code      text,
  -- AU canonical area (au.canonical_areas.area_code) and its name as the bot showed it.
  area_code        text,
  area_name        text,
  placed_by        text not null,
  session_id       uuid references public.ats_whatsapp_classification_sessions(id) on delete set null,
  placed_by_hr_id  text,
  placed_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ats_candidate_placements_role_tab_check check (role_tab in (
    'medical_rep', 'district_manager', 'product_manager', 'rm_am_nsm',
    'hr_section_head', 'talent_acquisition', 'office_coordinator', 'other'
  )),
  constraint ats_candidate_placements_placed_by_check check (placed_by in ('whatsapp', 'website', 'hr', 'migration')),
  constraint ats_candidate_placements_one_per_tab unique (candidate_id, role_tab)
);

create index if not exists ats_candidate_placements_tab_place_idx
  on public.ats_candidate_placements (role_tab, region_code, area_code);
create index if not exists ats_candidate_placements_session_idx
  on public.ats_candidate_placements (session_id) where session_id is not null;

alter table public.ats_candidate_placements enable row level security;
drop policy if exists phx_ats_candidate_placements_service_role on public.ats_candidate_placements;
create policy phx_ats_candidate_placements_service_role
  on public.ats_candidate_placements for all to service_role using (true) with check (true);
revoke all on public.ats_candidate_placements from anon, authenticated;
grant select, insert, update, delete on public.ats_candidate_placements to service_role;

comment on table public.ats_candidate_placements is
  'Which role tab (and region/area) a candidate is filed in — from the applicant''s own WhatsApp or careers-form reply, or placed by HR. No row = Needs placing. Never from a CV reading (owner, 2026-10-20).';

-- ---------------------------------------------------------------------------------------------
-- 2. Candidate columns
-- ---------------------------------------------------------------------------------------------

alter table public.ats_candidates
  add column if not exists declared_role_family text,
  add column if not exists answer_marks jsonb not null default '{}'::jsonb,
  add column if not exists rejection_reason text,
  add column if not exists rejection_reason_note text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text,
  add column if not exists answers_expected smallint,
  add column if not exists answers_given smallint,
  add column if not exists missing_answer_keys text[];

-- Nullable on purpose: offer-outcome sync, the bulk reject and a manager's Skip reject without a
-- reason, and a CHECK that demanded one would fail those writes with a 500 nobody can place.
alter table public.ats_candidates drop constraint if exists ats_candidates_rejection_reason_check;
alter table public.ats_candidates add constraint ats_candidates_rejection_reason_check check (
  rejection_reason is null or rejection_reason in (
    'wrong_degree', 'outside_area', 'salary_too_high', 'not_enough_experience',
    'no_answer_to_calls', 'no_longer_interested', 'failed_interview', 'duplicate_cv', 'other'
  )
);
alter table public.ats_candidates drop constraint if exists ats_candidates_answer_marks_is_object;
alter table public.ats_candidates add constraint ats_candidates_answer_marks_is_object
  check (jsonb_typeof(answer_marks) = 'object');

create index if not exists ats_candidates_archived_idx on public.ats_candidates (archived_at) where archived_at is not null;
create index if not exists ats_candidates_created_id_idx on public.ats_candidates (created_at desc, id desc);

comment on column public.ats_candidates.declared_role_family is
  'The role family the applicant tapped (WhatsApp) or chose (careers form) — raw, before the tab map. Read by the Talent Acquisition fence for people still in Needs placing.';
comment on column public.ats_candidates.answer_marks is
  '{answer key: {by: "hr", hr_id, at}} for every answer HR typed. The applicant answering that key clears its mark.';

-- ---------------------------------------------------------------------------------------------
-- 3. Call results
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_candidate_call_results (
  id            bigint generated always as identity primary key,
  candidate_id  uuid not null references public.ats_candidates(id) on delete cascade,
  result        text not null,
  note          text,
  hr_id         text,
  created_at    timestamptz not null default now(),
  constraint ats_candidate_call_results_result_check check (result in (
    'called', 'no_answer', 'interested', 'not_interested', 'call_back'
  )),
  constraint ats_candidate_call_results_note_length check (note is null or char_length(note) <= 300)
);
create index if not exists ats_candidate_call_results_candidate_idx
  on public.ats_candidate_call_results (candidate_id, created_at desc);

alter table public.ats_candidate_call_results enable row level security;
drop policy if exists phx_ats_candidate_call_results_service_role on public.ats_candidate_call_results;
create policy phx_ats_candidate_call_results_service_role
  on public.ats_candidate_call_results for all to service_role using (true) with check (true);
revoke all on public.ats_candidate_call_results from anon, authenticated;
grant select, insert, update, delete on public.ats_candidate_call_results to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Settings
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_recruitment_settings (
  key               text primary key,
  value             jsonb not null,
  updated_at        timestamptz not null default now(),
  updated_by_hr_id  text
);
alter table public.ats_recruitment_settings enable row level security;
drop policy if exists phx_ats_recruitment_settings_service_role on public.ats_recruitment_settings;
create policy phx_ats_recruitment_settings_service_role
  on public.ats_recruitment_settings for all to service_role using (true) with check (true);
revoke all on public.ats_recruitment_settings from anon, authenticated;
grant select, insert, update, delete on public.ats_recruitment_settings to service_role;

-- Starts OFF (owner, 2026-10-20: the WhatsApp re-ask "stays off until you switch it on").
insert into public.ats_recruitment_settings (key, value)
values ('whatsapp_reask_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 5. Single-key answer writes
-- ---------------------------------------------------------------------------------------------

-- One extra-question answer, merged — never the whole map. A NULL or blank value removes the key.
-- p_marked_by_hr_id set = HR typed it (stamped in answer_marks); NULL = the applicant answered, which
-- clears any HR mark on that key so the applicant's own answer wins.
create or replace function public.ats_merge_screening_answer(
  p_candidate_id uuid,
  p_key text,
  p_value text,
  p_marked_by_hr_id text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'An answer needs a question key.' using errcode = 'check_violation';
  end if;
  update public.ats_candidates c
  set screening_extra_answers = case
        when v_value is null then coalesce(c.screening_extra_answers, '{}'::jsonb) - p_key
        else coalesce(c.screening_extra_answers, '{}'::jsonb) || jsonb_build_object(p_key, v_value)
      end,
      answer_marks = case
        when p_marked_by_hr_id is null then coalesce(c.answer_marks, '{}'::jsonb) - p_key
        else coalesce(c.answer_marks, '{}'::jsonb)
             || jsonb_build_object(p_key, jsonb_build_object('by', 'hr', 'hr_id', p_marked_by_hr_id, 'at', now()))
      end,
      updated_at = now()
  where c.id = p_candidate_id;
end;
$$;

-- The mark alone, for the built-in answers that live in their own columns (role, background,
-- region, area, experience, salary). NULL hr id clears the mark.
create or replace function public.ats_set_answer_mark(
  p_candidate_id uuid,
  p_key text,
  p_marked_by_hr_id text
)
returns void
language sql
set search_path = ''
as $$
  update public.ats_candidates c
  set answer_marks = case
        when p_marked_by_hr_id is null then coalesce(c.answer_marks, '{}'::jsonb) - p_key
        else coalesce(c.answer_marks, '{}'::jsonb)
             || jsonb_build_object(p_key, jsonb_build_object('by', 'hr', 'hr_id', p_marked_by_hr_id, 'at', now()))
      end
  where c.id = p_candidate_id;
$$;

revoke all on function public.ats_merge_screening_answer(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ats_set_answer_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ats_merge_screening_answer(uuid, text, text, text) to service_role;
grant execute on function public.ats_set_answer_mark(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Manager returns — three sources, one row per candidate
-- ---------------------------------------------------------------------------------------------
--
--   district_folder — a district manager handed the CV back from his folder, with a reason code and
--                     note (ats_candidate_district_returns), still unresolved.
--   manager_skip    — a sent CV the manager skipped: sent_to_manager -> rejected.
--   taken_back      — Talent Acquisition's recall or the 45-day sweep: sent_to_manager -> shortlisted.
--
-- A status-event return counts only while it is the candidate's LATEST status event — once HR acts
-- on the CV again it is handled and leaves the filter.

create or replace view public.ats_v_candidate_returns
with (security_invoker = true)
as
select distinct on (x.candidate_id)
  x.candidate_id, x.returned_at, x.returned_by_hr_id, x.returned_by_name, x.reason_code, x.reason_note, x.source
from (
  select r.candidate_id, r.returned_at, r.manager_hr_id as returned_by_hr_id, r.manager_name as returned_by_name,
         r.reason_code, r.reason_note, 'district_folder'::text as source
  from public.ats_candidate_district_returns r
  where r.resolved_at is null
  union all
  select e.candidate_id, e.created_at, e.actor_hr_id, null::text, null::text, e.note,
         case when e.to_status = 'rejected' then 'manager_skip' else 'taken_back' end
  from public.ats_candidate_status_events e
  where e.from_status = 'sent_to_manager'
    and e.to_status in ('rejected', 'shortlisted')
    and not exists (
      select 1 from public.ats_candidate_status_events later
      where later.candidate_id = e.candidate_id
        and (later.created_at > e.created_at or (later.created_at = e.created_at and later.id > e.id))
    )
) x
order by x.candidate_id, x.returned_at desc;

revoke all on public.ats_v_candidate_returns from anon, authenticated;
grant select on public.ats_v_candidate_returns to service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. The one filter
-- ---------------------------------------------------------------------------------------------
--
-- p (every key optional; the SERVER sets allowed_tabs and hide_hr_people from the session and never
-- copies them from the request):
--   allowed_tabs     text[]  tabs the viewer may see; "needs_placing" included when they may
--   hide_hr_people   bool    the Talent Acquisition fence — hides a whole PERSON who is in an HR tab
--                            or tapped an HR role
--   tab              text    one role tab, or "needs_placing"; absent = every allowed tab (search)
--   region           text    a region code, or "unspecified"
--   area             text    an AU area code
--   statuses         text[]
--   sources          text[]  whatsapp | email | website | interview_calendar | other
--   from, to         timestamptz (to exclusive) — received
--   answers          {key: [values]} — "__missing__" matches an unanswered key
--   missing          bool    true = incomplete, false = complete
--   call_results     text[]  latest call result
--   returned         bool
--   overdue          bool    with overdue_shortlist_days / overdue_sent_days
--   folder_ids       uuid[]  hand-built folders (descendants expanded by the caller)
--   archived         text    "exclude" (default) | "only" | "include"
--   search           text    name / phone / email
--   search_ids       uuid[]  CV-text matches found by the caller, OR-ed with search
--   candidate_ids    uuid[]  restrict to these

create or replace function public.ats_candidate_answer_value(p_row public.ats_candidates, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'background' then p_row.declared_background
    when 'experience' then p_row.declared_experience
    when 'salary' then p_row.declared_expected_salary
    else p_row.screening_extra_answers ->> p_key
  end
$$;

create or replace function public.ats_workspace_filter(p jsonb)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  with pr as (
    select
      coalesce(array(select jsonb_array_elements_text(coalesce(p->'allowed_tabs', '[]'::jsonb))), '{}'::text[]) as allowed_tabs,
      coalesce((p->>'hide_hr_people')::boolean, false) as hide_hr_people,
      nullif(p->>'tab', '') as tab,
      nullif(p->>'region', '') as region,
      nullif(p->>'area', '') as area,
      case when jsonb_typeof(p->'statuses') = 'array' and jsonb_array_length(p->'statuses') > 0 then array(select jsonb_array_elements_text(p->'statuses')) end as statuses,
      case when jsonb_typeof(p->'sources') = 'array' and jsonb_array_length(p->'sources') > 0 then array(select jsonb_array_elements_text(p->'sources')) end as sources,
      nullif(p->>'from', '')::timestamptz as from_at,
      nullif(p->>'to', '')::timestamptz as to_at,
      case when p ? 'answers' and jsonb_typeof(p->'answers') = 'object' then p->'answers' end as answers,
      nullif(p->>'missing', '')::boolean as missing,
      case when jsonb_typeof(p->'call_results') = 'array' and jsonb_array_length(p->'call_results') > 0 then array(select jsonb_array_elements_text(p->'call_results')) end as call_results,
      nullif(p->>'returned', '')::boolean as returned,
      nullif(p->>'overdue', '')::boolean as overdue,
      coalesce(nullif(p->>'overdue_shortlist_days', '')::int, 14) as overdue_shortlist_days,
      coalesce(nullif(p->>'overdue_sent_days', '')::int, 7) as overdue_sent_days,
      case when jsonb_typeof(p->'folder_ids') = 'array' and jsonb_array_length(p->'folder_ids') > 0 then array(select jsonb_array_elements_text(p->'folder_ids'))::uuid[] end as folder_ids,
      coalesce(nullif(p->>'archived', ''), 'exclude') as archived,
      nullif(btrim(coalesce(p->>'search', '')), '') as search,
      case when jsonb_typeof(p->'search_ids') = 'array' and jsonb_array_length(p->'search_ids') > 0 then array(select jsonb_array_elements_text(p->'search_ids'))::uuid[] end as search_ids,
      case when p ? 'candidate_ids' then array(select jsonb_array_elements_text(p->'candidate_ids'))::uuid[] end as candidate_ids
  )
  select c.id
  from public.ats_candidates c
  cross join pr
  where
    -- the Talent Acquisition fence, by person
    (not pr.hide_hr_people or (
      coalesce(c.declared_role_family, '') not in ('hr_section_head', 'talent_acquisition', 'human_resources')
      and not exists (
        select 1 from public.ats_candidate_placements hp
        where hp.candidate_id = c.id and hp.role_tab in ('hr_section_head', 'talent_acquisition')
      )
    ))
    -- the tab
    and (
      case
        when pr.tab is null then (
          exists (select 1 from public.ats_candidate_placements ap
                  where ap.candidate_id = c.id and ap.role_tab = any(pr.allowed_tabs))
          or ('needs_placing' = any(pr.allowed_tabs)
              and not exists (select 1 from public.ats_candidate_placements np where np.candidate_id = c.id))
        )
        when pr.tab = 'needs_placing' then (
          'needs_placing' = any(pr.allowed_tabs)
          and not exists (select 1 from public.ats_candidate_placements np where np.candidate_id = c.id)
        )
        else (
          pr.tab = any(pr.allowed_tabs)
          and exists (
            select 1 from public.ats_candidate_placements tp
            where tp.candidate_id = c.id
              and tp.role_tab = pr.tab
              and (
                pr.region is null
                or (pr.region = 'unspecified' and (
                      (tp.role_tab = 'medical_rep' and tp.area_code is null)
                      or (tp.role_tab <> 'medical_rep' and tp.region_code is null)))
                or (pr.region <> 'unspecified' and tp.region_code = pr.region
                    and (tp.role_tab <> 'medical_rep' or tp.area_code is not null))
              )
              and (pr.area is null or tp.area_code = pr.area)
          )
        )
      end
    )
    and (case pr.archived
           when 'only' then c.archived_at is not null
           when 'include' then true
           else c.archived_at is null
         end)
    and (pr.statuses is null or c.status = any(pr.statuses))
    and (pr.sources is null or (
      case
        when lower(coalesce(c.source, '')) in ('whatsapp', 'email', 'website', 'interview_calendar') then lower(c.source)
        else 'other'
      end
    ) = any(pr.sources))
    and (pr.from_at is null or c.created_at >= pr.from_at)
    and (pr.to_at is null or c.created_at < pr.to_at)
    and (pr.answers is null or not exists (
      select 1 from jsonb_each(pr.answers) a
      where jsonb_typeof(a.value) = 'array'
        and jsonb_array_length(a.value) > 0
        and not (
          (public.ats_candidate_answer_value(c, a.key) is null and a.value ? '__missing__')
          or coalesce(public.ats_candidate_answer_value(c, a.key), '') in (select jsonb_array_elements_text(a.value))
        )
    ))
    and (pr.missing is null
         or (pr.missing and coalesce(cardinality(c.missing_answer_keys), 0) > 0)
         or (not pr.missing and c.missing_answer_keys is not null and cardinality(c.missing_answer_keys) = 0))
    and (pr.call_results is null or exists (
      select 1 from (
        select r.result from public.ats_candidate_call_results r
        where r.candidate_id = c.id
        order by r.created_at desc, r.id desc
        limit 1
      ) latest
      where latest.result = any(pr.call_results)
    ))
    and (pr.returned is null
         or (pr.returned = exists (select 1 from public.ats_v_candidate_returns rv where rv.candidate_id = c.id)))
    and (pr.overdue is null or pr.overdue = (
      (c.status = 'shortlisted'
        and coalesce(c.status_changed_at, c.created_at) < now() - make_interval(days => pr.overdue_shortlist_days))
      or (c.status = 'sent_to_manager'
        and coalesce(
              (select max(s.sent_at) from public.ats_candidate_manager_sends s where s.candidate_id = c.id),
              c.status_changed_at, c.created_at
            ) < now() - make_interval(days => pr.overdue_sent_days))
    ))
    and (pr.folder_ids is null or exists (
      select 1 from public.ats_cv_folder_items fi
      where fi.candidate_id = c.id and fi.folder_id = any(pr.folder_ids)
    ))
    and (pr.candidate_ids is null or c.id = any(pr.candidate_ids))
    and (pr.search is null and pr.search_ids is null
      or (pr.search is not null and (
            c.full_name ilike '%' || pr.search || '%'
            or c.email_norm ilike '%' || lower(pr.search) || '%'
            or (length(regexp_replace(pr.search, '\D', '', 'g')) >= 4
                and c.phone_norm like '%' || regexp_replace(pr.search, '\D', '', 'g') || '%')
          ))
      or (pr.search_ids is not null and c.id = any(pr.search_ids)))
$$;

-- Keyset-paged ids, newest received first. p.after = {"created_at": ..., "id": ...}; p.limit (1–200, default 50).
create or replace function public.ats_workspace_page(p jsonb)
returns table (candidate_id uuid, created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select c.id, c.created_at
  from public.ats_candidates c
  where c.id in (select public.ats_workspace_filter(p))
    and (
      p->'after' is null
      or (c.created_at, c.id) < ((p->'after'->>'created_at')::timestamptz, (p->'after'->>'id')::uuid)
    )
  order by c.created_at desc, c.id desc
  limit least(greatest(coalesce(nullif(p->>'limit', '')::int, 50), 1), 200)
$$;

-- Every count the screen shows, from the same filter the rows come from:
--   total        the rows the current filters return
--   by_tab       per role tab (+ needs_placing), ignoring tab/region/area
--   by_place     per region and area of the current tab, ignoring region/area
--   by_status    per status in the current tab/place, ignoring the status filter
--   funnel       received → shortlisted → sent to manager → interviewed → offered → hired, ignoring status
create or replace function public.ats_workspace_counts(p jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with
  base_tabs as (select id from public.ats_workspace_filter(p - 'tab' - 'region' - 'area') as f(id)),
  tab_rows as (
    select pl.role_tab as k, count(distinct pl.candidate_id) as n
    from public.ats_candidate_placements pl
    join base_tabs b on b.id = pl.candidate_id
    where pl.role_tab = any(coalesce(array(select jsonb_array_elements_text(coalesce(p->'allowed_tabs', '[]'::jsonb))), '{}'::text[]))
    group by pl.role_tab
    union all
    select 'needs_placing', count(*)
    from base_tabs b
    where 'needs_placing' = any(coalesce(array(select jsonb_array_elements_text(coalesce(p->'allowed_tabs', '[]'::jsonb))), '{}'::text[]))
      and not exists (select 1 from public.ats_candidate_placements np where np.candidate_id = b.id)
  ),
  base_place as (select id from public.ats_workspace_filter(p - 'region' - 'area') as f(id)),
  place_rows as (
    select
      case
        when pl.role_tab = 'medical_rep' and pl.area_code is null then 'unspecified'
        when pl.region_code is null then 'unspecified'
        else pl.region_code
      end as region_key,
      case when pl.role_tab = 'medical_rep' then pl.area_code end as area_key,
      count(distinct pl.candidate_id) as n
    from public.ats_candidate_placements pl
    join base_place b on b.id = pl.candidate_id
    where pl.role_tab = nullif(p->>'tab', '')
    group by 1, 2
  ),
  base_status as (select id from public.ats_workspace_filter(p - 'statuses') as f(id)),
  status_rows as (
    select coalesce(c.status, 'new') as k, count(*) as n
    from public.ats_candidates c join base_status b on b.id = c.id
    group by 1
  ),
  funnel as (
    select
      count(*) as received,
      count(*) filter (where c.status in ('shortlisted', 'sent_to_manager', 'hired')
        or exists (select 1 from public.ats_candidate_status_events e where e.candidate_id = c.id and e.to_status = 'shortlisted')) as shortlisted,
      count(*) filter (where exists (select 1 from public.ats_candidate_manager_sends s where s.candidate_id = c.id)
        or c.status = 'sent_to_manager') as sent_to_manager,
      count(*) filter (where exists (select 1 from public.ats_interview_bookings ib where ib.candidate_id = c.id and ib.starts_at < now())) as interviewed,
      count(*) filter (where c.offer_id is not null) as offered,
      count(*) filter (where c.status = 'hired') as hired
    from public.ats_candidates c join base_status b on b.id = c.id
  )
  select jsonb_build_object(
    'total', (select count(*) from public.ats_workspace_filter(p)),
    'by_tab', coalesce((select jsonb_object_agg(k, n) from tab_rows), '{}'::jsonb),
    'by_place', coalesce((select jsonb_agg(jsonb_build_object('region', region_key, 'area', area_key, 'n', n)) from place_rows), '[]'::jsonb),
    'by_status', coalesce((select jsonb_object_agg(k, n) from status_rows), '{}'::jsonb),
    'funnel', (select to_jsonb(funnel) from funnel)
  )
$$;

revoke all on function public.ats_candidate_answer_value(public.ats_candidates, text) from public, anon, authenticated;
revoke all on function public.ats_workspace_filter(jsonb) from public, anon, authenticated;
revoke all on function public.ats_workspace_page(jsonb) from public, anon, authenticated;
revoke all on function public.ats_workspace_counts(jsonb) from public, anon, authenticated;
grant execute on function public.ats_candidate_answer_value(public.ats_candidates, text) to service_role;
grant execute on function public.ats_workspace_filter(jsonb) to service_role;
grant execute on function public.ats_workspace_page(jsonb) to service_role;
grant execute on function public.ats_workspace_counts(jsonb) to service_role;
