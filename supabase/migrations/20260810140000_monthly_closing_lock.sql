-- LOCK A MONTHLY CLOSING SO NOTHING CAN CHANGE IT — including us.
--
-- The owner's concern is not a user editing a published month through the UI. It is the month
-- moving underneath him afterwards: a migration, a re-import, an ad-hoc SQL repair, a well-meant
-- backfill. Every one of those bypasses the application entirely, so a button that only disables
-- itself in React protects nothing. Tonight alone, a Pharma Overseas re-import silently reverted 24
-- customers' area rulings and put a 212-unit double count back into CNS; neither touched a screen.
--
-- So the lock lives in the database and is enforced by triggers on the three tables a closing is
-- actually built from. Once a (line, period) is locked, an INSERT, UPDATE or DELETE touching it
-- raises and the whole transaction rolls back — service_role included, which is the point, because
-- service_role is what every one of those back doors runs as.
--
-- WHY STATEMENT-LEVEL, NOT ROW-LEVEL. source_of_sales_import_rows takes ~42,000 rows in a single
-- July import. A FOR EACH ROW trigger would run 42,000 lookups per import. These triggers use
-- transition tables and run ONCE per statement, so a locked month costs one indexed probe and an
-- unlocked one costs the same. AFTER rather than BEFORE because only AFTER triggers may declare
-- transition tables; raising there still aborts the transaction, so nothing is written either way.
--
-- LOCKING AND UNLOCKING ARE BOTH ONE CLICK, by the owner's decision (2026-08-10). The lock is not
-- meant to be bureaucracy — it is a switch he flips when a month is finished so nothing can drift
-- underneath it, and flips back the moment he genuinely wants to change something. No reason field
-- to fill in, no second confirmation.
--
-- What is still recorded, because it costs him nothing: who locked it, when, the numbers at that
-- moment, and who released it. Every lock and release stays as a row, so the history of what was
-- frozen and when survives even though the switch itself is free to use.

begin;

create table if not exists public.monthly_closing_locks (
  id uuid primary key default gen_random_uuid(),
  line text not null,
  normalized_line text not null,
  period text not null,
  locked_at timestamptz not null default now(),
  locked_by text,
  -- The numbers as they stood at lock time. Kept ON the lock row so "what did we lock?" is
  -- answerable without recomputing anything from tables that may since have moved.
  snapshot_units numeric,
  snapshot_cells integer,
  snapshot_breakdown jsonb,
  unlocked_at timestamptz,
  unlocked_by text,
  unlock_reason text
);

-- One ACTIVE lock per (line, period); released locks stay as history and may repeat the key.
create unique index if not exists monthly_closing_locks_one_active
  on public.monthly_closing_locks (normalized_line, period)
  where unlocked_at is null;

create index if not exists monthly_closing_locks_period_idx
  on public.monthly_closing_locks (period)
  where unlocked_at is null;

comment on table public.monthly_closing_locks is
  'An active row here freezes that (line, period) in source_of_sales_import_rows, '
  'source_of_sales_fact_rollup and source_of_sales_customer_directory_rollup. Enforced by '
  'triggers, so migrations and ad-hoc SQL are stopped too, not just the application.';

-- ── the guard ───────────────────────────────────────────────────────────────────────────────────
-- tg_argv[0] = the period column on this table, tg_argv[1] = the line column.
create or replace function public.phx_reject_write_to_locked_closing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_col text := tg_argv[0];
  v_line_col   text := tg_argv[1];
  v_hit        text;
