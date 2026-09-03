-- Direct Orders — let the submitter DECLARE which CRM contact a venue is (owner, 2026-09-03)
--
-- WHY A COLUMN AND NOT A BETTER MATCHER. `contact-trade.ts` decides whether a row on a rep's CRM
-- contact list has been traded with. It has three rules, in order: an explicit CRM id wins; else an
-- exact name in the same sales area; else a prefix that is unique in that area. Marketing fires
-- rule 1, because `marketing_customer_contacts.crm_code` carries an id a human wrote down. The
-- direct-order side has no such id anywhere, so it can only ever reach the two INFERRED rules.
--
-- Measured against production 2026-09-03: of 63 live direct-order venues, exactly ONE links to a
-- CRM contact. The tempting diagnosis is the area gate — 759 of 1,872 CRM pharmacies (41%) resolve
-- to no area — but that diagnosis is wrong, and the ceiling settles it: drop the area gate entirely
-- and ask only whether a venue name has ANY twin among all 1,872 CRM pharmacies, and the answer is
-- 4. Four exact, zero prefix. A company-wide brick-resolution drive would move this from 1 to at
-- most 4 of 63. The names simply do not meet: a rep types a venue into an order form, the CRM holds
-- a different string for the same shop, and no normalizer recovers the difference.
--
-- So the gap is a MISSING DECLARATION, not a weak matcher. This column is that declaration, and it
-- is the same shape as the campaign link on the order form — the requester states it when the
-- record is created, instead of the system guessing afterwards.
--
-- IT IS OPTIONAL, AND THAT IS DELIBERATE. The 2026-08-04 owner rule about distributor codes applies
-- with equal force here: refusing to save a venue whose CRM contact the submitter cannot find does
-- not produce a correct link, it produces a wrong one. A submitter who picks nothing leaves this
-- null and the venue behaves exactly as it does today.
--
-- WHO CAN ACTUALLY FILL IT IN. Venue creators are almost entirely District Sales Managers — 10 of
-- the 12 people who have ever registered one, and 63 of the 72 venues — and a DM's own CRM account
-- carries NO contact list. The lists belong to the 44 medical reps. So the picker behind this
-- column is scoped to the submitter's own list UNION their org subtree, never to their own account
-- alone, or it would be empty for 63 of 72 venues. Measured on the same date, team-scoped:
--   · pharmacy lists only ............ 33 of 72 venues have at least one candidate
--   · including PM/AM doctor lists ... 66 of 72
-- Both list kinds are offered, because a venue row carries a REQUIRED doctor name and six of the
-- nine most active registering DMs have team doctor lists but no team pharmacy list at all.

begin;

-- ── 1. The declaration ───────────────────────────────────────────────────────────────────────
--
-- `bigint` to match `ireports360_contacts.contact_crm_id`. Deliberately NO foreign key: that table
-- is a per-agent contact LIST scraped from the CRM's web app, keyed
-- `(agent_crm_id, contact_crm_id, list_type)`, not a contact registry. 47% of the contacts reps
-- have actually visited are absent from it, and a contact dropped from every rep's list simply
-- stops being returned by the scrape. An FK would therefore delete or refuse a link that is still
-- correct — the id is a reference to the CRM's own numbering, not to a row Phoenix owns.
alter table public.direct_order_pharmacies
  add column if not exists crm_contact_id bigint;

-- Who declared it, and when. Without these the column would be another value that cannot say where
-- it came from — and this one is a human judgement, not a derived fact, so the author is the whole
-- point. `updated_by_hr_id` elsewhere in this database has already proved it lies about authorship
-- when a row is touched by a later process; these two are written once, by the RPC, from the
-- submitter's own access context.
alter table public.direct_order_pharmacies
  add column if not exists crm_contact_linked_by_hr_id text;

alter table public.direct_order_pharmacies
  add column if not exists crm_contact_linked_at timestamptz;

comment on column public.direct_order_pharmacies.crm_contact_id is
  'The CRM contact (ireports360 contact_crm_id) this venue IS, as declared by the person who '
  'registered it. Feeds rule 1 of contact-trade.ts, which beats every name/area inference. NULL is '
  'the normal case and blocks nothing — see the migration header for why refusing would be worse. '
  'No foreign key on purpose: ireports360_contacts is a per-agent list, not a registry.';

comment on column public.direct_order_pharmacies.crm_contact_linked_by_hr_id is
  'HR id of the person who declared crm_contact_id, written once at registration. This is a human '
  'judgement, so it carries its author.';

comment on column public.direct_order_pharmacies.crm_contact_linked_at is
  'When crm_contact_id was declared, written once at registration.';

-- The trade read looks the whole set up at once (`loadTradeCounterparties` reads every venue), so
-- this index serves the reverse question — "which venues claim this contact?" — which is what a
-- reviewer asks when two venues name the same CRM row.
create index if not exists direct_order_pharmacies_crm_contact_idx
  on public.direct_order_pharmacies (crm_contact_id)
  where crm_contact_id is not null;

