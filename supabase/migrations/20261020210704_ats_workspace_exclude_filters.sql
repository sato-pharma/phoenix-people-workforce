-- ats_workspace_exclude_filters
--
-- WHAT THIS CHANGES: the Recruitment workspace filter learns to HIDE as well as to keep.
--   ats_workspace_filter(p) reads three new keys, each a jsonb array:
--     exclude_statuses      hide candidates whose status is in the list ("hide Shortlisted, Rejected")
--     exclude_sources       hide candidates whose source bucket is in the list
--     exclude_call_results  hide candidates whose LATEST call result is in the list
--                           (a candidate never called stays in, as with the keep filter's opposite)
--   ats_workspace_counts(p) strips exclude_statuses beside statuses for by_status and the funnel,
--   so a hidden status still shows how many it hides.
--   Every other line of both functions is the live definition read from pg_proc on 2026-10-20.
-- WHY: owner, 2026-10-20 — "a filter to exclude, for example, exclude shortlisted, exclude rejected".
--   Filtering stays in the database (module rule: never compute a filter or count in TypeScript).
-- ROLLBACK: re-run the two CREATE OR REPLACE statements from
--   20261020010000_ats_recruitment_workspace_foundation.sql. The new keys are only ever sent by the
--   app; with them absent both functions return exactly what they returned before. No data changes.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.ats_workspace_filter(p jsonb)
 returns setof uuid
 language sql
 stable
 set search_path to ''
as $function$
  with pr as (
    select
      coalesce(array(select jsonb_array_elements_text(coalesce(p->'allowed_tabs', '[]'::jsonb))), '{}'::text[]) as allowed_tabs,
      coalesce((p->>'hide_hr_people')::boolean, false) as hide_hr_people,
      nullif(p->>'tab', '') as tab,
      nullif(p->>'region', '') as region,
      nullif(p->>'area', '') as area,
      case when jsonb_typeof(p->'statuses') = 'array' and jsonb_array_length(p->'statuses') > 0 then array(select jsonb_array_elements_text(p->'statuses')) end as statuses,
      case when jsonb_typeof(p->'exclude_statuses') = 'array' and jsonb_array_length(p->'exclude_statuses') > 0 then array(select jsonb_array_elements_text(p->'exclude_statuses')) end as exclude_statuses,
      case when jsonb_typeof(p->'sources') = 'array' and jsonb_array_length(p->'sources') > 0 then array(select jsonb_array_elements_text(p->'sources')) end as sources,
      case when jsonb_typeof(p->'exclude_sources') = 'array' and jsonb_array_length(p->'exclude_sources') > 0 then array(select jsonb_array_elements_text(p->'exclude_sources')) end as exclude_sources,
      nullif(p->>'from', '')::timestamptz as from_at,
      nullif(p->>'to', '')::timestamptz as to_at,
      case when p ? 'answers' and jsonb_typeof(p->'answers') = 'object' then p->'answers' end as answers,
      nullif(p->>'missing', '')::boolean as missing,
      case when jsonb_typeof(p->'call_results') = 'array' and jsonb_array_length(p->'call_results') > 0 then array(select jsonb_array_elements_text(p->'call_results')) end as call_results,
      case when jsonb_typeof(p->'exclude_call_results') = 'array' and jsonb_array_length(p->'exclude_call_results') > 0 then array(select jsonb_array_elements_text(p->'exclude_call_results')) end as exclude_call_results,
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
    -- hide: a candidate with no status reads as 'new', the same key ats_workspace_counts uses
    and (pr.exclude_statuses is null or coalesce(c.status, 'new') <> all(pr.exclude_statuses))
    and (pr.sources is null or (
      case
        when lower(coalesce(c.source, '')) in ('whatsapp', 'email', 'website', 'interview_calendar') then lower(c.source)
        else 'other'
      end
    ) = any(pr.sources))
    and (pr.exclude_sources is null or (
      case
        when lower(coalesce(c.source, '')) in ('whatsapp', 'email', 'website', 'interview_calendar') then lower(c.source)
        else 'other'
      end
    ) <> all(pr.exclude_sources))
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
    -- hide: only the LATEST call result counts; a candidate never called stays in
    and (pr.exclude_call_results is null or not exists (
      select 1 from (
        select r.result from public.ats_candidate_call_results r
        where r.candidate_id = c.id
        order by r.created_at desc, r.id desc
        limit 1
      ) latest
      where latest.result = any(pr.exclude_call_results)
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
$function$;

create or replace function public.ats_workspace_counts(p jsonb)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
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
  -- the status tiles count every status, kept or hidden, so a hidden one still says how many it hides
  base_status as (select id from public.ats_workspace_filter(p - 'statuses' - 'exclude_statuses') as f(id)),
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
$function$;

-- CREATE OR REPLACE keeps the existing ACL; restated so the file stands on its own.
revoke all on function public.ats_workspace_filter(jsonb) from public, anon, authenticated;
revoke all on function public.ats_workspace_counts(jsonb) from public, anon, authenticated;
grant execute on function public.ats_workspace_filter(jsonb) to service_role;
grant execute on function public.ats_workspace_counts(jsonb) to service_role;

commit;
