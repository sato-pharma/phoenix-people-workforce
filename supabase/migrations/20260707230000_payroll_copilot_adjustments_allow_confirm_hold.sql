-- Payroll Copilot: allow 'confirm' and 'hold' adjustment kinds.
--
-- The payroll_copilot_adjustments.kind CHECK constraint was created with only
-- the money-moving/deferral kinds (bonus, penalty, loan, advance, prorate,
-- override, include, defer). But the application's ProposedAction type — and
-- every "Confirm" / "Accept recommendation" / "Hold" action in the UI and the
-- chat parser — also emits 'confirm' and 'hold'. Those inserts have been
-- FAILING the CHECK constraint and getting swallowed by applyActions()'s
-- try/catch, so:
--   • Confirming/accepting a flagged employee never persisted an adjustment —
--     the flag looked resolved for one render (the in-memory flag flip) but
--     re-fired on the next re-assemble, because hasAdjustment stayed false.
--   • "Hold" never actually held anyone's pay (isOnHold() saw no hold row).
--
-- This aligns the DB constraint with the application's action vocabulary so
-- confirm/hold persist and stick. No data change; existing rows all use the
-- already-allowed kinds. Idempotent: drop-if-exists then recreate.

alter table public.payroll_copilot_adjustments
  drop constraint if exists payroll_copilot_adjustments_kind_check;

alter table public.payroll_copilot_adjustments
  add constraint payroll_copilot_adjustments_kind_check
  check (
    kind = any (
      array[
        'bonus'::text,
        'penalty'::text,
        'loan'::text,
        'advance'::text,
        'prorate'::text,
        'override'::text,
        'include'::text,
        'defer'::text,
        'confirm'::text,
        'hold'::text
      ]
    )
  );