-- A contact id is a positive integer in the CRM's numbering. Zero and negatives are not "unknown",
-- they are a caller that parsed a blank field into a number — the same failure that put "000000"
-- into a distributor code column when a required field had nothing valid to put in it.
alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_crm_contact_id_positive;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_crm_contact_id_positive
  check (crm_contact_id is null or crm_contact_id > 0);

-- ── 2. The atomic creator learns the new field ───────────────────────────────────────────────
--
-- Unchanged in every other respect. `verification_status` and `entry_source` stay PINNED here
-- rather than read from the payload (owner rule, 2026-08-04: every hand-registered venue starts
-- unrecognised, and no caller may register a pre-approved one). Declaring a CRM contact is NOT
-- evidence and must not shorten that chain — it says which contact this is, not that the venue is
-- real, so it deliberately does not touch the verification state.
create or replace function public.phx_create_direct_order_pharmacy(
  p_pharmacy jsonb,
  p_codes jsonb default '[]'::jsonb
)
returns public.direct_order_pharmacies
language plpgsql
set search_path to ''
as $function$
declare
  v_row public.direct_order_pharmacies;
  v_crm_contact_id bigint;
begin
  -- An absent key, an empty string and a non-numeric string all mean "not declared". A cast that
  -- raised here would turn a picker the submitter never touched into a failed registration.
  begin
    v_crm_contact_id := nullif(btrim(coalesce(p_pharmacy->>'crm_contact_id', '')), '')::bigint;
  exception
    when others then v_crm_contact_id := null;
  end;
  if v_crm_contact_id is not null and v_crm_contact_id <= 0 then
    v_crm_contact_id := null;
  end if;

  insert into public.direct_order_pharmacies (
    pharmacy_name,
    brick_id,
    area_code,
    region_code,
    doctor_name,
    pharmacy_address,
    created_by_hr_id,
    verification_status,
    entry_source,
    contested_code_claims,
    venue_type,
    crm_contact_id,
    crm_contact_linked_by_hr_id,
    crm_contact_linked_at
  )
  values (
    nullif(btrim(coalesce(p_pharmacy->>'pharmacy_name', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'brick_id', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'area_code', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'region_code', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'doctor_name', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'pharmacy_address', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'created_by_hr_id', '')), ''),
    'pending_review',
    'manual',
    case
      when jsonb_typeof(p_pharmacy->'contested_code_claims') = 'array'
        then p_pharmacy->'contested_code_claims'
      else '[]'::jsonb
    end,
    -- Verbatim from the live definition (read out of pg_proc, 2026-09-03) — a WHITELIST, not a
    -- pass-through. Relaxing it to `coalesce(payload, 'pharmacy')` would let any string reach the
    -- column; every unrecognised answer must read as `pharmacy`, which is what this already does.
    case
      when lower(btrim(coalesce(p_pharmacy->>'venue_type', ''))) = 'nursery' then 'nursery'
      else 'pharmacy'
    end,
    v_crm_contact_id,
    -- Only stamped when a link was actually declared, so an author with no link is impossible.
    case when v_crm_contact_id is null then null
         else nullif(btrim(coalesce(p_pharmacy->>'created_by_hr_id', '')), '') end,
    case when v_crm_contact_id is null then null else now() end
  )
  returning * into v_row;

  if jsonb_array_length(coalesce(p_codes, '[]'::jsonb)) > 0 then
    insert into public.direct_order_pharmacy_distributor_codes (
      pharmacy_id,
      distributor_code,
      customer_code,
      mapped_brick_id,
      mapped_area_code,
      mapped_region_code
    )
    select
      v_row.id,
      c.value->>'distributor_code',
      c.value->>'customer_code',
      nullif(btrim(coalesce(c.value->>'mapped_brick_id', '')), ''),
      nullif(btrim(coalesce(c.value->>'mapped_area_code', '')), ''),
      nullif(btrim(coalesce(c.value->>'mapped_region_code', '')), '')
    from jsonb_array_elements(coalesce(p_codes, '[]'::jsonb)) as c(value);
  end if;

  return v_row;
end;
$function$;

comment on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) is
  'Creates a direct-order venue and its distributor code rows in ONE transaction. Exists because '
  'the two inserts used to be separate client calls: the venue committed, the codes hit the unique '
  'index, and the caller was told the whole thing failed while a codeless duplicate stayed behind '
  '(staging DOP-000014, 2026-08-13). Also records the submitter''s declared CRM contact, which is '
  'the only thing that lets a direct order reach a rep''s contact list (2026-09-03). Raises on '
  'conflict and leaves nothing.';

-- REVOKE FROM PUBLIC before GRANT, never after: on a default ACL the revoke also strips
-- service_role, and a later grant is the only thing that puts it back.
revoke all on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) from public;
revoke all on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) from anon;
revoke all on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) from authenticated;
grant execute on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) to service_role;

commit;
