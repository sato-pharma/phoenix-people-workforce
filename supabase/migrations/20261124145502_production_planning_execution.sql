-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — the EXECUTION phase: what the factory produced, taken off stock at the
-- formula, and the waste measured later from the factory's own balance.
--
-- WHAT:
--   · prodplan_runs gains `stage` ('awaiting_balance' | 'balanced' | 'cancelled'), the saleable box
--     count as he typed it, the exact batch count those boxes come to, who closed it and when, and
--     why it was cancelled. Every existing row (there are none on production, 2026-11-24) reads
--     'balanced', which is what a run recorded the old way — with its closing balances — always was.
--   · prodplan_run_materials gains `deducted_qty` (what came off recorded stock), `unrecorded_qty`
--     (what the formula needed and no recorded stock held) and `closing_source` ('provisional'
--     until the factory's own balance replaces it, then 'factory').
--   · prodplan_stock_entries gains a `run_id` and a sixth source, 'production': the row a recorded
--     execution writes when it takes the formula quantity off a lot. A 'production' row must name
--     its run, so a deduction can always be traced and undone.
--
-- WHY: owner, 2026-11-24 — "We used to enter the quantities for planning. Now I want to be able to
-- add units executed, units already produced … تم انتاج ٢٢١٣٠ علبه ساجنكو و٦٩٨٥ عينه … يديني الستوك
-- وخليه ما يحسبش نسبة هادر. بعد كام يوم حاجيب الرصيد من المصنع ونبقى نحسب كمية الهادر ساعتها يحسب
-- على الactual only … I want to be in full control to either plan, either execute." So an execution
-- takes the NET formula quantity off stock (no overage), and the run waits for the factory's balance;
-- only then is the waste — consumed minus formula — measured, and only a balanced run teaches the
-- learner.
--
-- ROLLBACK (by hand, only while no row uses the new values):
--   alter table public.prodplan_stock_entries drop constraint prodplan_stock_entries_production_run_check;
--   alter table public.prodplan_stock_entries drop constraint prodplan_stock_entries_source_check;
--   alter table public.prodplan_stock_entries add constraint prodplan_stock_entries_source_check
--     check (source = any (array['factory_report','own_count','delivery','adjustment']));
--   drop index if exists public.prodplan_stock_entries_run_idx;
--   alter table public.prodplan_stock_entries drop constraint prodplan_stock_entries_moved_check;
--   alter table public.prodplan_stock_entries drop column run_id, drop column moved_qty;
--   alter table public.prodplan_run_materials drop column deducted_qty, drop column unrecorded_qty, drop column closing_source;
--   alter table public.prodplan_runs drop column stage, drop column saleable_boxes, drop column exact_runs,
--     drop column balanced_on, drop column balanced_by_login, drop column cancelled_reason;
--
-- Neither destructive nor bulk: columns added with defaults, two CHECKs widened, no row rewritten.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. A run has a stage ─────────────────────────────────────────────────────────────────────────
alter table public.prodplan_runs
  add column if not exists stage text not null default 'balanced',
  add column if not exists saleable_boxes bigint,
  add column if not exists exact_runs numeric(14,6),
  add column if not exists balanced_on date,
  add column if not exists balanced_by_login text,
  add column if not exists cancelled_reason text;

alter table public.prodplan_runs drop constraint if exists prodplan_runs_stage_check;
alter table public.prodplan_runs add constraint prodplan_runs_stage_check
  check (stage = any (array['awaiting_balance'::text, 'balanced'::text, 'cancelled'::text]));

alter table public.prodplan_runs drop constraint if exists prodplan_runs_saleable_boxes_check;
alter table public.prodplan_runs add constraint prodplan_runs_saleable_boxes_check
  check (saleable_boxes is null or saleable_boxes >= 0);

alter table public.prodplan_runs drop constraint if exists prodplan_runs_exact_runs_check;
alter table public.prodplan_runs add constraint prodplan_runs_exact_runs_check
  check (exact_runs is null or exact_runs > 0);

-- A cancellation always says why, like an exclusion: the next reader must know it was a decision.
alter table public.prodplan_runs drop constraint if exists prodplan_runs_cancel_reason_check;
alter table public.prodplan_runs add constraint prodplan_runs_cancel_reason_check
  check (stage <> 'cancelled' or char_length(btrim(coalesce(cancelled_reason, ''))) > 0);

comment on column public.prodplan_runs.stage is
  'awaiting_balance: produced and taken off stock at the formula, waste not yet measured. balanced: the factory''s own closing balance is in, so consumed − formula is the measured waste. cancelled: the deduction was given back to stock. Only a balanced run teaches the overage learner.';
comment on column public.prodplan_runs.saleable_boxes is
  'The saleable box count as he typed it (22,130 for Saginkgo on 2026-11-24). actual_good_units is that × units_per_box.';
comment on column public.prodplan_runs.exact_runs is
  'The batches the produced boxes and samples come to, unrounded (23.294167). runs_count holds it rounded up, because that column is a whole number.';

-- ── 2. A run's material line says what came off stock ────────────────────────────────────────────
alter table public.prodplan_run_materials
  add column if not exists deducted_qty numeric(24,6),
  add column if not exists unrecorded_qty numeric(24,6) not null default 0,
  add column if not exists closing_source text not null default 'factory';

alter table public.prodplan_run_materials drop constraint if exists prodplan_run_materials_deducted_check;
alter table public.prodplan_run_materials add constraint prodplan_run_materials_deducted_check
  check (deducted_qty is null or deducted_qty >= 0);

alter table public.prodplan_run_materials drop constraint if exists prodplan_run_materials_unrecorded_check;
alter table public.prodplan_run_materials add constraint prodplan_run_materials_unrecorded_check
  check (unrecorded_qty >= 0);

alter table public.prodplan_run_materials drop constraint if exists prodplan_run_materials_closing_source_check;
alter table public.prodplan_run_materials add constraint prodplan_run_materials_closing_source_check
  check (closing_source = any (array['provisional'::text, 'factory'::text]));

alter table public.prodplan_run_materials drop constraint if exists prodplan_run_materials_execution_whole_check;
alter table public.prodplan_run_materials add constraint prodplan_run_materials_execution_whole_check
  check (
    unit_kind <> 'count'
    or ((deducted_qty is null or deducted_qty = trunc(deducted_qty)) and unrecorded_qty = trunc(unrecorded_qty))
  );

comment on column public.prodplan_run_materials.deducted_qty is
  'What the execution took off recorded stock — the formula quantity with no overage, as far as recorded stock reached.';
comment on column public.prodplan_run_materials.unrecorded_qty is
  'What the formula needed beyond every recorded lot. The run happened, so the material existed; the stock records were short by this much.';
comment on column public.prodplan_run_materials.closing_source is
  'provisional: closing is opening + delivered − deducted, the formula''s own answer. factory: the factory''s reported balance, so consumed_qty is the real consumption.';

-- ── 3. A stock row can be a production deduction, and then it names its run ─────────────────────
alter table public.prodplan_stock_entries
  add column if not exists run_id uuid references public.prodplan_runs (id) on delete restrict,
  add column if not exists moved_qty numeric(24,6);

alter table public.prodplan_stock_entries drop constraint if exists prodplan_stock_entries_moved_check;
alter table public.prodplan_stock_entries add constraint prodplan_stock_entries_moved_check
  check (moved_qty is null or moved_qty >= 0);

-- Every foreign key in public has an index that leads with its columns (F-DB-006).
create index if not exists prodplan_stock_entries_run_idx
  on public.prodplan_stock_entries (run_id)
  where run_id is not null;

alter table public.prodplan_stock_entries drop constraint if exists prodplan_stock_entries_source_check;
alter table public.prodplan_stock_entries add constraint prodplan_stock_entries_source_check
  check (source = any (array[
    'factory_report'::text, 'own_count'::text, 'delivery'::text, 'adjustment'::text, 'production'::text
  ]));

alter table public.prodplan_stock_entries drop constraint if exists prodplan_stock_entries_production_run_check;
alter table public.prodplan_stock_entries add constraint prodplan_stock_entries_production_run_check
  check (source <> 'production' or (run_id is not null and moved_qty is not null));

comment on column public.prodplan_stock_entries.moved_qty is
  'For a run''s own rows: the amount this row took off the lot (production) or gave back to it (a cancelled run). The stored qty is the balance after it, so this is what makes a deduction reversible lot by lot.';

comment on column public.prodplan_stock_entries.run_id is
  'The recorded run this row belongs to: its production deduction, the give-back of a cancelled run, or the factory balance that closed it.';

commit;
