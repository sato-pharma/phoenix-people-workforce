-- Register the "EGD-PH" distributor — a separate branch of EGD (parent code EG) — for the Upload Sales
-- dropdown + the source_of_sales_import_rows.distributor_code FK. The fully-coded EGD-PH monthly sheet
-- (Distrub ID = "EGD-PH") is recognized via the universal coded template (NORMALIZER_TEMPLATE); a
-- dedicated EGD-PH coded template (customer capture + naming) follows in a code deploy. Idempotent.
insert into public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, active)
values ('EGD-PH', 'EGD-PH', 'egd-ph', true)
on conflict (distributor_code) do update
  set distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();
