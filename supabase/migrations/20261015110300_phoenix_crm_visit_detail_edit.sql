-- phoenix_crm_visit_detail_edit
--
-- WHAT THIS CHANGES (owner, 2026-10-15):
--   A MEDICAL REP MAY COME BACK TO HIS OWN SAVED VISIT AND FILL IN ITS DETAIL. He walks from door to
--   door and has no time between two of them to answer the company's full report, so the visit is
--   logged in one tap — the location and the time, which is what must be captured at the door — and
--   the soft detail is written afterwards.
--
--   1. phoenix_crm_visits gains three columns:
--      · detail_comment        — a SECOND, longer account of the call. The comment he typed or spoke at
--                                the door is kept exactly as it was and is never editable here.
--      · detail_edited_at      — when he last changed the detail, and
--      · detail_edited_by_hr_id  who changed it. Every screen that shows the visit prints
--                                "Edited · <Cairo date and time>" from these.
--   2. phoenix_crm_edit_visit_detail(p jsonb): the rep's own edit. It changes SIX things and nothing
--      else — the detailed comment, the objection and its note, the next step and its day, what he
--      left behind, the pharmacy stock answers, and a pharmacy name the visit does not yet carry.
--
-- 🔴 WHAT IT NEVER TOUCHES IS THE EVIDENCE AND THE OWNER'S TWO SETTLED RULINGS: the customer, the day,
--   the time, the location, the photo and the voice note (what every figure and integrity check
--   reads); AM/PM, which is copied from the customer's own list and was never a field the rep chose;
--   single/double/chain and who was on it; and the products discussed. Those three remain the SUPER
--   ADMIN's to correct through phoenix_crm_admin_edit_visit (owner, 2026-10-06) — this is a second,
--   rep-scoped door beside it, never a widening of it.
--
-- 🔴 THE PHARMACY NAME IS ADD-ONLY (owner, 2026-10-15, asked directly: "Add a name, never change
--   one"). Naming a pharmacy FILES A REAL VISIT to that pharmacy, so changing or clearing a name
--   would delete a logged visit, and a visit is evidence. A visit that already carries a name, and a
--   visit AT a pharmacy (where the pharmacy is the customer), both refuse the field.
--
-- 🔴 NOTHING IS LOST. Each save keeps what the six things said before in phoenix_crm_visit_edits —
--   the SAME table the Super Admin's correction uses (20261006234611) — because production has no
--   point-in-time recovery. The copy is inserted BEFORE the update, and a save with nothing different
--   writes no row at all and answers changed = false.
--
-- 🔴 AND IT NOTIFIES NOBODY, in either direction (Golden Rule #1): a rep completing his own report is
--   not a check on him, and his managers simply read the visit as it now stands.
--
-- WHY: the optional fields were measured empty on production — next_step on 1 visit of 332, objection
--   on 2, samples 19, stock 77 — so commitments.ts, call-prep.ts, missing-stock.ts, samples-report.ts
--   and "What the field heard" all run on nothing. The rep had no door to fill them in through: the
--   only edit path in the module was the Super Admin's, on somebody else's visit.
--
-- WHO MAY CALL IT: the service role only (revoked from public, anon and authenticated below). The
--   TypeScript service admits the territory's own rep — territoryForRepWrite in
--   src/lib/phoenix-crm/server/access.ts, which refuses the Super Admin by name — and this function
--   re-checks that the visit's own rep_hr_id is the actor.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_edit_visit_detail(jsonb);
--   The three columns and the audit rows stay: they are the only copy of what an edit replaced.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This adds three nullable columns and one function, and writes no rows.

begin;
set local lock_timeout = '5s';

-- ── 1. The detailed comment, and when the detail was last changed ───────────────────────────────────

alter table public.phoenix_crm_visits
  add column if not exists detail_comment text,
  add column if not exists detail_edited_at timestamptz,
  add column if not exists detail_edited_by_hr_id text;

alter table public.phoenix_crm_visits
  drop constraint if exists phoenix_crm_visits_detail_comment;

-- Twice the door comment's 1,000, because this is the long account the door had no time for.
alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_detail_comment
  check (detail_comment is null or char_length(detail_comment) <= 2000);

comment on column public.phoenix_crm_visits.detail_comment is
  'The rep''s SECOND, longer account of the visit, written afterwards (owner, 2026-10-15). The door '
  'comment stays in `comment`, unchanged and not editable by him: "the comment which they wrote while '
  'they were doing the visit, leave it and make them able to add another detailed comment".';

comment on column public.phoenix_crm_visits.detail_edited_at is
  'When the REP last changed this visit''s detail (owner, 2026-10-15: "anything edited, it should '
  'appear that this is edited in the date and time"). Written only by phoenix_crm_edit_visit_detail, '
  'never by phoenix_crm_admin_edit_visit — the Super Admin''s correction is told to nobody, so a '
  'shared stamp would show the rep that his visit had been corrected.';

comment on column public.phoenix_crm_visits.detail_edited_by_hr_id is
  'Who last changed the detail. Always the visit''s own rep today: only he may edit it (owner, 2026-10-15).';

-- ── 2. The rep's own edit ───────────────────────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_edit_visit_detail(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  -- The long account written afterwards. Empty clears it; the before-image keeps what it said.
  v_detail text := nullif(trim(coalesce(p ->> 'detail_comment', '')), '');
  -- The outcome. Read here and validated below rather than trusted: the only thing the caller may do
  -- with a value it does not recognise is drop it (visit-outcome.ts), and the same holds here.
  v_next_step text := nullif(btrim(p ->> 'next_step'), '');
  v_next_step_on date := nullif(p ->> 'next_step_on', '')::date;
  v_objection text := nullif(btrim(p ->> 'objection'), '');
  v_objection_note text := nullif(regexp_replace(trim(coalesce(p ->> 'objection_note', '')), '\s+', ' ', 'g'), '');
  v_samples jsonb := p -> 'samples_given';
  v_availability jsonb := p -> 'product_availability';
  -- ADD-ONLY (owner, 2026-10-15). Null on the wire whenever he is not adding one.
  v_pharmacy text := nullif(trim(coalesce(p ->> 'pharmacy_name', '')), '');
  v_new_pharmacy text;
  v_visit public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_is_pharmacy boolean;
  -- The pharmacies a NEWLY added name points at, filed as visits of their own, exactly as
  -- phoenix_crm_save_visit files them on the day the rep logs the visit.
  v_links jsonb;
  v_entry jsonb;
  v_entry_name text;
  v_entry_id uuid;
  v_entry_new boolean;
  v_link public.phoenix_crm_customers%rowtype;
  v_link_visit uuid;
  v_link_created boolean;
  v_filed jsonb := '[]'::jsonb;
begin
  if v_id is null or v_seat is null or v_actor is null
    or (v_detail is not null and char_length(v_detail) > 2000)
    or (v_pharmacy is not null and char_length(v_pharmacy) > 120) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The same per-territory lock the rep's own save takes, so a save and an edit cannot interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select v.* into v_visit
  from public.phoenix_crm_visits v
  where v.id = v_id
    and v.seat_id = v_seat
    and v.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_not_found';
  end if;

  -- HIS OWN VISIT, AND ONLY HIS. A visit a manager entered for himself carries no rep at all; one the
  -- Super Admin entered for a visit the rep missed logging carries the REP, so it is the rep's to
  -- complete — he made the visit, the Super Admin only recorded it.
  if v_visit.rep_hr_id is null or v_visit.rep_hr_id <> v_actor then
    raise exception 'phoenix_crm:visit_not_yours';
  end if;

  -- The pharmacy visit a doctor's visit filed is part of that submission, never a second piece of
  -- work, so its detail belongs to the visit it came from.
  if v_visit.linked_from_visit_id is not null then
    raise exception 'phoenix_crm:visit_is_linked';
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_visit.customer_id;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  v_is_pharmacy := v_customer.list_type = 'Pharmacy';

  -- ADD-ONLY. At a pharmacy the pharmacy IS the customer and the column is its name, so there is
  -- nothing to add; on a visit that already names one, changing it would delete the visit that name
  -- filed.
  if v_pharmacy is not null and (v_is_pharmacy or v_visit.pharmacy_name is not null) then
    raise exception 'phoenix_crm:pharmacy_name_fixed';
  end if;
  v_new_pharmacy := coalesce(v_visit.pharmacy_name, v_pharmacy);

  -- An unknown value is DROPPED, never raised — a phone one release behind must not cost a rep the
  -- detail he just typed. The dependants go with their parent, so the row can never say "by 30 Sept"
  -- under "Nothing to follow", or carry a note under "No objection".
  if v_next_step is not null and v_next_step not in ('follow_up', 'send_data', 'arrange_double', 'invite_event', 'pharmacy_stock', 'none') then
    v_next_step := null;
  end if;
  if v_next_step is null or v_next_step = 'none' then
    v_next_step_on := null;
  end if;
  if v_objection is not null and v_objection not in ('price', 'efficacy', 'safety', 'competitor', 'formulary', 'no_time', 'none') then
    v_objection := null;
  end if;
  if v_objection is null or v_objection = 'none' then
    v_objection_note := null;
  else
    v_objection_note := left(v_objection_note, 300);
  end if;

  -- A bag that is not a bag LEAVES WHAT THE VISIT HAS — deliberately NOT save_visit's '{}', which is
  -- that function's default for a brand-new row. Here an empty object is a real instruction ("I left
  -- nothing after all"), so a malformed one must not be read as that instruction and wipe his answers.
  if v_samples is null or jsonb_typeof(v_samples) <> 'object' or (select count(*) from jsonb_object_keys(v_samples)) > 20 then
    v_samples := v_visit.samples_given;
  end if;
  if v_availability is null or jsonb_typeof(v_availability) <> 'object' then
    v_availability := v_visit.product_availability;
  end if;

  -- Nothing different: no copy, no write, and the caller is told so.
  if v_detail is not distinct from v_visit.detail_comment
    and v_next_step is not distinct from v_visit.next_step
    and v_next_step_on is not distinct from v_visit.next_step_on
    and v_objection is not distinct from v_visit.objection
    and v_objection_note is not distinct from v_visit.objection_note
    and v_samples is not distinct from v_visit.samples_given
    and v_availability is not distinct from v_visit.product_availability
    and v_new_pharmacy is not distinct from v_visit.pharmacy_name then
    return jsonb_build_object('visit_id', v_id, 'changed', false, 'linked_pharmacies', '[]'::jsonb);
  end if;

  -- The copy first, so nothing is overwritten that is not already kept.
  insert into public.phoenix_crm_visit_edits (
    visit_id, seat_id, customer_id, visit_date, edited_by_hr_id, is_test, before_edit, after_edit
  )
  values (
    v_visit.id, v_visit.seat_id, v_visit.customer_id, v_visit.visit_date, v_actor, v_visit.is_test,
    jsonb_build_object(
      'detail_comment', v_visit.detail_comment,
      'next_step', v_visit.next_step,
      'next_step_on', v_visit.next_step_on,
      'objection', v_visit.objection,
      'objection_note', v_visit.objection_note,
      'samples_given', v_visit.samples_given,
      'product_availability', v_visit.product_availability,
      'pharmacy_name', v_visit.pharmacy_name
    ),
    jsonb_build_object(
      'detail_comment', v_detail,
      'next_step', v_next_step,
      'next_step_on', v_next_step_on,
      'objection', v_objection,
      'objection_note', v_objection_note,
      'samples_given', v_samples,
      'product_availability', v_availability,
      'pharmacy_name', v_new_pharmacy,
      -- Which door wrote it. The Super Admin's correction writes no such key, so a reader can tell
      -- the two apart without reading the shape of the blob.
      'edited_by', 'rep_detail'
    )
  );

  update public.phoenix_crm_visits
  set detail_comment = v_detail,
      next_step = v_next_step,
      next_step_on = v_next_step_on,
      objection = v_objection,
      objection_note = v_objection_note,
      samples_given = v_samples,
      product_availability = v_availability,
      pharmacy_name = v_new_pharmacy,
      detail_edited_at = now(),
      detail_edited_by_hr_id = v_actor
  where id = v_id;

  -- THE PHARMACY HE JUST NAMED IS A VISIT TO THAT PHARMACY TOO (owner, 2026-10-03), filed exactly as
  -- phoenix_crm_save_visit files it: on the PARENT's day and at the parent's reading, no photo and no
  -- place of its own, one box able to name several, five at most, a name the caller could not place
  -- skipped and never raised, and a pharmacy already visited that day keeping the visit it has.
  if not v_is_pharmacy and v_visit.pharmacy_name is null and v_pharmacy is not null then
    v_links := case
      when jsonb_typeof(p -> 'linked_pharmacies') = 'array' then p -> 'linked_pharmacies'
      else '[]'::jsonb
    end;

    for v_entry in
      select e.value from jsonb_array_elements(v_links) with ordinality as e(value, n) order by e.n limit 5
    loop
      v_entry_name := nullif(trim(coalesce(v_entry ->> 'name', '')), '');
      v_entry_id := case
        when (v_entry ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_entry ->> 'id')::uuid
      end;
      v_entry_new := coalesce((v_entry ->> 'new') = 'true', false);
      v_link := null;
      v_link_visit := null;
      v_link_created := false;
      continue when v_entry_name is null or char_length(v_entry_name) > 120;

      if v_entry_id is not null then
        select c.* into v_link
        from public.phoenix_crm_customers c
        where c.id = v_entry_id
          and c.seat_id = v_seat
          and c.is_test = v_is_test
          and c.list_type = 'Pharmacy'
          and c.status in ('active', 'pending', 'outside');
      elsif v_entry_new then
        -- The caller decided "new" from a read taken before this call, so the name is checked again
        -- here, under the SAME lock phoenix_crm_add_pharmacy takes: two edits naming one new pharmacy,
        -- or an edit racing Add a pharmacy, file one pharmacy, never two rows for it.
        perform pg_advisory_xact_lock(hashtext('phoenix_crm_add_pharmacy|' || v_seat || '|' || v_is_test::text));
        select c.* into v_link
        from public.phoenix_crm_customers c
        where c.seat_id = v_seat
          and c.is_test = v_is_test
          and c.list_type = 'Pharmacy'
          and c.status in ('active', 'pending', 'outside')
          and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(v_entry_name, '\s+', ' ', 'g')))
        order by (c.status = 'active') desc, c.id
        limit 1;
        if v_link.id is null then
          insert into public.phoenix_crm_customers (
            seat_id, line_code, list_type, name, origin, status, created_by_hr_id, is_test, intake_note
          )
          values (
            v_seat, v_customer.line_code, 'Pharmacy', v_entry_name, 'new', 'pending', v_actor, v_is_test,
            left('Added when the visit to ' || v_customer.name || ' named it.', 300)
          )
          returning * into v_link;
          v_link_created := true;
        end if;
      end if;

      if v_link.id is not null then
        insert into public.phoenix_crm_visits (
          id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
          senior_hr_id, product_manager_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability,
          lat, lon, accuracy_meters, place_id, distance_meters, location_flag, is_test,
          is_unplanned, unplanned_kind, samples_given,
          capture_source, time_anchor_id, offline_seconds, synced_at,
          linked_from_visit_id
        )
        values (
          gen_random_uuid(), v_seat, v_visit.line_code, v_link.id, 'Pharmacy', v_visit.visit_date, v_visit.captured_at,
          'single', v_visit.rep_hr_id,
          case when v_visit.rep_hr_id is null then v_visit.manager_hr_id end,
          null, null, v_actor, v_visit.products, null, v_entry_name, '{}'::jsonb,
          v_visit.lat, v_visit.lon, v_visit.accuracy_meters,
          null, null, 'no_place', v_is_test,
          false, null, '{}'::jsonb,
          v_visit.capture_source, null, null, now(),
          v_id
        )
        on conflict (seat_id, customer_id, visit_date, is_test) do nothing
        returning id into v_link_visit;
        v_filed := v_filed || jsonb_build_array(jsonb_build_object(
          'customer_id', v_link.id, 'name', v_link.name, 'visit_id', v_link_visit, 'created', v_link_created
        ));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'visit_id', v_id,
    'changed', true,
    'detail_edited_at', now(),
    'linked_pharmacies', v_filed
  );
end;
$$;

comment on function public.phoenix_crm_edit_visit_detail(jsonb) is
  'The REP fills in or corrects his own saved visit''s detail (owner, 2026-10-15): the detailed '
  'comment, the objection and its note, the next step and its day, what he left, the pharmacy stock '
  'answers, and a pharmacy name the visit does not yet carry. It never touches the customer, the day, '
  'the time, the location, the photo, the voice note, AM/PM, who was on the visit or the products, and '
  'it notifies nobody. What each save replaced is kept in phoenix_crm_visit_edits.';

revoke execute on function public.phoenix_crm_edit_visit_detail(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_edit_visit_detail(jsonb) to service_role;

-- So the API sees the new function and the three columns without a restart.
notify pgrst, 'reload schema';

commit;
