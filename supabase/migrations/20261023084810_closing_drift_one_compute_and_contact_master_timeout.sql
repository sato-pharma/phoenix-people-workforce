-- closing_drift_one_compute_and_contact_master_timeout
--
-- WHAT THIS CHANGES:
--   phx_closing_drift_rows(text, text)           NEW      — the drift cells of one published line
--                                                           and period as a jsonb array. The ONE
--                                                           place the expensive
--                                                           phx_closing_publication_snapshot
--                                                           recompute is paid for.
--   phx_closing_drift_fingerprint_of(jsonb)      NEW      — the fingerprint FORMULA, over those
--                                                           rows. Byte-identical expression to the
--                                                           one it is lifted out of.
--   phx_closing_drift_fingerprint(text, text)    REPLACED — now formula(rows). Same answer.
--   phx_closing_drift_overview(text, text)       NEW      — {status, cells} off ONE rows call: the
--                                                           counts, the acknowledgement, the
--                                                           verdict AND the cells a caller needs.
--   phx_closing_drift_status(text, text)         REPLACED — reads the overview's status. Same
--                                                           columns, same values, ONE snapshot
--                                                           recompute instead of two.
--   crm_contact_master_refresh(boolean)          UNTOUCHED — see the note at the foot of this
--                                                           file: its own 06:56 timeout was already
--                                                           fixed by #6303, and a function-level
--                                                           limit could not have helped it.
--
-- WHY: both of this morning's closing failures were one 8-second statement timeout each, as role
-- `authenticator` through PostgREST (sql_state 57014, production postgres log 2026-10-23 03:36:23
-- and 03:56:25 UTC = 06:36 and 06:56 Cairo).
--
--   * The Needs You board's publication-drift source spends THREE recomputes of
--     phx_closing_publication_snapshot per published line — one for the fingerprint inside
--     phx_closing_drift_status, one for that function's own count, and one more for the per-area
--     cells (loadFactAreaMoves). Measured on production today: phx_closing_drift_status for CNS
--     2026-09 alone is 3,635 ms (77,339 shared buffers) against the 743 ms recorded for the whole
--     set on 2026-10-09. Three lines at three recomputes each is what put one of them past 8 s and
--     ambered four sources on the 06:36 digest. This makes it ONE recompute per line: the counts,
--     the fingerprint and the cells all come off the same array.
--     🔴 It is NOT a widened lane or a raised budget — those are forbidden (portal module memory,
--     "the amber rows were a scheduling defect"). The heavy source is made cheaper instead.
--   * crm_contact_master_refresh is a maintenance RPC the poller runs hourly; it is not a web read,
--     and 121 calls average 1,676 ms with a 5,901 ms worst case, so the 8 s cap on `authenticator`
--     clipped it at random. It timed out at 06:56 inside line 368 — a statement that costs 54 ms
--     by itself, i.e. the cap ran out, the statement was not slow. 🔴 THIS FILE DOES NOT TOUCH IT:
--     a function's own `set statement_timeout` CANNOT RAISE its caller's limit (proved on staging
--     2026-10-23 — a function declaring 10s was cancelled at its caller's 1s), so the only thing
--     that could lift that cap is the role limit, and #6303 lifted it to 5 minutes at 05:37 UTC
--     today. The foot of this file holds the full account.
--
-- ROLLBACK:
--   and re-apply supabase/migrations/20260905130000_closing_drift_acknowledgement.sql, which holds
--   the previous bodies of phx_closing_drift_fingerprint and phx_closing_drift_status. The three
--   NEW functions can be dropped; nothing else references them.
--   Nothing is dropped, renamed or written here, and no number changes: equality of all ten
--   phx_closing_drift_status columns is proved per line and period before and after.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The one computation. Every other function in this file reads ITS array.
--
-- The '(no snapshot)' sentinel is excluded HERE, once, so no caller can forget it: that row says
-- "nothing has ever snapshotted this line and period", which is a state to fix rather than a cell
-- that moved, and letting it through would make it acknowledgeable.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_drift_rows(p_line text, p_period text)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'area_code', d.area_code,
             'product_code', d.product_code,
             'is_direct', d.is_direct,
             'units_delta', d.units_delta,
             'value_delta', d.value_delta
           )),
           '[]'::jsonb)
  from public.phx_closing_publication_drift(p_line, p_period) d
  where d.area_code <> '(no snapshot)';
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The fingerprint FORMULA, lifted out so it exists once.
--
-- 🔴 THE EXPRESSION IS UNCHANGED, DELIBERATELY DOWN TO THE `d.` ALIASES. It carries BOTH deltas,
-- which is the whole point of the fingerprint: a price edit moves value across the SAME cells, so a
-- cell-identity fingerprint would stay matched and hide the restatement (measured on staging
-- 2026-09-05: -558.80 -> -894.08 across the same 49 cells). `jsonb_to_recordset` is what lets the
-- rows be read back under the same names rather than re-spelled over jsonb accessors.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_drift_fingerprint_of(p_rows jsonb)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select md5(coalesce(string_agg(
           d.area_code || '|' || d.product_code || '|' || d.is_direct::text
             || '|' || round(d.units_delta, 6)::text
             || '|' || coalesce(round(d.value_delta, 2)::text, 'null'),
           E'\n' order by d.area_code, d.product_code, d.is_direct), ''))
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
       as d(area_code text, product_code text, is_direct boolean,
            units_delta numeric, value_delta numeric);
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. The public fingerprint, unchanged in behaviour: formula(rows).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_drift_fingerprint(p_line text, p_period text)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select public.phx_closing_drift_fingerprint_of(public.phx_closing_drift_rows(p_line, p_period));
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Everything a caller needs about one line and period, off ONE recompute.
--
-- `cells` is the same array phx_closing_publication_drift would hand back minus the published and
-- current columns no caller reads — the per-area rollup is built from the deltas in TypeScript
-- (src/lib/sales/closing-publication-drift.ts), which is where it already lived, so this file does
-- not become a second implementation of it.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_drift_overview(p_line text, p_period text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_rows        jsonb   := public.phx_closing_drift_rows(p_line, p_period);
  v_fingerprint text    := public.phx_closing_drift_fingerprint_of(v_rows);
  v_cells       integer;
  v_units       numeric;
  v_value       numeric;
  v_ack         public.monthly_closing_drift_acknowledgements;
begin
  select count(*)::integer, coalesce(sum(d.units_delta), 0), sum(d.value_delta)
    into v_cells, v_units, v_value
  from jsonb_to_recordset(v_rows) as d(units_delta numeric, value_delta numeric);

  -- An acknowledgement counts only while it is the SAME drift: matched on the fingerprint, never on
  -- the line and period alone. That match is the blindfold this module exists to avoid.
  select * into v_ack
  from public.monthly_closing_drift_acknowledgements a
  where lower(btrim(a.line)) = lower(btrim(p_line))
    and a.period = p_period
    and a.drift_fingerprint = v_fingerprint
  order by a.acknowledged_at desc
  limit 1;

  return jsonb_build_object(
    'line', p_line,
    'period', p_period,
    'status', jsonb_build_object(
      'drifted_cells',   v_cells,
      'net_units_delta', v_units,
      'net_value_delta', v_value,
      'acknowledged',    v_ack.id is not null,
      'acknowledged_by', v_ack.acknowledged_by,
      'acknowledged_at', v_ack.acknowledged_at,
      'reason',          v_ack.reason,
      'verdict', case
        when v_cells = 0 then 'clean'
        when v_ack.id is not null then 'acknowledged'
        when exists (select 1 from public.monthly_closing_drift_acknowledgements a2
                      where lower(btrim(a2.line)) = lower(btrim(p_line)) and a2.period = p_period)
          then 'CHANGED SINCE IT WAS ACKNOWLEDGED'
        else 'unreviewed'
      end
    ),
    'cells', v_rows
  );
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. The same ten columns as before, now derived from the overview. One recompute, not two.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_drift_status(p_line text, p_period text)
returns table(line text, period text, drifted_cells integer, net_units_delta numeric,
              net_value_delta numeric, acknowledged boolean, acknowledged_by text,
              acknowledged_at timestamp with time zone, reason text, verdict text)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_status jsonb := public.phx_closing_drift_overview(p_line, p_period) -> 'status';
begin
  return query select
    p_line,
    p_period,
    (v_status->>'drifted_cells')::integer,
    (v_status->>'net_units_delta')::numeric,
    (v_status->>'net_value_delta')::numeric,
    (v_status->>'acknowledged')::boolean,
    v_status->>'acknowledged_by',
    (v_status->>'acknowledged_at')::timestamp with time zone,
    v_status->>'reason',
    v_status->>'verdict';
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Grants. anon and authenticated inherit EXECUTE through PUBLIC on a default ACL, so revoking only
-- those two is a no-op — and revoking PUBLIC strips service_role with it, hence the re-grant.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
revoke execute on function public.phx_closing_drift_rows(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_rows(text, text) to service_role;

revoke execute on function public.phx_closing_drift_fingerprint_of(jsonb) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_fingerprint_of(jsonb) to service_role;

revoke execute on function public.phx_closing_drift_fingerprint(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_fingerprint(text, text) to service_role;

revoke execute on function public.phx_closing_drift_overview(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_overview(text, text) to service_role;

revoke execute on function public.phx_closing_drift_status(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_status(text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- NOTHING HERE TOUCHES `crm_contact_master_refresh`, AND THAT IS THE SECOND HALF OF THE FINDING.
--
-- 06:56's contact-master timeout was the same 8-second cap, and it is ALREADY FIXED — by
-- 20261023093000_service_role_statement_timeout_five_minutes (#6303), applied to production at
-- 05:37 UTC today, two hours after the failure. Measured through staging's PostgREST afterwards: an
-- RPC called with the service-role key runs as `service_role` with `statement_timeout=5min`, so
-- PostgREST does apply the impersonated role's own settings. Before that migration `service_role`
-- carried NO override at all, which is why the session fell back to `authenticator`'s 8 s and why
-- both of this morning's cancels are logged under that role.
--
-- 🔴 AND A PER-FUNCTION `set statement_timeout` COULD NOT HAVE SAVED IT — a function's own limit
-- CANNOT RAISE its caller's (staging, same day: a function declaring 10s cancelled at its caller's
-- 1s). This file briefly carried `'60s'` on that refresh, which at best capped a function that
-- already had five minutes and at worst did nothing at all. It was removed and reset on both
-- databases — `proconfig` reads `search_path=public` alone, so it inherits `service_role` again.
-- Give a maintenance RPC headroom at the ROLE, and read `pg_roles.rolconfig` before believing any
-- number here.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

commit;
