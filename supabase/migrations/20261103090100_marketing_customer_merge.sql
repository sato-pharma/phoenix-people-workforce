-- WHAT: merge one marketing customer into another, atomically, from a screen (owner, 2026-11-03).
--
-- WHY. Hand merges on 21 and 22 August retired duplicates by SQL and left the three merge columns empty,
-- so nothing records what they moved. The venue merge moves its child tables one call at a time; this one
-- moves six tables and two kinds of state, so it is one transaction: it all lands or none of it does.
--
-- THE RULES IT ENFORCES, whatever the caller sends:
--   * both rows active and not already merged, and never a row into itself
--   * same line, same customer type and same area. A cross-line pair was merged by hand on 21 August on
--     the owner's word; refused here until he says otherwise, and widening is this one guard.
--   * never two live Direct Orders transfers (one is allowed per customer, by a unique index)
--   * a conflicting pharmacy link stays on the retired row, because the survivor already has that link
--   * a request's cost, status and dates are not touched: only its customer_id moves. The request trigger
--     logs status and cost changes only, so the move writes no request event, and the record of it is
--     marketing_customer_merges.moved, which lists every id.
--   * evidence is never carried unless asked for, and only from complete evidence onto a survivor that
--     has none complete. Field evidence is a photo of one place, so a person says it is the same place.
--   * a validation carries only upward and never over a rejection, is stamped NOW by the person merging
--     with the original time and validator in the note, and is never backdated.
--
-- marketing_customer_list_checks rows stay on the retired customer: every reader drops a merged customer.
-- marketing_roi_customer_facts is rebuilt hourly by phx_refresh_marketing_roi_facts, by period, so the
-- moved requests carry the figures to the survivor within the hour.
--
-- marketing_customer_merges holds both rows as they stood and every moved id, because there is no undo
-- screen: it is what a correction would be written from.
--
-- ROLLBACK: drop the function and the table. Merges already made stay until corrected from that table.

create table if not exists public.marketing_customer_merges (
  id                   uuid primary key default gen_random_uuid(),
  survivor_customer_id uuid not null references public.marketing_customers(id),
  retired_customer_id  uuid not null unique references public.marketing_customers(id),
  reason               text not null check (btrim(reason) <> ''),
  evidence_carried     boolean not null default false,
  moved                jsonb not null,
  survivor_before      jsonb not null,
  retired_before       jsonb not null,
  merged_by_hr_id      text references public.employees(hr_id) on update cascade on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists marketing_customer_merges_survivor_idx
  on public.marketing_customer_merges (survivor_customer_id);
create index if not exists marketing_customer_merges_merged_by_idx
  on public.marketing_customer_merges (merged_by_hr_id);

alter table public.marketing_customer_merges enable row level security;
revoke all on public.marketing_customer_merges from public, anon, authenticated;
grant all on public.marketing_customer_merges to service_role;

comment on table public.marketing_customer_merges is
  'One row per customer merge: both rows as they stood and every id that moved. Written only by '
  'phx_merge_marketing_customers. There is no undo screen; a correction is written from this.';

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
  v_links_reactivated integer;
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
  ) select count(*) into v_links_reactivated from revived;

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
    'linksReactivated', v_links_reactivated,
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
    'linksReactivated', v_links_reactivated,
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

-- The merge screen's one read: every mergeable customer with what a person needs to judge a pair.
create or replace function public.phx_marketing_customer_merge_options()
returns table (
  id                 uuid,
  customer_code      text,
  display_name       text,
  normalized_name    text,
  customer_type      text,
  line_name          text,
  area_name          text,
  owner_name         text,
  evidence_status    text,
  evidence_complete  boolean,
  validation_status  text,
  requests           bigint,
  contacts           bigint,
  links              bigint,
  live_transfer      boolean
)
language sql
stable
set search_path = public
set statement_timeout = '30s'
as $func$
  select
    c.id,
    c.customer_code,
    c.display_name,
    c.normalized_name,
    c.customer_type,
    l.name,
    a.name,
    e.full_name,
    c.evidence_status,
    (c.evidence_status = 'complete' and c.captured_at is not null and c.evidence_photo_name is not null),
    c.validation_status,
    (select count(*) from marketing_requests q where q.customer_id = c.id),
    (select count(*) from marketing_customer_contacts k where k.customer_id = c.id),
    (select count(*) from marketing_customer_pharmacies p where p.customer_id = c.id),
    exists (select 1 from marketing_customer_direct_order_transfers t where t.customer_id = c.id and t.status = 'transferred')
  from marketing_customers c
  left join lines l on l.id = c.line_id
  left join areas a on a.id = c.area_id
  left join employees e on e.hr_id = c.owner_hr_id
  where c.active and c.merged_into_customer_id is null
  order by c.display_name;
$func$;

revoke all on function public.phx_marketing_customer_merge_options() from public, anon, authenticated;
grant execute on function public.phx_marketing_customer_merge_options() to service_role;
