-- WHAT: a customer merge carries the standing of a shared pharmacy link, retires the copy it leaves behind,
-- and refuses a rejected customer as the one that stays (owner, 2026-11-03).
--
-- WHY. Found in review of the merge before anyone had run a real one. Two rows on one pharmacy code is the
-- normal duplicate, and the first version left that link on the retired row, live and with its status:
--   * a validated link stayed behind while the survivor's copy stayed pending, so the survivor could leave
--     the request picker and its moved requests read "not validated" on the approver's line
--   * the live copy kept the retired customer on the Customer Database, the validation report, the vendor
--     count and the daily field-capture nudge to its rep
--   * a rejected survivor had validated links moved onto it, which is what makes a customer requestable
--
-- marketing_customer_merges.moved now also lists which links were switched back on, carried and switched
-- off, with each carried link's status and notes as they stood, because it is what a correction is written from.
--
-- Nothing has called this function yet: it is new, and the screen ships with this file. No row changes here.
--
-- ROLLBACK: re-run the function from 20261103090100_marketing_customer_merge.sql.

create or replace function public.phx_merge_marketing_customers(
  p_survivor_id    uuid,
  p_retired_id     uuid,
  p_reason         text,
  p_actor_hr_id    text,
  p_carry_evidence boolean default false
)
returns jsonb
language plpgsql
set search_path = public
set statement_timeout = '30s'
as $func$
declare
  s marketing_customers%rowtype;
  r marketing_customers%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_carry boolean := coalesce(p_carry_evidence, false);
  v_requests uuid[];
  v_contacts uuid[];
  v_links uuid[];
  v_transfers uuid[];
  v_venues uuid[];
  v_earlier uuid[];
  v_links_left integer;
  v_links_reactivated uuid[];
  v_links_status_carried jsonb;
  v_links_switched_off uuid[];
  v_validation_carried text := null;
  v_note text;
  v_moved jsonb;
