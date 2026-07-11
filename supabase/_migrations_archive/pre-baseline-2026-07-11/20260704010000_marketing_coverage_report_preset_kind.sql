-- Marketing Coverage Report shares the ROI Tracking saved-presets table
-- (marketing_roi_filter_presets) rather than duplicating it. Add a report_kind
-- discriminator so a user can save "My view" once per report without colliding
-- with an existing ROI Tracking preset of the same name, and so "one default
-- per owner" is scoped per report too.
--
-- Additive + backward compatible: every existing row defaults to 'roi_tracking',
-- so ROI Tracking's current presets and its "one default per owner" behavior are
-- unchanged. Nothing here is destructive.
--
-- APPROVAL-GATED — NOT YET APPLIED: stage to staging, verify, then apply to
-- production with explicit per-migration approval.

alter table public.marketing_roi_filter_presets
  add column if not exists report_kind text not null default 'roi_tracking';

alter table public.marketing_roi_filter_presets
  drop constraint if exists marketing_roi_filter_presets_report_kind_check;
alter table public.marketing_roi_filter_presets
  add constraint marketing_roi_filter_presets_report_kind_check
  check (report_kind in ('roi_tracking', 'coverage_report'));

alter table public.marketing_roi_filter_presets
  drop constraint if exists marketing_roi_filter_presets_owner_name_unique;
alter table public.marketing_roi_filter_presets
  add constraint marketing_roi_filter_presets_owner_kind_name_unique
  unique (owner_hr_id, report_kind, name);

drop index if exists marketing_roi_filter_presets_one_default_uidx;
create unique index if not exists marketing_roi_filter_presets_one_default_per_kind_uidx
  on public.marketing_roi_filter_presets (owner_hr_id, report_kind) where is_default = true;

notify pgrst, 'reload schema';