begin
  -- INSERT and UPDATE are checked against the NEW rows: writing INTO a locked month is blocked.
  if tg_op in ('INSERT', 'UPDATE') then
    execute format(
      'select l.line || '' '' || l.period
         from new_rows r
         join public.monthly_closing_locks l
           on l.period = r.%I
          and l.normalized_line = lower(btrim(coalesce(r.%I, '''')))
          and l.unlocked_at is null
        limit 1', v_period_col, v_line_col)
    into v_hit;
    if v_hit is not null then
      raise exception
        'Monthly closing % is LOCKED. No row may be added, changed or removed for it — this includes migrations and direct SQL. Unlock it first (Super Admin, with a reason).', v_hit
        using errcode = 'check_violation', hint = 'select * from public.monthly_closing_locks where unlocked_at is null;';
    end if;
  end if;

  -- UPDATE and DELETE are checked against the OLD rows too: moving a row OUT of a locked month, or
  -- deleting it, changes that month just as surely as writing into it.
  if tg_op in ('UPDATE', 'DELETE') then
    execute format(
      'select l.line || '' '' || l.period
         from old_rows r
         join public.monthly_closing_locks l
           on l.period = r.%I
          and l.normalized_line = lower(btrim(coalesce(r.%I, '''')))
          and l.unlocked_at is null
        limit 1', v_period_col, v_line_col)
    into v_hit;
    if v_hit is not null then
      raise exception
        'Monthly closing % is LOCKED. No row may be added, changed or removed for it — this includes migrations and direct SQL. Unlock it first (Super Admin, with a reason).', v_hit
        using errcode = 'check_violation', hint = 'select * from public.monthly_closing_locks where unlocked_at is null;';
    end if;
  end if;

  return null;
end;
$$;

comment on function public.phx_reject_write_to_locked_closing() is
  'Statement-level guard: aborts any INSERT/UPDATE/DELETE touching a locked (line, period). '
  'Checks NEW rows on insert/update and OLD rows on update/delete, so a row cannot be moved out '
  'of a locked month either.';

-- ── attach to the three tables a closing is built from ──────────────────────────────────────────
drop trigger if exists trg_lock_guard_ins on public.source_of_sales_import_rows;
drop trigger if exists trg_lock_guard_upd on public.source_of_sales_import_rows;
drop trigger if exists trg_lock_guard_del on public.source_of_sales_import_rows;
create trigger trg_lock_guard_ins after insert on public.source_of_sales_import_rows
  referencing new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('invoice_period', 'official_line');
create trigger trg_lock_guard_upd after update on public.source_of_sales_import_rows
  referencing new table as new_rows old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('invoice_period', 'official_line');
create trigger trg_lock_guard_del after delete on public.source_of_sales_import_rows
  referencing old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('invoice_period', 'official_line');

drop trigger if exists trg_lock_guard_ins on public.source_of_sales_fact_rollup;
drop trigger if exists trg_lock_guard_upd on public.source_of_sales_fact_rollup;
drop trigger if exists trg_lock_guard_del on public.source_of_sales_fact_rollup;
create trigger trg_lock_guard_ins after insert on public.source_of_sales_fact_rollup
  referencing new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');
create trigger trg_lock_guard_upd after update on public.source_of_sales_fact_rollup
  referencing new table as new_rows old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');
create trigger trg_lock_guard_del after delete on public.source_of_sales_fact_rollup
  referencing old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

drop trigger if exists trg_lock_guard_ins on public.source_of_sales_customer_directory_rollup;
drop trigger if exists trg_lock_guard_upd on public.source_of_sales_customer_directory_rollup;
drop trigger if exists trg_lock_guard_del on public.source_of_sales_customer_directory_rollup;
create trigger trg_lock_guard_ins after insert on public.source_of_sales_customer_directory_rollup
  referencing new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');
create trigger trg_lock_guard_upd after update on public.source_of_sales_customer_directory_rollup
  referencing new table as new_rows old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');
create trigger trg_lock_guard_del after delete on public.source_of_sales_customer_directory_rollup
  referencing old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

-- ── lock / unlock ───────────────────────────────────────────────────────────────────────────────
-- Locking takes the snapshot in the SAME statement, so the numbers recorded are the numbers frozen.
create or replace function public.phx_lock_monthly_closing(
  p_line text,
  p_period text,
  p_actor text default null
) returns public.monthly_closing_locks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := lower(btrim(coalesce(p_line, '')));
  v_row  public.monthly_closing_locks;
  v_units numeric;
  v_cells integer;
begin
  if v_norm = '' or btrim(coalesce(p_period, '')) = '' then
    raise exception 'A line and a period are required to lock a closing.';
  end if;

  select coalesce(sum(total_qty), 0), count(*)
    into v_units, v_cells
    from public.source_of_sales_fact_rollup
   where period = p_period and lower(btrim(coalesce(official_line, ''))) = v_norm;

  insert into public.monthly_closing_locks
    (line, normalized_line, period, locked_by, snapshot_units, snapshot_cells, snapshot_breakdown)
  values
    (btrim(p_line), v_norm, btrim(p_period), p_actor, v_units, v_cells,
     (select jsonb_agg(jsonb_build_object('a', area_code, 'p', product_code,
                                          'd', is_direct, 'u', total_qty))
        from public.source_of_sales_fact_rollup
       where period = p_period and lower(btrim(coalesce(official_line, ''))) = v_norm))
  returning * into v_row;

  return v_row;
end;
$$;

-- Unlock keeps the original row and stamps the release onto it, so the history of who froze a month
-- and who released it survives. A reason is OPTIONAL by the owner's decision — the switch has to be
-- free to use or it will not get used, and an unlock nobody bothers to perform protects nothing.
create or replace function public.phx_unlock_monthly_closing(
  p_line text,
  p_period text,
  p_actor text default null,
  p_reason text default null
) returns public.monthly_closing_locks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := lower(btrim(coalesce(p_line, '')));
  v_row  public.monthly_closing_locks;
begin
  update public.monthly_closing_locks
     set unlocked_at = now(),
         unlocked_by = p_actor,
         unlock_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where normalized_line = v_norm and period = btrim(p_period) and unlocked_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No active lock found for % %.', p_line, p_period;
  end if;
  return v_row;
end;
$$;

-- Revoke from PUBLIC, anon AND authenticated. Revoking only the latter two is a no-op, because both
-- inherit EXECUTE through PUBLIC membership — a browser session could then freeze or release the
-- company's closed months. Revoking PUBLIC on a default ACL also strips service_role, so every
-- function is re-granted to it explicitly afterwards; without that the app itself loses the switch.
revoke execute on function public.phx_lock_monthly_closing(text, text, text) from public, anon, authenticated;
revoke execute on function public.phx_unlock_monthly_closing(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.phx_reject_write_to_locked_closing() from public, anon, authenticated;
grant execute on function public.phx_lock_monthly_closing(text, text, text) to service_role;
grant execute on function public.phx_unlock_monthly_closing(text, text, text, text) to service_role;

alter table public.monthly_closing_locks enable row level security;
-- No policy: the app reaches this table through the service-role client only, and service_role
-- bypasses RLS. Leaving it enabled with no policy means anon/authenticated get nothing, which is
-- the correct default for a table that records who froze the company's numbers.

commit;
