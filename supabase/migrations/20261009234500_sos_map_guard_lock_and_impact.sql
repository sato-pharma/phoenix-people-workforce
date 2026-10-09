-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- The mapping guard learns to take a FINAL answer, and to show what rides on one.
--
-- Owner, 2026-10-09, after a district manager found a customer in her monthly closing sheet and
-- gone from the next download: "add the lock button and the money on each hold row".
--
-- 🔴 WHY A LOCK WAS NEEDED AT ALL. Neither button on that screen decided the CUSTOMER:
--
--   Allow      -> sos_map_guard_decide writes `source = after_json->>'source'`, which for an
--                 upload's self-heal is the string the IMPORTER chose: 'sheet-verified'. The move
--                 lands, and the next file that disagrees proposes it again and is held again.
--   Keep as is -> writes NOTHING to source_of_sales_customer_map. The hold is marked refused and
--                 the mapping keeps whatever source and confidence it had, so the same proposal
--                 can return on the next upload.
--
-- The only thing an upload cannot touch is `confidence = 100`: applyCustomerBrickCorrections skips
-- those outright (`skippedOwnerVerified`), so they are never proposed, never held, never moved.
-- 6,961 rows were locked that way on 2026-10-09 - and NOT ONE of the 186 holds pending that night
-- sat on one, including the 42 sitting on his own 2026-09-10 sheet.
--
-- So the lock is a parameter on the decision, not a second screen: p_lock stamps
-- `owner-ruling-<date>-hold<id>` and confidence 100 on the row the hold is about, whichever way he
-- answered. It is the same shape a session has had to write by hand on his word - RM-T / 796 became
-- `owner-ruling-elkhanka-ce2-2026-10-09` at 17:23 Cairo that day - now reachable from the screen.
--
-- THE INNER FUNCTION IS UNTOUCHED. sos_map_guard_decide keeps its three arguments, because docs/
-- and scripts/customer-territory-questions.ts both tell a session to call it by hand with exactly
-- three. Only the wrapper the application calls grows the parameter, and it grows it with a DEFAULT
-- of false, so the 3-argument call in the deployed code keeps resolving while this migration sits
-- ahead of the deploy.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

-- Dropped rather than replaced: `create or replace` with a 4th parameter creates a SECOND function
-- instead, and the existing 3-argument call then fails as "function is not unique".
drop function if exists public.sos_map_guard_decide_and_move_sales(bigint, text, text);

