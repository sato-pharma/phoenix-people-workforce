-- Marketing request control settings.
-- SFE and Super Admin can manage operational controls; validation settings stay
-- Super Admin only in the application service layer.

create table if not exists public.marketing_control_settings (
  setting_key text primary key,
  setting_group text not null,
  setting_label text not null,
  setting_value jsonb not null default '{}'::jsonb,
  admin_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_hr_id text null,
  constraint marketing_control_settings_key_not_blank check (btrim(setting_key) <> ''),
  constraint marketing_control_settings_group_not_blank check (btrim(setting_group) <> ''),
  constraint marketing_control_settings_label_not_blank check (btrim(setting_label) <> ''),
  constraint marketing_control_settings_group_check
    check (setting_group in ('roi', 'finance', 'validation'))
);
insert into public.marketing_control_settings (
  setting_key,
  setting_group,
  setting_label,
  setting_value,
  admin_only
)
values
  ('roi_multiplier', 'roi', 'ROI multiplier', '{"multiplier": 10}'::jsonb, false),
  ('finance_invoice_deadline_days', 'finance', 'Finance invoice deadline', '{"days": 7}'::jsonb, false),
  ('customer_gps_required', 'validation', 'Customer GPS capture required', '{"required": true}'::jsonb, true),
  ('customer_live_photo_required', 'validation', 'Customer live timestamp photo required', '{"required": true}'::jsonb, true),
  ('pharmacy_gps_required', 'validation', 'Pharmacy GPS capture required', '{"required": true}'::jsonb, true),
  ('pharmacy_live_photo_required', 'validation', 'Pharmacy live timestamp photo required', '{"required": true}'::jsonb, true),
  ('vendor_code_match_required', 'validation', 'Distributor pharmacy code match required', '{"required": true}'::jsonb, true),
  ('sfe_human_validation_required', 'validation', 'SFE human validation required', '{"required": true}'::jsonb, true)
on conflict (setting_key) do update
set
  setting_group = excluded.setting_group,
  setting_label = excluded.setting_label,
  setting_value = excluded.setting_value,
  admin_only = excluded.admin_only,
  updated_at = now();
alter table public.marketing_control_settings enable row level security;
grant select on table public.marketing_control_settings to authenticated;
grant all on table public.marketing_control_settings to service_role;
drop policy if exists marketing_control_settings_authenticated_read on public.marketing_control_settings;
create policy marketing_control_settings_authenticated_read
on public.marketing_control_settings
for select
to authenticated
using (admin_only = false);
notify pgrst, 'reload schema';
