-- The iReports360 API can be retired without a global cutover date.
--
-- 20260913230000_crm_cutover.sql made `vendor_sync_retired_at` need `cutover_date`
-- (`crm_cutover_retire_needs_date`). That was right while ONE date was the whole switch. Since
-- 2026-10-03 every team moves on its own Phoenix start date (`phoenix_crm_team_starts`, 21 seats, the
-- last on 2026-10-17), so the views already serve Phoenix rows for every started team without any
-- global date — and the global date now carries effects of its own that closing the vendor API must
-- not drag in: the calendar month it falls in is never charged CRM no-activity (owner decision 18),
-- KPI scoring switches to the Phoenix rules, vacation-day requests come into force and the KPI series
-- breaks. Those are a money decision for the owner, taken separately; standing the vendor pull down is
-- not.
--
-- So the retirement stands alone: `vendor_sync_retired_at` with a null `cutover_date` stands every
-- vendor pull down and changes nothing else — no read, no deduction, no KPI rule. `parseCrmCutoverRow`
-- (src/lib/crm/cutover.ts) honours it the same way.
--
-- Rollback (only while no row is retired without a date):
--   alter table public.crm_cutover add constraint crm_cutover_retire_needs_date
--     check (vendor_sync_retired_at is null or cutover_date is not null);

alter table public.crm_cutover drop constraint if exists crm_cutover_retire_needs_date;

comment on column public.crm_cutover.vendor_sync_retired_at is
  'When every iReports360 pull was stood down. Independent of cutover_date since 20261031150000: retiring the vendor never sets a cutover month.';