create or replace function public.sos_map_guard_decide_and_move_sales(
  p_hold_id  bigint,
  p_decision text,
  p_actor    text,
  p_lock     boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_hold   public.sos_map_change_holds;
  v_result jsonb;
  v_move   jsonb;
  v_locked boolean := false;
  v_source text;
  v_before jsonb;
begin
  -- Read the hold BEFORE deciding it: sos_map_guard_decide flips its status and, on an approval,
  -- the map row underneath it, so afterwards neither tells us which row to lock.
  select * into v_hold from public.sos_map_change_holds where id = p_hold_id;

  v_result := public.sos_map_guard_decide(p_hold_id, p_decision, p_actor);

  if coalesce((v_result->>'ok')::boolean, false) then
    if p_decision = 'approved' then
      v_move := public.sos_move_brick_sales_after_hold(p_hold_id);
    end if;

    -- The lock is for a CUSTOMER mapping only. A brick or an area hold has no source or confidence
    -- column to stamp, so it reports locked=false rather than pretending.
    if p_lock and v_hold.table_name = 'source_of_sales_customer_map' then
      v_source := 'owner-ruling-' || to_char(now() at time zone 'Africa/Cairo', 'YYYY-MM-DD')
                  || '-hold' || p_hold_id::text;

      select to_jsonb(m) into v_before
      from public.source_of_sales_customer_map m where m.id = v_hold.row_id;

      -- This statement moves NOTHING: brick_id, area_code and region_code are left exactly as the
      -- decision left them. sos_map_guard_customer returns early when neither brick nor area
      -- changes, so the guard neither holds this nor logs it - which is why the log row below is
      -- written by hand. Without it, the one write that makes an answer permanent would be the only
      -- mapping write in the system with no record of itself.
      update public.source_of_sales_customer_map m
      set source     = v_source,
          confidence = 100,
          mapped_by  = coalesce(p_actor, m.mapped_by),
          updated_at = now()
      where m.id = v_hold.row_id;
      v_locked := found;

      if v_locked then
        insert into public.sos_map_change_log
          (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
        select 'source_of_sales_customer_map', m.id, v_hold.entity_key, 'update', 'applied',
               array['you locked this mapping: no upload may move it again'],
               v_before, to_jsonb(m), p_actor
        from public.source_of_sales_customer_map m where m.id = v_hold.row_id;
      end if;
    end if;
  end if;

  return coalesce(v_result, '{}'::jsonb)
         || jsonb_build_object('brickMove', v_move, 'locked', v_locked, 'lockSource', v_source);
end;
$function$;

comment on function public.sos_map_guard_decide_and_move_sales(bigint, text, text, boolean) is
  'Decide one held mapping change. p_lock stamps the row owner-ruling-<date>-hold<id> at confidence 100, which the monthly self-heal skips outright, so the answer is final.';

-- 🔴 THE DROP ALSO DROPPED THIS FUNCTION'S OWN ACL, AND A FRESH FUNCTION IS EXECUTABLE BY PUBLIC.
-- Measured on production minutes after this ran on 2026-10-09: the recreated function read
-- `=X/postgres` and `has_function_privilege('anon', ..., 'EXECUTE')` was TRUE - anon could release a
-- held mapping and move its sales through PostgREST. anon and authenticated inherit EXECUTE through
-- PUBLIC membership, so revoking only those two names is a no-op; and revoking PUBLIC on a default
-- ACL strips service_role with it, which is the only role the app actually calls as. Both halves,
-- every time, or the function is either open to the world or dead to the server.
revoke execute on function public.sos_map_guard_decide_and_move_sales(bigint, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.sos_map_guard_decide_and_move_sales(bigint, text, text, boolean)
  to service_role;

-- ── What rides on a hold ───────────────────────────────────────────────────────────────────────
--
-- Aggregated in the database on purpose. The same reading taken through PostgREST is every matching
-- row of source_of_sales_import_rows for every held customer - tens of thousands of rows crossing
-- the wire so the server can add them up - and this screen loads once per visit.
--
-- The tracked lines are a PARAMETER, never a literal here: ATTRIBUTION_SPLIT_LINES in
-- src/lib/sales/attribution-store-split-net.ts is the one definition of which lines carry money,
-- and Head Office sits outside it by the owner's standing rule. A copy in SQL would be a second
-- definition that nothing keeps in step.
create or replace function public.sos_map_hold_sales_impact(
  p_hold_ids bigint[],
  p_lines    text[]
)
returns table (
  hold_id       bigint,
  period        text,
  tracked_value numeric,
  row_count     bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  select h.id,
         r.invoice_period,
         sum(coalesce(r.value, 0))::numeric,
         count(*)::bigint
  from public.sos_map_change_holds h
  join public.source_of_sales_customer_map m on m.id = h.row_id
  join public.source_of_sales_import_rows r
    on upper(trim(coalesce(r.distributor_code, ''))) = upper(trim(coalesce(m.distributor_code, '')))
   and trim(coalesce(r.client_code, '')) = trim(coalesce(m.customer_code, ''))
  where h.id = any(p_hold_ids)
    and h.table_name = 'source_of_sales_customer_map'
    and r.official_line = any(p_lines)
    -- 'valid', never 'validated'. The other spelling matches nothing and reads as a customer with
    -- no sales at all, which on this screen is the difference between "nothing rides on this" and
    -- thirty thousand pounds.
    and r.validation_state = 'valid'
    and r.invoice_period is not null
  group by h.id, r.invoice_period
$function$;

comment on function public.sos_map_hold_sales_impact(bigint[], text[]) is
  'Tracked sales value per month behind each held customer mapping - what releasing it would re-credit to another area.';

revoke execute on function public.sos_map_hold_sales_impact(bigint[], text[]) from public, anon, authenticated;
grant execute on function public.sos_map_hold_sales_impact(bigint[], text[]) to service_role;

-- ── What the DISTRIBUTOR'S OWN FILE said about this customer ───────────────────────────────────
--
-- Owner, 2026-10-09, while this was being built: "add the column that have the address that came
-- with the distributor ... and there is a distributor that send their bricks ... get the address,
-- the brick, the government. Very important."
--
-- It is the evidence behind the whole hold. The self-heal only ever proposes a move because the
-- file itself resolved the customer somewhere else - by its own brick id, its own territory text
-- or its own address - so the question "is this move right?" is really "does what the distributor
-- filed describe this pharmacy or not?", and until now that text appeared nowhere on the screen.
--
-- GROUPED BY THE FILED VALUES THEMSELVES, never max()-ed into one line. A distributor that filed
-- two different addresses for one code is exactly the case worth seeing - EPDA-Pharmacies code
-- 22199672 is two unrelated pharmacies in two governorates, which is why that hold returns on every
-- upload whatever is clicked - and a max() would hide it behind whichever string sorts last.
create or replace function public.sos_map_hold_distributor_facts(p_hold_ids bigint[])
returns table (
  hold_id          bigint,
  period           text,
  filed_name       text,
  filed_address    text,
  filed_brick_id   text,
  filed_brick_name text,
  filed_area       text,
  filed_region     text,
  rows_filed       bigint,
  last_filed       timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  select h.id,
         r.invoice_period,
         nullif(trim(coalesce(r.client_name, '')), ''),
         nullif(trim(coalesce(r.client_address, '')), ''),
         nullif(trim(coalesce(r.brick_id, '')), ''),
         nullif(trim(coalesce(b.brick_name, '')), ''),
         nullif(trim(coalesce(r.area_name, '')), ''),
         nullif(trim(coalesce(r.region_name, '')), ''),
         count(*)::bigint,
         max(r.created_at)
  from public.sos_map_change_holds h
  join public.source_of_sales_customer_map m on m.id = h.row_id
  join public.source_of_sales_import_rows r
    on upper(trim(coalesce(r.distributor_code, ''))) = upper(trim(coalesce(m.distributor_code, '')))
   and trim(coalesce(r.client_code, '')) = trim(coalesce(m.customer_code, ''))
  left join public.source_of_sales_bricks b
    on upper(trim(coalesce(b.brick_id, ''))) = upper(trim(coalesce(r.brick_id, '')))
  where h.id = any(p_hold_ids)
    and h.table_name = 'source_of_sales_customer_map'
  group by h.id, r.invoice_period, r.client_name, r.client_address, r.brick_id, b.brick_name,
           r.area_name, r.region_name
$function$;

comment on function public.sos_map_hold_distributor_facts(bigint[]) is
  'What each distributor file itself carried for a held customer - name, address, brick, area and governorate as filed, per month and per distinct variant.';

revoke execute on function public.sos_map_hold_distributor_facts(bigint[]) from public, anon, authenticated;
grant execute on function public.sos_map_hold_distributor_facts(bigint[]) to service_role;
