-- Weekly Sales distributor correction:
-- The Ibn Sina Sato/PAS weekly feed was initially registered as generic Ibn Sina (IS).
-- Phoenix already treats this channel as its own distributor in monthly sales: IS-S / Ibn Sina-Sato.
-- This migration makes the global distributor master and existing weekly rows consistent.

insert into public.source_of_sales_distributors (
  distributor_code,
  distributor_name,
  normalized_distributor_name,
  source_file,
  source_sheet,
  source_row_number,
  active
) values (
  'IS-S',
  'Ibn Sina-Sato',
  lower('Ibn Sina-Sato'),
  'weekly_sales_ibn_sina_sato_distributor',
  'migration',
  null,
  true
)
on conflict (distributor_code) do update set
  distributor_name = excluded.distributor_name,
  normalized_distributor_name = excluded.normalized_distributor_name,
  active = true,
  updated_at = now();

do $$
begin
  if exists (
    select 1
    from public.weekly_sales_batches old_batch
    join public.weekly_sales_batches canonical_batch
      on canonical_batch.distributor_code = 'IS-S'
     and canonical_batch.week_start = old_batch.week_start
     and canonical_batch.status = 'validated'
     and old_batch.status = 'validated'
     and canonical_batch.id <> old_batch.id
    where upper(btrim(old_batch.distributor_code)) = 'IS'
      and old_batch.template_key = 'ibn_sina_weekly_datahub'
  ) then
    raise exception 'Cannot recode weekly IS batches to IS-S because a validated IS-S batch already exists for the same week.';
  end if;
end $$;

update public.weekly_sales_batches
set distributor_code = 'IS-S',
    distributor_name = 'Ibn Sina-Sato',
    template_key = case
      when template_key = 'ibn_sina_weekly_datahub' then 'ibn_sina_sato_weekly_datahub'
      else template_key
    end,
    updated_at = now()
where upper(btrim(distributor_code)) = 'IS'
  and template_key = 'ibn_sina_weekly_datahub';

update public.weekly_sales_rows row
set distributor_code = 'IS-S',
    distributor_name = 'Ibn Sina-Sato'
where upper(btrim(row.distributor_code)) = 'IS'
  and exists (
    select 1
    from public.weekly_sales_batches batch
    where batch.id = row.batch_id
      and batch.distributor_code = 'IS-S'
      and batch.template_key = 'ibn_sina_sato_weekly_datahub'
  );
