-- Approving a held brick move on the Mapping guard moves that pharmacy's open-month sales in the SAME
-- transaction as the approval.
--
-- 20260918150000 left this as two calls from the app: sos_map_guard_decide, then
-- sos_move_brick_sales_after_hold. If the second call failed (a dropped connection, a timeout), the
-- approval stood and the pharmacy's sales stayed on the old brick, crediting the old area, with
-- nothing left to move them: the sales move runs only on an approval, and an approval cannot be
-- repeated. One function doing both means the approval and its sales move land together or not at
-- all (owner decision 2026-09-18: "Approving one there also moves its unlocked-month sales").
--
-- Nothing else changes. A refusal, and an approval of anything that is not a brick move, return
-- exactly what sos_map_guard_decide returns, with brickMove null. The function is called directly by
-- the app, so its own 120-second limit applies to the whole decision (a nested function's limit
-- would not).

create or replace function public.sos_map_guard_decide_and_move_sales(
  p_hold_id  bigint,
  p_decision text,
  p_actor    text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_result jsonb;
  v_move   jsonb;
begin
  v_result := public.sos_map_guard_decide(p_hold_id, p_decision, p_actor);
  if p_decision = 'approved' and coalesce((v_result->>'ok')::boolean, false) then
    v_move := public.sos_move_brick_sales_after_hold(p_hold_id);
  end if;
  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object('brickMove', v_move);
end;
$function$;

revoke execute on function public.sos_map_guard_decide_and_move_sales(bigint, text, text) from public, anon, authenticated;
grant execute on function public.sos_map_guard_decide_and_move_sales(bigint, text, text) to service_role;
