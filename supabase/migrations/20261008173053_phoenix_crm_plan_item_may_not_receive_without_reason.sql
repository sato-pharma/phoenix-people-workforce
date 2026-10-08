-- WHAT: phoenix_crm_plan_items_exception no longer demands a reason for a customer who does not
--       receive on the planned day. A not-receiving item may now carry no reason at all.
--       Before: (receives AND type IS NULL AND note IS NULL) OR (NOT receives AND type IS NOT NULL)
--       After:  (receives AND type IS NULL AND note IS NULL) OR (NOT receives)
-- WHY:  Owner ruling 2026-09-30 — "never block, because the rep didn't add his time": a customer whose
--       saved hours do not cover the day is ticked with NO reason asked (plan-rules.ts resolvePlanItems,
--       tests/phoenix-crm-plan-never-blocked.test.ts). The app was changed, the constraint never was, so
--       every such tick made phoenix_crm_save_plan fail with 23514 and the rep read "Not saved — Could
--       not save the plan." Measured 2026-10-08: ~175 failed saves in a day, every one a row with
--       receives = false and exception_type NULL; production held 0 not-receiving items ever.
-- ROLLBACK: restore the old check (alter table ... add constraint phoenix_crm_plan_items_exception
--       check ((receives and exception_type is null and exception_note is null) or (not receives and
--       exception_type is not null))). It fails while a not-receiving item without a reason exists.

alter table public.phoenix_crm_plan_items
  drop constraint if exists phoenix_crm_plan_items_exception;

alter table public.phoenix_crm_plan_items
  add constraint phoenix_crm_plan_items_exception
  check ((receives and exception_type is null and exception_note is null) or (not receives));
