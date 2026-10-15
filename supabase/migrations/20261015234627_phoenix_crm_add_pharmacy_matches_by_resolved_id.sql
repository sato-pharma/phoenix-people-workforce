-- phoenix_crm_add_pharmacy_matches_by_resolved_id
--
-- WHAT THIS CHANGES: phoenix_crm_add_pharmacy(p jsonb) takes one new optional key,
-- `existing_customer_id`. When the caller sends it, the function trusts that id (after
-- checking it really is this seat's, this world's, this pharmacy, not dropped) instead of
-- re-deriving "is this already on his list" from the name a second time. When it is absent,
-- or does not check out, the function falls back to exactly the name search it has always run
-- — so an older client, or a caller that genuinely has no match in hand, is unaffected.
--
-- WHY: Add a pharmacy already matches the typed name against the rep's list in TypeScript,
-- Arabic-aware (`matchAddedPharmacy` / `pharmacyNameKey` — tatweel and harakat stripped, alef
-- and ya forms unified, ة/ؤ/ئ folded, "صيدلية"/"ص"/"pharmacy" dropped as a stop word). This
-- function's OWN existing-row lookup never did any of that — only
-- `lower(btrim(regexp_replace(name, '\s+',' ','g')))` — so it answered "no match" for any pair
-- that differs by more than case and whitespace. That was invisible as long as the add carried
-- no phone and no pin: the TypeScript layer's own "existing, nothing captured" branch returns
-- before this function is ever called. The moment a rep ALSO captures the pharmacy's pin or
-- phone on a match TypeScript found correctly, the add proceeds to this function anyway (to
-- file what he captured), and its weaker check reads "طاهر رمضان" against the list's own
-- "صيدلية طاهر رمضان" as two different pharmacies and inserts a second row.
--
-- Measured on production 2026-10-15: Mostafa Galal (seat SEAT-PED-REP-GZ1) added a pin to nine
-- pharmacies already on his list — each one typed WITHOUT the "صيدلية" word the list's own
-- spelling carries — and got nine new `pending` rows instead of nine pins filed on the
-- pharmacies he actually meant.
--
-- ROLLBACK: re-apply the prior body (drop the `existing_customer_id` branch) — the signature
-- is unchanged, so no caller needs to change either way. Nothing is dropped or deleted here.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration changes only the function body; it writes no rows and is not a bulk or
-- destructive change (no owner announcement needed before applying it).

begin;

