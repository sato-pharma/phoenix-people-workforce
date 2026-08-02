-- Allocate area-less Direct sales across the DM territories that share a Source-of-Sales region.
--
-- Owner ruling 2026-08-02, on the 1,200 units / 88,882.40 EGP of Anti Infective Direct that could
-- not be identified to a district: "UE 1,200 should be distrbuted on ue 1 and ue 2 ... based on
-- areas she minia 1 - 2 & banisuef he sohag assuit qena", recorded in the attribution layer
-- rather than by rewriting invoice rows.
--
-- WHY NOT REWRITE THE ROWS. source_of_sales_import_rows is the audit surface — the Closing
-- Details module and the workbook's "Data" sheet both promise every distributor line exactly as
-- imported. The 19 rows re-tagged earlier each carried evidence (a place in their own text, or
-- the same pharmacy labelled in another month). These 16 carry NONE: 5 have no client name at
-- all and the rest name pharmacies never labelled anywhere. Writing a region onto them would
-- make an allocation indistinguishable from a fact, permanently and invisibly. Here the split is
-- explicit, reversible, and visible as an allocation.
--
-- WHY A TABLE AND NOT A CONSTANT. The basis is a business decision that will change. Weights are
-- data, so switching to sales-weighted, 50/50, or any other rule is one UPDATE — no migration,
-- no function redeploy. Delete the rows and the behaviour reverts to "stays at region level".
--
-- Today's single rule, from the owner's own territory description:
--
--   UE-1  Nosiba Salah        Minia 1, Minia 2, Fayoum-Beni Suef            3 areas  -> weight 3
--   UE-2  Ahmed Nashaat Ali   Assuit 1/2, Sohag 1/2, Qena 1/2               6 areas  -> weight 6
--
-- so 1:2. Applied to the 88,882.40 residual that is ~29,627 to UE-1 and ~59,255 to UE-2.
--
-- CONSERVATION. Shares are weight / sum(weight) within a (line, sos_region), so they always sum
-- to exactly 1 and the fanned-out rows reproduce the original value. A (line, region) with no
-- rule is emitted unchanged — the LEFT JOIN and coalesce(share, 1) make the whole mechanism a
-- no-op everywhere it is not configured, so CNS and Pedia are untouched.

begin;

create table if not exists au.direct_region_allocation (
  line_code           text        not null,
  -- The region code as it arrives on the Direct sheet (the ambiguous one, e.g. 'UE').
  sos_region_code     text        not null,
  -- The operational DM region it is allocated to (e.g. 'UE-1').
  target_region_code  text        not null,
  -- Relative share within the (line, sos_region) group. Any positive scale works; only the
  -- ratio matters, so "3 and 6" and "1 and 2" behave identically.
  weight              numeric     not null,
  note                text        not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (line_code, sos_region_code, target_region_code),
  constraint direct_region_allocation_weight_positive check (weight > 0),
  constraint direct_region_allocation_target_differs check (target_region_code <> sos_region_code)
);

comment on table au.direct_region_allocation is
  'Owner-set allocation of area-less Direct sales across the DM territories inside one '
  'Source-of-Sales region. Rows here are a DELIBERATE ALLOCATION, not evidence: they exist '
  'because the invoice line does not say which district it belongs to. Change the weights to '
  'change the basis; delete the rows to stop allocating and leave the value at region level.';

insert into au.direct_region_allocation (line_code, sos_region_code, target_region_code, weight, note)
values
  ('anti_infective','UE','UE-1',3,'Minia 1, Minia 2, Fayoum-Beni Suef — 3 areas (Nosiba Salah)'),
  ('anti_infective','UE','UE-2',6,'Assuit 1/2, Sohag 1/2, Qena 1/2 — 6 areas (Ahmed Nashaat Ali)')
on conflict (line_code, sos_region_code, target_region_code) do nothing;

revoke all on table au.direct_region_allocation from public, anon, authenticated;
grant select on table au.direct_region_allocation to service_role;

commit;

notify pgrst, 'reload schema';
