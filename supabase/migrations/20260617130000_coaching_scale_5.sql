-- Re-align the field coaching scoring scale from 1-6 (max 120) to 1-5 (max 100).
--
-- Why: the live field coaching paper template scores every item 1-5 (Overall out
-- of 100). The in-app module was built on a 1-6 / max-120 scale, which silently
-- understated every Overall and zone. This migration brings the database in line
-- with the application constants (coachingMaxItemScore = 5, coachingMaxScore = 100)
-- so imported and newly entered reports compute the correct percentage and zone.
--
-- Performance zones are percent-based (public.phx_coaching_zone) and need no change.
--
-- SAFETY: this mutates existing coaching data. Apply to production only with
-- explicit per-migration approval. Verified before authoring: 3 reports, 60 score
-- items, 3 items currently hold a score of 6 across 2 reports. Those 6s are clamped
-- to 5 and the affected reports are recomputed onto the /100 scale BEFORE the new
-- 1-5 check constraint is added, so the constraint validates cleanly.

begin;

-- 1) Clamp any out-of-range scores (6 -> 5) so the tighter constraint can validate.
update public.coaching_score_items
set score = 5
where score > 5;

-- 2) Recompute every report that has score items onto the /100 scale.
update public.coaching_reports r
set
  actual_score = agg.total,
  max_score = 100,
  final_score_percent = round((agg.total / 100.0) * 100.0, 2),
  performance_zone = public.phx_coaching_zone(round((agg.total / 100.0) * 100.0, 2))
from (
  select report_id, coalesce(sum(score), 0)::numeric as total
  from public.coaching_score_items
  group by report_id
) agg
where r.id = agg.report_id;

-- 3) Bring any score-less drafts onto the new max as well (percent/zone untouched).
update public.coaching_reports
set max_score = 100
where max_score <> 100;

-- 4) Tighten the per-item score range to 1-5.
alter table public.coaching_score_items
  drop constraint if exists coaching_score_items_score_check;
alter table public.coaching_score_items
  add constraint coaching_score_items_score_check check (score between 1 and 5);

-- 5) New reports default to a max score of 100.
alter table public.coaching_reports
  alter column max_score set default 100;

-- 6) Recreate the submit RPC so it divides by the new max (100) and stores max_score = 100.
create or replace function public.submit_coaching_report(
  p_report_id uuid,
  p_actor_hr_id text,
  p_scores jsonb default null,
  p_area_of_development text default null,
  p_general_remarks text default null,
  p_strength_points text default null
)
returns public.coaching_reports
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_report public.coaching_reports%rowtype;
  v_actual_score numeric;
  v_percent numeric;
begin
  select *
  into v_report
  from public.coaching_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Coaching report was not found.';
  end if;

  if v_report.status <> 'draft' then
    raise exception 'Only draft coaching reports can be submitted.';
  end if;

  if p_scores is not null then
    delete from public.coaching_score_items
    where report_id = p_report_id;

    insert into public.coaching_score_items (
      report_id,
      display_order,
      parameter_category,
      score_item_key,
      score_item_label,
      score,
      strength_point,
      area_to_be_improved
    )
    select
      p_report_id,
      def.display_order,
      def.parameter_category,
      item.key,
      def.score_item_label,
      (coalesce(item.value ->> 'score', item.value #>> '{}'))::integer,
      nullif(item.value ->> 'strengthPoint', ''),
      nullif(item.value ->> 'areaToBeImproved', '')
    from jsonb_each(p_scores) as item(key, value)
    join lateral public.phx_coaching_item_definition(item.key) def on true;
  end if;

  select coalesce(sum(score), 0)
  into v_actual_score
  from public.coaching_score_items
  where report_id = p_report_id;

  if (
    select count(*)
    from public.coaching_score_items
    where report_id = p_report_id
  ) <> 20 then
    raise exception 'Exactly 20 coaching scores are required before submission.';
  end if;

  v_percent := round((v_actual_score / 100.0) * 100.0, 2);

  update public.coaching_reports
  set
    actual_score = v_actual_score,
    area_of_development = coalesce(nullif(p_area_of_development, ''), area_of_development),
    final_score_percent = v_percent,
    general_remarks = coalesce(nullif(p_general_remarks, ''), general_remarks),
    max_score = 100,
    performance_zone = public.phx_coaching_zone(v_percent),
    status = 'submitted',
    strength_points = coalesce(nullif(p_strength_points, ''), strength_points),
    submitted_at = now(),
    updated_by = p_actor_hr_id
  where id = p_report_id
  returning *
  into v_report;

  return v_report;
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- Source of Sales product alias scope.
-- Folded into this canonical 20260617130000 migration because Supabase migration
-- history is keyed by timestamp version and cannot represent multiple files with
-- the same version.
-- ---------------------------------------------------------------------------

alter table public.source_of_sales_product_aliases
  add column if not exists distributor_code text;

update public.source_of_sales_product_aliases
  set distributor_code = 'PS'
  where distributor_code is null;

drop index if exists source_of_sales_product_aliases_normalized_alias_key;
create unique index if not exists source_of_sales_product_aliases_distributor_alias_key
  on public.source_of_sales_product_aliases (distributor_code, normalized_alias);

create index if not exists source_of_sales_product_aliases_distributor_idx
  on public.source_of_sales_product_aliases (distributor_code);
