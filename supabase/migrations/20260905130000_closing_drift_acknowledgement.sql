-- An acknowledged drift stays acknowledged only while it is the SAME drift.
--
-- `phx_closing_publication_drift` (added 2026-09-05) reports 245 drifted cells on CNS 2026-07.
-- That reading is CORRECT and it is not a defect: it is the deliberate CNS-July re-stamp, net units
-- delta 0.00 with 2,858 units re-attributed between cells and the line total identical on both
-- sides. Anti Infective and Pedia are clean.
--
-- Left alone, that 245 sits on the screen for ever with nothing saying it is expected. The first
-- real reading the detector ever gives therefore looks like a live problem on a published month —
-- at 4am, to somebody who was not here when it was decided. A detector whose only output is a known
-- false alarm gets ignored, and then it is not a detector at all.
--
-- ── WHY THIS IS FINGERPRINTED, AND WHY THAT IS THE WHOLE DESIGN ──────────────────────────────
--
-- The obvious shape is a row saying "CNS 2026-07 is acknowledged". That would be a BLINDFOLD, not
-- an acknowledgement: every future price edit, re-stamp or import repair on that line and period
-- would be silently absorbed by a note somebody wrote in September. The one thing this module
-- exists to catch would become the one thing it cannot see, and nothing would look wrong.
--
-- So an acknowledgement stores a FINGERPRINT of the exact drift that was acknowledged — every
-- drifted cell with its two deltas, ordered, hashed. If the drift changes in any way, the
-- fingerprint no longer matches and the row goes straight back to reporting as unacknowledged.
-- Acknowledging cannot hide anything except the precise thing a person looked at and accepted.
--
-- The fingerprint deliberately includes the DELTAS, not just which cells drifted: a price edit that
-- moves the value on the same 245 cells must break the match, and it does.

create table if not exists public.monthly_closing_drift_acknowledgements (
  id                uuid primary key default gen_random_uuid(),
  line              text        not null,
  period            text        not null,
  drift_fingerprint text        not null,
  drifted_cells     integer     not null,
  net_units_delta   numeric     not null,
  net_value_delta   numeric,
  reason            text        not null,
  acknowledged_by   text        not null,
  acknowledged_at   timestamptz not null default now()
);

comment on table public.monthly_closing_drift_acknowledgements is
  'A person looked at a specific closing drift and accepted it. Scoped by fingerprint, never by line/period alone: if the drift changes the acknowledgement stops applying, so this can never hide a NEW restatement.';

comment on column public.monthly_closing_drift_acknowledgements.drift_fingerprint is
  'md5 over every drifted cell and BOTH its deltas, ordered. Includes the deltas on purpose: a price edit that moves value on the same cells must break the match. Proven on staging 2026-09-05 — a second price move on the SAME 49 cells flipped the verdict to CHANGED SINCE IT WAS ACKNOWLEDGED.';

create index if not exists monthly_closing_drift_ack_line_period_idx
  on public.monthly_closing_drift_acknowledgements (lower(btrim(line)), period, acknowledged_at desc);

-- RLS on with no `authenticated` grant, which is the norm for this schema: every reader here is the
-- service role. Nothing in the app reaches this table directly.
alter table public.monthly_closing_drift_acknowledgements enable row level security;

