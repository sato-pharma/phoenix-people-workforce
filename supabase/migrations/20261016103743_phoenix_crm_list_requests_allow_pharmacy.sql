-- WHAT: phoenix_crm_list_requests_list_type now allows 'Pharmacy' beside 'AM' and 'PM'.
-- WHY:  a pharmacy is a third list (list_type 'Pharmacy' on phoenix_crm_customers, 1,843 live rows), but this
--       table's CHECK still said ('AM', 'PM'). phoenix_crm_create_request copies the customer's list_type into
--       the request row, so EVERY request on a pharmacy (drop, add, restore) failed with 23514 and the rep read
--       "Could not send the request." — measured 2026-10-15 23:03-23:06 Cairo, B-59 pressing Send on a pharmacy
--       drop seven times. 0 requests have ever existed for a pharmacy.
-- ROLLBACK: put the CHECK back to ('AM', 'PM') — only after every row with list_type 'Pharmacy' is gone.

alter table public.phoenix_crm_list_requests
  drop constraint phoenix_crm_list_requests_list_type;

alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_list_type check (list_type = any (array['AM'::text, 'PM'::text, 'Pharmacy'::text]));
