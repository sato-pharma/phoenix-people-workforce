-- Per-window record of when each 30-day slice of CRM history was last PROVEN equal to the vendor.
--
-- WHY. Every sync in this repo is bounded to a recent window — the live poll covers today, the
-- rolling cron 10 days, the wide reconcile 120 days as four 30-day slices on a 4-week rotation.
-- Nothing has ever re-examined a day older than 120 days. Measured on production 2026-08-28:
-- 53,068 of 126,547 mirror rows (42%) sat past that horizon, uncompared since the day they were
-- first pulled, and 509 rows across 8 months genuinely disagreed with the CRM (473 the mirror holds
-- and the CRM does not, 36 the CRM holds and the mirror does not).
--
-- The cause is structural rather than a coding mistake: the vendor's API can only be queried BY
-- VISIT DATE and has no "changed since" filter, so a visit saved late — every one of the 36 missing
-- rows was entered 18 to 91 days after its own visit date — lands in a window that every scheduled
-- sync has already passed over, and nothing ever goes back for it.
--
-- This table is what makes "go back for it" possible without re-fetching all of history every run:
-- it holds the LATEST verification per window, so the sweep can pick the stalest window each time
-- and cover everything on a rotation whose per-run cost stays flat as history grows.
--
-- SHAPE. One row per window, keyed on the window's START date. Deliberately not keyed on the pair:
-- the newest window's END moves every day (it is clamped to today), so a composite key would make
-- that window look brand new daily and starve every older window of its turn.
--
-- It is a running STATE table, not a log — `checked_at` is overwritten on each verification. The
-- audit trail of what a check actually did already exists in ireports360_visits_sync_runs, which
-- records every fetch/upsert/delete with its own timestamps.
--
-- SAFE IN BOTH DIRECTIONS. Purely additive: no existing code reads or writes this table, and the
-- sweep degrades to a logged no-op when the table is absent (see runIReports360ParitySweep), so the
-- deploy order does not matter for this one. That is deliberately unlike the counter column added in
-- 20260828100000, which MUST be applied before its code ships.

create table if not exists public.ireports360_parity_windows (
  window_from       date primary key,
  window_to         date not null,
  checked_at        timestamptz not null default now(),
  -- Row counts on each side at the moment of the check. Kept even when equal so a window's history
  -- of volume is readable without re-querying the vendor.
  crm_rows          integer not null default 0,
  mirror_rows       integer not null default 0,
  -- The two directions of disagreement, counted separately because they mean different things and
  -- carry different risk. Missing rows are the late-save case and are always safe to add. Extra
  -- rows mean the CRM no longer returns something the mirror holds, which is either a genuine
  -- deletion in the CRM or a degraded fetch — and acting on the wrong one destroys real history.
  missing_in_mirror integer not null default 0,
  extra_in_mirror   integer not null default 0,
  -- 'equal' | 'repair' | 'refuse'. 'refuse' means the sweep declined to act because the vendor's
  -- answer looked wrong rather than the mirror (empty answer, or >50% of the mirror missing).
  status            text not null,
  -- Why a check refused, verbatim. Null on a clean or repaired window.
  last_error        text
);

create index if not exists ireports360_parity_windows_checked_at_idx
  on public.ireports360_parity_windows (checked_at);

alter table public.ireports360_parity_windows enable row level security;

-- Matches every other ireports360_ table: application-scoped visibility, service_role only at the
-- database. Nothing in the browser reads this.
drop policy if exists phx_ireports360_parity_windows_service_role on public.ireports360_parity_windows;
create policy phx_ireports360_parity_windows_service_role
  on public.ireports360_parity_windows
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.ireports360_parity_windows to service_role;

comment on table public.ireports360_parity_windows is
  'Latest parity verification of each 30-day window of iReports360 history against the vendor API. Written by runIReports360ParitySweep. A window whose checked_at is older than ~21 days means the sweep itself has stopped running, not that the rotation is mid-cycle — with ~8 windows and one run a day, full coverage takes ~8 days.';

comment on column public.ireports360_parity_windows.extra_in_mirror is
  'Rows the mirror holds that the CRM did not return for this window. NOT automatically deleted when it exceeds half the window (see decideParityAction) — at that size the likeliest explanation is a truncated vendor response, and deleting settled history on a bad fetch is unrecoverable because the CRM would have to still be serving those rows to restore them.';
