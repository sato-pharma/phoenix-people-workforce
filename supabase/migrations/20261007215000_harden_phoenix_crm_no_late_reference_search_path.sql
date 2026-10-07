-- Pin the search_path on the Phoenix CRM "no late reference" trigger function, and put the
-- function and its trigger into the repository at last.
--
-- WHY THIS MIGRATION EXISTS AT ALL
--
-- The Supabase security linter flags `public.phoenix_crm_customers_no_late_reference()` as
-- `function_search_path_mutable` — a SECURITY INVOKER plpgsql function whose search_path is
-- role-mutable. After PR #5446 hardened `business_card_requests_touch()` and #5456 dropped the two
-- leftover `zz_probe_*` functions, this was the LAST function on that list.
--
-- 🔴 But the function and its trigger existed ONLY in the production database. Nothing in this
-- repository named `no_late_reference` before this file — they were created ad hoc, so a `supabase
-- db reset` would have rebuilt a database with no such guard, and the staging project has neither
-- the function nor the trigger today. So this migration does two things at once, because the
-- search_path cannot be pinned in a repeatable, reviewable, rollback-aware way (AGENTS.md §8)
-- without the function being described here first.
--
-- WHY AN EMPTY SEARCH PATH IS SAFE HERE
--
-- The body touches no table, calls no function, and references nothing by name except the `new`
-- and `old` trigger records. The only operators it uses — `is distinct from`, `is null`,
-- `is not null` and `||` (text || bigint, which is `anynonarray || text` in pg_catalog) — all live
-- in pg_catalog, which Postgres searches first regardless of search_path. Proven rather than
-- reasoned: a probe function carrying exactly this `text || bigint` concatenation, declared
-- `set search_path = ''`, returned `id 4321 end` on the staging project inside a transaction that
-- was rolled back.
--
-- The body below is byte-identical to what production is running; only the `set search_path = ''`
-- clause is added. Non-destructive: no data is touched and the guard's behaviour is unchanged.
--
-- 🔴 ONE PRE-EXISTING GAP THIS MIGRATION DELIBERATELY DOES NOT CLOSE: the hint reads
-- `old.own_contact_crm_id`, and that COLUMN is created by no migration either — it too exists only
-- in production. On a fresh database the function creates fine (plpgsql resolves record fields at
-- run time) but the refusal path would raise `record "old" has no field "own_contact_crm_id"`
-- instead of the intended business error. That is true today and this change neither causes nor
-- worsens it; adding the column needs its own migration and its own decision about meaning and
-- backfill, so it is filed separately rather than guessed at here.

begin;

create or replace function public.phoenix_crm_customers_no_late_reference()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.reference_contact_crm_id is distinct from old.reference_contact_crm_id
     and old.reference_contact_crm_id is null
     and new.reference_contact_crm_id is not null then
    raise exception 'phoenix_crm:customer_already_has_own_contact_id'
      using hint = 'This customer already answers to own_contact_crm_id ' || old.own_contact_crm_id
                || ' in every report outside Phoenix CRM. Pointing him at a vendor id now would '
                || 'restate every month already read. Merge the two records instead.';
  end if;
  return new;
end $function$;

comment on function public.phoenix_crm_customers_no_late_reference() is
    'Refuses setting reference_contact_crm_id on a Phoenix CRM customer that had none, because the customer is already read by own_contact_crm_id everywhere outside Phoenix CRM and a late vendor id would restate months already published. Merge the two records instead. search_path is pinned empty: the body resolves nothing outside pg_catalog.';

-- Idempotent, and keyed on the same column as production: Postgres has no
-- `create trigger if not exists`, and `create or replace trigger` would not remove a trigger that
-- had drifted onto different columns or timing.
drop trigger if exists phoenix_crm_customers_no_late_reference on public.phoenix_crm_customers;

create trigger phoenix_crm_customers_no_late_reference
    before update of reference_contact_crm_id on public.phoenix_crm_customers
    for each row
    execute function public.phoenix_crm_customers_no_late_reference();

commit;