begin
  if p_survivor_id is null or p_retired_id is null then
    raise exception 'Both the customer that stays and the customer to retire must be named.';
  end if;
  if p_survivor_id = p_retired_id then
    raise exception 'A customer cannot be merged into itself.';
  end if;
  if v_reason = '' then
    raise exception 'A merge needs a written reason. It is the only record of why two rows were judged one customer.';
  end if;

  -- Both rows, locked in a fixed order so two merges touching the same pair cannot deadlock.
  perform 1 from marketing_customers where id in (p_survivor_id, p_retired_id) order by id for update;
  select * into s from marketing_customers where id = p_survivor_id;
  if not found then raise exception 'The customer that stays does not exist.'; end if;
  select * into r from marketing_customers where id = p_retired_id;
  if not found then raise exception 'The customer to retire does not exist.'; end if;

  if s.merged_into_customer_id is not null then
    raise exception '% was already merged into another customer, so it cannot stay.', s.display_name;
  end if;
  if r.merged_into_customer_id is not null then
    raise exception '% was already merged into another customer.', r.display_name;
  end if;
  if not s.active then raise exception '% is inactive, so it cannot stay.', s.display_name; end if;
  if not r.active then raise exception '% is already inactive.', r.display_name; end if;
  if s.validation_status = 'rejected' then
    raise exception '% was rejected, so it cannot be the customer that stays. Keep the other one.', s.display_name;
  end if;

  if s.line_id is distinct from r.line_id then
    raise exception 'These two are on different lines, and this screen merges only within one line.';
  end if;
  if s.customer_type is distinct from r.customer_type then
    raise exception 'These two are different kinds of customer (% and %).', s.customer_type, r.customer_type;
  end if;
  if s.area_id is distinct from r.area_id then
    raise exception 'These two are in different areas, and this screen merges only within one area.';
  end if;

  if exists (select 1 from marketing_customer_direct_order_transfers where customer_id = p_survivor_id and status = 'transferred')
     and exists (select 1 from marketing_customer_direct_order_transfers where customer_id = p_retired_id and status = 'transferred') then
    raise exception 'Both customers have a live Direct Orders transfer. Revert one of them first.';
  end if;

  if v_carry and not (
    r.evidence_status = 'complete'
    and r.captured_at is not null
    and r.evidence_photo_name is not null
    and s.evidence_status <> 'complete'
  ) then
    raise exception 'Evidence can be carried only from complete evidence onto a customer with none complete.';
  end if;

  with moved as (
    update marketing_requests set customer_id = p_survivor_id where customer_id = p_retired_id returning id
  ) select coalesce(array_agg(id), '{}') into v_requests from moved;

  with moved as (
    update marketing_customer_contacts set customer_id = p_survivor_id, updated_at = now()
    where customer_id = p_retired_id returning id
  ) select coalesce(array_agg(id), '{}') into v_contacts from moved;

  -- A link the survivor already holds cannot move (two unique indexes). If the survivor's copy is
  -- switched off and the retired row's is live, the live answer wins, before anything moves.
  with revived as (
    update marketing_customer_pharmacies kept
    set active = true, updated_at = now(), updated_by_hr_id = p_actor_hr_id
    from marketing_customer_pharmacies gone
    where kept.customer_id = p_survivor_id
      and gone.customer_id = p_retired_id
      and not kept.active
      and gone.active
      and (
        kept.distributor_code_id = gone.distributor_code_id
        or (kept.distributor_code_id is null and gone.distributor_code_id is null and kept.pharmacy_id = gone.pharmacy_id)
      )
    returning kept.id
  ) select coalesce(array_agg(id), '{}') into v_links_reactivated from revived;

  -- The survivor's copy of a shared link takes the retired row's standing when that is higher, under the
  -- customer's own rule: upward only, never over a rejection and never a rejection. The retired link's
  -- notes come too, because they say where the standing came from (a desk validation, a backfill).
  with pairs as (
    select
      kept.id as kept_id,
      kept.validation_status as from_status,
      gone.validation_status as to_status,
      kept.validation_notes as notes_before,
      gone.validation_notes as gone_notes
    from marketing_customer_pharmacies kept
    join marketing_customer_pharmacies gone
      on kept.distributor_code_id = gone.distributor_code_id
      or (kept.distributor_code_id is null and gone.distributor_code_id is null and kept.pharmacy_id = gone.pharmacy_id)
    where kept.customer_id = p_survivor_id
      and gone.customer_id = p_retired_id
      and gone.active
      and array_position(array['pending', 'system_validated', 'sfe_validated', 'admin_approved'], gone.validation_status)
        > array_position(array['pending', 'system_validated', 'sfe_validated', 'admin_approved'], kept.validation_status)
  ),
  carried as (
    update marketing_customer_pharmacies kept
    set validation_status = pairs.to_status,
        validation_notes = concat_ws(
          E'\n',
          nullif(btrim(pairs.notes_before), ''),
          format('Carried by the merge of %s (%s): %s.', r.display_name, r.customer_code, pairs.to_status),
          nullif(btrim(pairs.gone_notes), '')
        ),
        updated_at = now(),
        updated_by_hr_id = p_actor_hr_id
    from pairs
    where kept.id = pairs.kept_id
    returning pairs.kept_id, pairs.from_status, pairs.to_status, pairs.notes_before
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', kept_id, 'from', from_status, 'to', to_status, 'notesBefore', notes_before)), '[]'::jsonb)
  into v_links_status_carried
  from carried;

  with moved as (
    update marketing_customer_pharmacies link
    set customer_id = p_survivor_id, updated_at = now(), updated_by_hr_id = p_actor_hr_id
    where link.customer_id = p_retired_id
      and not exists (
        select 1 from marketing_customer_pharmacies kept
        where kept.customer_id = p_survivor_id
          and (
            kept.distributor_code_id = link.distributor_code_id
            or (kept.distributor_code_id is null and link.distributor_code_id is null and kept.pharmacy_id = link.pharmacy_id)
          )
      )
    returning link.id
  ) select coalesce(array_agg(id), '{}') into v_links from moved;

  select count(*) into v_links_left from marketing_customer_pharmacies where customer_id = p_retired_id;

  -- What is left is what the survivor already holds. Live, it would keep the retired customer on the
  -- Customer Database, the validation report, the vendor count and the daily field-capture nudge.
  with switched as (
    update marketing_customer_pharmacies
    set active = false, updated_at = now(), updated_by_hr_id = p_actor_hr_id
    where customer_id = p_retired_id and active
    returning id
  ) select coalesce(array_agg(id), '{}') into v_links_switched_off from switched;

  with moved as (
    update marketing_customer_direct_order_transfers set customer_id = p_survivor_id
    where customer_id = p_retired_id returning id
  ) select coalesce(array_agg(id), '{}') into v_transfers from moved;

  with moved as (
    update marketing_pharmacy_direct_order_venues set customer_id = p_survivor_id
    where customer_id = p_retired_id returning marketing_pharmacy_id
  ) select coalesce(array_agg(marketing_pharmacy_id), '{}') into v_venues from moved;

  -- A customer merged into the retired row earlier now points at the row that stays.
  with moved as (
    update marketing_customers set merged_into_customer_id = p_survivor_id
    where merged_into_customer_id = p_retired_id returning id
  ) select coalesce(array_agg(id), '{}') into v_earlier from moved;

  -- The validation, upward only and never over a rejection.
  if s.validation_status in ('pending', 'system_validated') and r.validation_status = 'sfe_validated' then
    v_validation_carried := 'sfe_validated';
  elsif s.validation_status = 'pending' and r.validation_status = 'system_validated'
        and (s.evidence_status = 'complete' or v_carry) then
    v_validation_carried := 'system_validated';
  end if;
  if v_validation_carried is not null then
    v_note := format(
      'Carried by the merge of %s (%s): %s, originally on %s by %s.',
      r.display_name, r.customer_code, r.validation_status,
      coalesce(to_char(r.validated_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI'), 'no recorded time'),
      coalesce(r.validated_by_hr_id, 'no recorded person')
    );
  end if;

  update marketing_customers set
    captured_address = case when v_carry then r.captured_address else captured_address end,
    captured_latitude = case when v_carry then r.captured_latitude else captured_latitude end,
    captured_longitude = case when v_carry then r.captured_longitude else captured_longitude end,
    captured_accuracy_meters = case when v_carry then r.captured_accuracy_meters else captured_accuracy_meters end,
    captured_at = case when v_carry then r.captured_at else captured_at end,
    evidence_photo_name = case when v_carry then r.evidence_photo_name else evidence_photo_name end,
    evidence_photo_captured_at = case when v_carry then r.evidence_photo_captured_at else evidence_photo_captured_at end,
    evidence_has_timestamp = case when v_carry then r.evidence_has_timestamp else evidence_has_timestamp end,
    evidence_status = case when v_carry then r.evidence_status else evidence_status end,
    extracted_area_name = case when v_carry then r.extracted_area_name else extracted_area_name end,
    extracted_governorate_name = case when v_carry then r.extracted_governorate_name else extracted_governorate_name end,
    validation_status = coalesce(v_validation_carried, validation_status),
    validated_by_hr_id = case
      when v_validation_carried = 'sfe_validated' then p_actor_hr_id
      when v_validation_carried = 'system_validated' then null
      else validated_by_hr_id
    end,
    validated_at = case when v_validation_carried is not null then now() else validated_at end,
    validation_notes = case
      when v_validation_carried is not null then concat_ws(E'\n', nullif(btrim(validation_notes), ''), v_note)
      else validation_notes
    end,
    owner_hr_id = coalesce(owner_hr_id, r.owner_hr_id),
    manager_hr_id = coalesce(manager_hr_id, r.manager_hr_id),
    region_name = coalesce(region_name, r.region_name),
    -- The five doctor-list columns travel together: a survivor with a matched doctor keeps its own.
    phoenix_crm_customer_id = coalesce(phoenix_crm_customer_id, r.phoenix_crm_customer_id),
    crm_list_status = case when phoenix_crm_customer_id is null and r.phoenix_crm_customer_id is not null then r.crm_list_status else coalesce(crm_list_status, r.crm_list_status) end,
    chosen_area_seat_id = case when phoenix_crm_customer_id is null and r.phoenix_crm_customer_id is not null then r.chosen_area_seat_id else coalesce(chosen_area_seat_id, r.chosen_area_seat_id) end,
    chosen_area_name = case when phoenix_crm_customer_id is null and r.phoenix_crm_customer_id is not null then r.chosen_area_name else coalesce(chosen_area_name, r.chosen_area_name) end,
    crm_list_source = case when phoenix_crm_customer_id is null and r.phoenix_crm_customer_id is not null then r.crm_list_source else coalesce(crm_list_source, r.crm_list_source) end,
    updated_at = now(),
    updated_by_hr_id = p_actor_hr_id
  where id = p_survivor_id;

  update marketing_customers set
    active = false,
    merged_into_customer_id = p_survivor_id,
    merged_at = now(),
    merged_by_hr_id = p_actor_hr_id,
    updated_at = now(),
    updated_by_hr_id = p_actor_hr_id
  where id = p_retired_id;

  v_moved := jsonb_build_object(
    'requests', to_jsonb(v_requests),
    'contacts', to_jsonb(v_contacts),
    'links', to_jsonb(v_links),
    'transfers', to_jsonb(v_transfers),
    'venues', to_jsonb(v_venues),
    'earlierMerges', to_jsonb(v_earlier),
    'linksLeftOnRetired', v_links_left,
    'linksReactivated', to_jsonb(v_links_reactivated),
    'linksStatusCarried', v_links_status_carried,
    'linksSwitchedOff', to_jsonb(v_links_switched_off),
    'validationCarried', v_validation_carried
  );

  insert into marketing_customer_merges (
    survivor_customer_id, retired_customer_id, reason, evidence_carried, moved,
    survivor_before, retired_before, merged_by_hr_id
  ) values (
    p_survivor_id, p_retired_id, v_reason, v_carry, v_moved,
    to_jsonb(s), to_jsonb(r), p_actor_hr_id
  );

  return jsonb_build_object(
    'requestsMoved', coalesce(array_length(v_requests, 1), 0),
    'contactsMoved', coalesce(array_length(v_contacts, 1), 0),
    'linksMoved', coalesce(array_length(v_links, 1), 0),
    'linksLeftOnRetired', v_links_left,
    'linksReactivated', coalesce(array_length(v_links_reactivated, 1), 0),
    'linksStatusCarried', jsonb_array_length(v_links_status_carried),
    'transfersMoved', coalesce(array_length(v_transfers, 1), 0),
    'venuesMoved', coalesce(array_length(v_venues, 1), 0),
    'validationCarried', v_validation_carried,
    'evidenceCarried', v_carry
  );
end;
$func$;

comment on function public.phx_merge_marketing_customers(uuid, uuid, text, text, boolean) is
  'Folds one marketing customer into another in one transaction. Refusals raise P0001 with a sentence a '
  'person can read. Identity is the caller''s judgement, never guessed from a name. Server-only.';

revoke all on function public.phx_merge_marketing_customers(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.phx_merge_marketing_customers(uuid, uuid, text, text, boolean) to service_role;
