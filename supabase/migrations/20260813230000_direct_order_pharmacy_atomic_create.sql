-- Direct Orders — atomic pharmacy creation, and a home for a CONTESTED distributor code
-- (owner, 2026-08-13)
--
-- WHAT WENT WRONG. createDirectOrderPharmacy wrote the pharmacy and its distributor codes as TWO
-- separate statements from the Node client, with nothing wrapping them:
--
--     insert into direct_order_pharmacies ...        -- commits
--     insert into ..._distributor_codes ...          -- raises 23505, function throws
--
-- The unique index on (distributor_code, customer_code) is doing its job — one customer code
-- belongs to one pharmacy, which is what stops a distributor's customer being attributed to two
-- pharmacies at once. But the parent row was ALREADY COMMITTED by the time the child failed. The
-- request returned "Could not create the pharmacy." while a codeless duplicate sat in the table.
--
-- CONFIRMED LIVE, staging, 2026-08-13 19:39:13 Cairo: DOP-000013 was created correctly at 19:38:12
-- carrying PS/12345; sixty-one seconds later the same submission produced DOP-000014 — identical
-- name, brick, doctor and address, NO code — plus an error message telling the rep it had failed.
--
-- The orphan is then invisible to BOTH dedupe passes in duplicate-resolution.ts: the code pass
-- needs a code on each side (the orphan has none), and the name+area pass deliberately considers
-- only pharmacies holding ZERO codes on BOTH sides (the twin holds one). So nothing would ever
-- have surfaced the pair. Production carries the same shape today: "حضانه زمزم" in D15 exists five
-- times, two of those rows holding the invented codes "000000" and "00000".
--
-- Two changes, and deliberately no third: the unique index STAYS. It is the only thing standing
-- between one customer code and two pharmacies, and it is what made this visible at all.

begin;

-- ── 1. Where a REFUSED code claim is remembered ──────────────────────────────────────────────
--
-- When a rep claims a code that another pharmacy already holds and then tells us it is genuinely a
-- different pharmacy, we must not write the child row — the incumbent owns the code and the unique
-- index is correct to refuse a second owner. Dropping the claim on the floor is equally wrong: the
-- rep's answer is evidence, and it is exactly the evidence the reviewer needs.
--
-- So the claim is recorded HERE, on the claimant, and the pharmacy is still created. That is the
-- 2026-08-04 rule applied to a new case: refusing does not produce a correct code, it produces an
-- invented one. Blocking here is what produces "000000".
--
-- Deliberately jsonb rather than a child table: a contested claim is read as a whole, only ever
-- alongside its pharmacy, and it must survive even when the code it names is later reassigned —
-- so it is a note, not a relation, and it must NOT carry a foreign key that could delete it.
alter table public.direct_order_pharmacies
  add column if not exists contested_code_claims jsonb not null default '[]'::jsonb;

alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_contested_claims_is_array;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_contested_claims_is_array
  check (jsonb_typeof(contested_code_claims) = 'array');

comment on column public.direct_order_pharmacies.contested_code_claims is
  'Distributor codes this pharmacy CLAIMED but does not own, because another pharmacy already holds '
  'them. Written only when the submitter was shown the incumbent and answered that theirs is a '
  'different pharmacy. Each element: {distributorCode, customerCode, heldByPharmacyId, '
  'heldByPharmacyCode, heldByPharmacyName, claimedAt}. An empty array is the normal case. This is '
  'evidence for the reviewer, never an attribution — the incumbent keeps the code until a human '
  'rules otherwise.';

create index if not exists direct_order_pharmacies_contested_claims_idx
  on public.direct_order_pharmacies using gin (contested_code_claims)
  where contested_code_claims <> '[]'::jsonb;

-- ── 2. One statement, one transaction ────────────────────────────────────────────────────────
--
-- The Node client cannot open a transaction across two .insert() calls, so the two writes move
-- into a single plpgsql function. A function body runs inside the caller's transaction: if the
-- child insert raises 23505, the parent insert rolls back with it and NOTHING is left behind.
-- That is the entire point — the caller may still fail, but it can no longer half-succeed.
--
-- The child rows arrive fully built (geography already resolved by the service against the
-- customer map) so this function stays dumb: it inserts what it is given, atomically, and returns
-- the created row. Putting the geography lookup in here would move a business rule into SQL where
-- the domain layer could no longer see it.
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
begin
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
    contested_code_claims
  )
  values (
    nullif(btrim(coalesce(p_pharmacy->>'pharmacy_name', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'brick_id', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'area_code', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'region_code', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'doctor_name', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'pharmacy_address', '')), ''),
    nullif(btrim(coalesce(p_pharmacy->>'created_by_hr_id', '')), ''),
    -- Every hand-registered pharmacy starts unrecognised (owner rule, 2026-08-04). The caller may
    -- not choose otherwise, so the value is pinned here rather than read from the payload.
    'pending_review',
    'manual',
    case
      when jsonb_typeof(p_pharmacy->'contested_code_claims') = 'array'
        then p_pharmacy->'contested_code_claims'
      else '[]'::jsonb
    end
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
  'Creates a direct-order pharmacy and its distributor code rows in ONE transaction. Exists because '
  'the two inserts used to be separate client calls: the pharmacy committed, the codes hit the '
  'unique index, and the caller was told the whole thing failed while a codeless duplicate stayed '
  'behind (staging DOP-000014, 2026-08-13). Raises on conflict and leaves nothing.';

-- REVOKE FROM PUBLIC before GRANT, never after: on a default ACL the revoke also strips
-- service_role, and a later grant is the only thing that puts it back.
revoke all on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) from public;
revoke all on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) from anon;
revoke all on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) from authenticated;
grant execute on function public.phx_create_direct_order_pharmacy(jsonb, jsonb) to service_role;

commit;