create or replace function public.phoenix_crm_add_pharmacy(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_name text := nullif(btrim(regexp_replace(coalesce(p ->> 'name', ''), '\s+', ' ', 'g')), '');
  v_from text := coalesce(p ->> 'from', 'list');
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
  v_pin jsonb := case when jsonb_typeof(p -> 'pin') = 'object' then p -> 'pin' else null end;
  -- The pharmacy TypeScript's own Arabic-aware match already resolved, when it sent one. Tried
  -- FIRST, under the same seat/world lock; the name search below is the fallback, not replaced.
  v_resolved_id uuid;
  v_existing public.phoenix_crm_customers;
  v_added public.phoenix_crm_customers;
begin
  if v_seat is null or v_line is null or v_actor is null or v_name is null
    or char_length(v_name) > 120
    or v_from not in ('list', 'visit') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phoenix_crm:bad_phone';
  end if;
  if v_pin is not null and (v_pin -> 'lat') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  begin
    v_resolved_id := nullif(trim(coalesce(p ->> 'existing_customer_id', '')), '')::uuid;
  exception when invalid_text_representation then
    v_resolved_id := null;
  end;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm_add_pharmacy|' || v_seat || '|' || v_is_test::text));

  if v_resolved_id is not null then
    select c.* into v_existing
    from public.phoenix_crm_customers c
    where c.id = v_resolved_id
      and c.seat_id = v_seat
      and c.is_test = v_is_test
      and c.list_type = 'Pharmacy'
      and c.status in ('active', 'pending', 'outside');
  end if;

  if v_existing.id is null then
    select c.* into v_existing
    from public.phoenix_crm_customers c
    where c.seat_id = v_seat
      and c.is_test = v_is_test
      and c.list_type = 'Pharmacy'
      and c.status in ('active', 'pending', 'outside')
      and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(v_name)
    order by (c.status = 'active') desc, c.id
    limit 1;
  end if;

  if v_existing.id is not null then
    if (v_phone is not null and v_existing.phone is null) or (v_pin is not null and v_existing.pharmacy_pin_lat is null) then
      update public.phoenix_crm_customers c
      set phone = case when v_phone is not null and c.phone is null then v_phone else c.phone end,
          pharmacy_pin_lat = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'lat')::double precision else c.pharmacy_pin_lat end,
          pharmacy_pin_lon = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'lon')::double precision else c.pharmacy_pin_lon end,
          pharmacy_pin_accuracy_meters = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'accuracy_meters')::numeric else c.pharmacy_pin_accuracy_meters end,
          pharmacy_pin_captured_at = case when v_pin is not null and c.pharmacy_pin_lat is null then coalesce((v_pin ->> 'captured_at')::timestamptz, now()) else c.pharmacy_pin_captured_at end,
          pharmacy_pin_captured_by_hr_id = case when v_pin is not null and c.pharmacy_pin_lat is null then v_actor else c.pharmacy_pin_captured_by_hr_id end,
          pharmacy_pin_address = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'address', 400) else c.pharmacy_pin_address end,
          pharmacy_pin_governorate = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'governorate', 120) else c.pharmacy_pin_governorate end,
          pharmacy_pin_area_code = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'area_code', 40) else c.pharmacy_pin_area_code end,
          pharmacy_pin_area_name = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'area_name', 120) else c.pharmacy_pin_area_name end,
          pharmacy_pin_brick_id = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'brick_id', 40) else c.pharmacy_pin_brick_id end,
          pharmacy_pin_brick_name = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'brick_name', 120) else c.pharmacy_pin_brick_name end,
          pharmacy_pin_brick_distance_km = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'brick_distance_km')::numeric else c.pharmacy_pin_brick_distance_km end,
          pharmacy_pin_brick_lookup = case when v_pin is not null and c.pharmacy_pin_lat is null then v_pin ->> 'brick_lookup' else c.pharmacy_pin_brick_lookup end,
          updated_at = now()
      where c.id = v_existing.id
      returning c.* into v_existing;
    end if;
    return jsonb_build_object('customer_id', v_existing.id, 'customer_name', v_existing.name, 'created', false);
  end if;

  insert into public.phoenix_crm_customers (
    seat_id, line_code, list_type, name, origin, status, created_by_hr_id, is_test, intake_note, phone,
    pharmacy_pin_lat, pharmacy_pin_lon, pharmacy_pin_accuracy_meters, pharmacy_pin_captured_at,
    pharmacy_pin_captured_by_hr_id, pharmacy_pin_address, pharmacy_pin_governorate,
    pharmacy_pin_area_code, pharmacy_pin_area_name, pharmacy_pin_brick_id, pharmacy_pin_brick_name,
    pharmacy_pin_brick_distance_km, pharmacy_pin_brick_lookup
  )
  values (
    v_seat, v_line, 'Pharmacy', v_name, 'new', 'pending', v_actor, v_is_test,
    case when v_from = 'visit' then 'Added by the rep on Pharmacy visit.' else 'Added by the rep on the List.' end,
    v_phone,
    (v_pin ->> 'lat')::double precision,
    (v_pin ->> 'lon')::double precision,
    (v_pin ->> 'accuracy_meters')::numeric,
    case when v_pin is null then null else coalesce((v_pin ->> 'captured_at')::timestamptz, now()) end,
    case when v_pin is null then null else v_actor end,
    left(v_pin ->> 'address', 400),
    left(v_pin ->> 'governorate', 120),
    left(v_pin ->> 'area_code', 40),
    left(v_pin ->> 'area_name', 120),
    left(v_pin ->> 'brick_id', 40),
    left(v_pin ->> 'brick_name', 120),
    (v_pin ->> 'brick_distance_km')::numeric,
    v_pin ->> 'brick_lookup'
  )
  returning * into v_added;

  return jsonb_build_object('customer_id', v_added.id, 'customer_name', v_added.name, 'created', true);
end;
$function$;

revoke execute on function public.phoenix_crm_add_pharmacy(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_add_pharmacy(jsonb) to service_role;

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20261015234627 was minted to sort after every migration already on main.
