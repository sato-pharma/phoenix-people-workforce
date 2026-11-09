-- Source of Sales + Marketing ROI: register El Ezaby as a distributor — EZB, "El Ezaby".
--
-- WHAT
--   1. public.source_of_sales_distributors   — one row, ('EZB', 'El Ezaby', 'el ezaby').
--      The Upload Sales / Source Normalizer distributor picker, and the name every monthly surface
--      reads for the code.
--   2. public.marketing_roi_distributor_rollup — one row, EZB -> parent 'EZB' / 'el ezaby', the way
--      every standalone distributor (QM, MC, RM) rolls up to itself.
--
-- WHY
--   OWNER, 2026-11-10: "add El Ezaby as a distributor and upload this to October" — Sato Pharma's
--   October 2026 sales to the El Ezaby chain, split over Cairo and Giza. El Ezaby is not in the owner's
--   distributor-master file, so it is code-defined: SYSTEM_DISTRIBUTORS in
--   src/lib/sales/master-data/import-service.ts re-ensures it after every master import, and this
--   migration is that list's mirror (as for IS-L, EG-BR and the tender channels).
--   marketing_roi_distributor_rollup is hand-maintained by design; a missing row means the sales reach
--   no marketing desk.
--
--   The code is EZB, never EZ: "EZ" already names the EZ warehouse customer (1011654) in the CNS
--   even-split rule, and the two must never be read as one.
--
--   Read off production 2026-11-10 before writing this: EZB is absent from both tables.
--
-- ROLLBACK (additive, fully reversible — no existing row is read, changed or deleted):
--   delete from public.marketing_roi_distributor_rollup   where sos_distributor_code = 'EZB';
--   delete from public.source_of_sales_distributors       where distributor_code = 'EZB';
--
-- Idempotent: every insert takes the table's own unique key.

-- 1. The Source of Sales distributor. source_file / source_sheet take their column defaults, exactly
-- as ensureSystemDistributors() writes them.
insert into public.source_of_sales_distributors (
  distributor_code, distributor_name, normalized_distributor_name, active
)
values
  ('EZB', 'El Ezaby', 'el ezaby', true)
on conflict (distributor_code) do nothing;

-- 2. Marketing ROI roll-up: El Ezaby is its own desk.
insert into public.marketing_roi_distributor_rollup (
  sos_distributor_code, parent_distributor_code, marketing_normalized_name
)
values
  ('EZB', 'EZB', 'el ezaby')
on conflict (sos_distributor_code) do update
  set parent_distributor_code  = excluded.parent_distributor_code,
      marketing_normalized_name = excluded.marketing_normalized_name;