-- ── the fingerprint of the drift as it stands right now ──────────────────────────────────────
create or replace function public.phx_closing_drift_fingerprint(p_line text, p_period text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select md5(coalesce(string_agg(
           d.area_code || '|' || d.product_code || '|' || d.is_direct::text
             || '|' || round(d.units_delta, 6)::text
             || '|' || coalesce(round(d.value_delta, 2)::text, 'null'),
           E'\n' order by d.area_code, d.product_code, d.is_direct), ''))
  from public.phx_closing_publication_drift(p_line, p_period) d
  -- The sentinel row is not a drifted cell; hashing it would make "nothing has ever snapshotted
  -- this" acknowledgeable, which is a state to fix rather than accept.
  where d.area_code <> '(no snapshot)';
$function$;

-- ── the status a person actually reads ───────────────────────────────────────────────────────
create or replace function public.phx_closing_drift_status(p_line text, p_period text)
returns table (
  line             text,
  period           text,
  drifted_cells    integer,
  net_units_delta  numeric,
  net_value_delta  numeric,
  acknowledged     boolean,
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  reason           text,
  verdict          text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_fingerprint text := public.phx_closing_drift_fingerprint(p_line, p_period);
  v_cells   integer;
  v_units   numeric;
  v_value   numeric;
  v_ack     public.monthly_closing_drift_acknowledgements;
begin
  select count(*)::integer, coalesce(sum(d.units_delta), 0), sum(d.value_delta)
    into v_cells, v_units, v_value
  from public.phx_closing_publication_drift(p_line, p_period) d
  where d.area_code <> '(no snapshot)';

  -- Matched on the FINGERPRINT, so an acknowledgement of a different drift simply does not apply.
  select * into v_ack
  from public.monthly_closing_drift_acknowledgements a
  where lower(btrim(a.line)) = lower(btrim(p_line))
    and a.period = p_period
    and a.drift_fingerprint = v_fingerprint
  order by a.acknowledged_at desc
  limit 1;

  return query select
    p_line,
    p_period,
    v_cells,
    v_units,
    v_value,
    v_ack.id is not null,
    v_ack.acknowledged_by,
    v_ack.acknowledged_at,
    v_ack.reason,
    case
      when v_cells = 0 then 'clean'
      when v_ack.id is not null then 'acknowledged'
      -- Named apart from a first sighting, because this is the shape that matters: a drift that
      -- WAS accepted and has since moved is a new restatement on top of an accepted one, and
      -- reading it as a fresh alarm loses that it was ever looked at.
      when exists (select 1 from public.monthly_closing_drift_acknowledgements a2
                    where lower(btrim(a2.line)) = lower(btrim(p_line)) and a2.period = p_period)
        then 'CHANGED SINCE IT WAS ACKNOWLEDGED'
      else 'unreviewed'
    end;
end;
$function$;

-- ── recording one ────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_acknowledge_closing_drift(
  p_line text, p_period text, p_actor text, p_reason text
)
returns public.monthly_closing_drift_acknowledgements
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_fingerprint text := public.phx_closing_drift_fingerprint(p_line, p_period);
  v_cells integer;
  v_units numeric;
  v_value numeric;
  v_row   public.monthly_closing_drift_acknowledgements;
begin
  if btrim(coalesce(p_actor, '')) = '' then
    raise exception 'An acknowledgement must name who made it.';
  end if;
  -- A reason is required because the whole value of this row is to a person who was not there.
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'An acknowledgement must say WHY the drift is expected.';
  end if;

  select count(*)::integer, coalesce(sum(d.units_delta), 0), sum(d.value_delta)
    into v_cells, v_units, v_value
  from public.phx_closing_publication_drift(p_line, p_period) d
  where d.area_code <> '(no snapshot)';

  if v_cells = 0 then
    raise exception 'There is no drift on % % to acknowledge.', p_line, p_period;
  end if;

  insert into public.monthly_closing_drift_acknowledgements
    (line, period, drift_fingerprint, drifted_cells, net_units_delta, net_value_delta, reason, acknowledged_by)
  values (p_line, p_period, v_fingerprint, v_cells, v_units, v_value, btrim(p_reason), btrim(p_actor))
  returning * into v_row;

  return v_row;
end;
$function$;

-- ── grants: these read the whole fact rollup as definer ──────────────────────────────────────
revoke execute on function public.phx_closing_drift_fingerprint(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_fingerprint(text, text) to service_role;

revoke execute on function public.phx_closing_drift_status(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_drift_status(text, text) to service_role;

revoke execute on function public.phx_acknowledge_closing_drift(text, text, text, text) from public, anon, authenticated;
grant  execute on function public.phx_acknowledge_closing_drift(text, text, text, text) to service_role;

revoke all on public.monthly_closing_drift_acknowledgements from public, anon, authenticated;
grant select, insert on public.monthly_closing_drift_acknowledgements to service_role;
