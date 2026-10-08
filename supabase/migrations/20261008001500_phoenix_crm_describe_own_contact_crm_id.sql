-- Describe `public.phoenix_crm_customers.own_contact_crm_id` in the repository, so staging and any
-- fresh database get the column that until now existed ONLY in production.
--
-- WHY THIS MIGRATION EXISTS
--
-- `20261007215000_harden_phoenix_crm_no_late_reference_search_path.sql` put the
-- `phoenix_crm_customers_no_late_reference()` trigger into the repository for the first time. Its
-- refusal hint reads `old.own_contact_crm_id` — and that COLUMN is described by no migration and
-- named by no application code: measured 2026-10-08, `own_contact_crm_id` appears in ZERO tracked
-- files, while the sibling `reference_contact_crm_id` appears in 23.
--
-- The consequence was immediate and measured on staging, which received the trigger from
-- `staging-migrate.yml` on that merge but has no such column:
--
--     42703 / record "old" has no field "own_contact_crm_id"
--
-- So the guard fires but cannot explain itself, and a `supabase db reset` reproduces the same hole.
-- This migration closes it by describing the column exactly as production already has it.
--
-- WHAT PRODUCTION ACTUALLY HAS (read from pg_catalog, not from a doc)
--
--   column      own_contact_crm_id bigint NOT NULL DEFAULT nextval('crm_contacts_phoenix_id_seq')
--   constraint  phoenix_crm_customers_own_contact_crm_id_reserved
--                 CHECK (own_contact_crm_id >= 1000000000 AND own_contact_crm_id <= 2000000000)
--   index       phoenix_crm_customers_own_contact_crm_id_key  UNIQUE btree (own_contact_crm_id)
--   no column-level ACL, not an identity column, not generated
--   12,569 of 12,569 rows carry a value
--
-- WHY THE SEQUENCE IS NOT RE-DECLARED HERE
--
-- `public.crm_contacts_phoenix_id_seq` already exists in BOTH environments — it is created by
-- `20260914020000_crm_contact_list_changes.sql`, which mints Phoenix's own contact ids for
-- `crm_contacts` and sorts earlier than this file, so it is guaranteed to have run first. Declaring
-- it again with `create sequence if not exists` would put its reserved band in two places, and the
-- two could drift. This migration ASSERTS it instead, so a reordering fails loudly rather than
-- silently creating a second definition.
--
-- That shared sequence is the point of the design: an `own_contact_crm_id` is drawn from the same
-- 1.0-2.0 billion pool as a Phoenix-minted `crm_contacts.contact_crm_id`, so an own id can never
-- collide with a minted contact id, and the CHECK is what keeps a vendor id (below the band) out of
-- the column.
--
-- SAFETY
--
-- Non-destructive and idempotent. On PRODUCTION every statement is a no-op: the column, the
-- constraint and the index are already there. On staging the column is added to 662 rows; because
-- `nextval()` is volatile this rewrites the table, which is why the guards are per-object rather
-- than one `if not exists` around the whole file. The values it assigns start at 1000000000, so
-- they satisfy the CHECK, and `nextval` guarantees they satisfy the unique index.

begin;

-- The sequence this column's default depends on. Asserted, never re-declared — see the header.
do $$
begin
  if not exists (
    select 1 from pg_class
     where relname = 'crm_contacts_phoenix_id_seq'
       and relkind = 'S'
       and relnamespace = 'public'::regnamespace
  ) then
    raise exception 'public.crm_contacts_phoenix_id_seq is missing: it is created by '
                    '20260914020000_crm_contact_list_changes.sql, which must run before this file';
  end if;
end $$;

alter table public.phoenix_crm_customers
  add column if not exists own_contact_crm_id bigint not null
    default nextval('public.crm_contacts_phoenix_id_seq');

-- Postgres has no `add constraint if not exists`, and the name is the one production already uses.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'phoenix_crm_customers_own_contact_crm_id_reserved'
       and conrelid = 'public.phoenix_crm_customers'::regclass
  ) then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_own_contact_crm_id_reserved
      check (own_contact_crm_id >= 1000000000 and own_contact_crm_id <= 2000000000);
  end if;
end $$;

-- A bare UNIQUE INDEX, not a unique CONSTRAINT: that is what production carries, and pg_constraint
-- there holds only the CHECK for this column.
create unique index if not exists phoenix_crm_customers_own_contact_crm_id_key
  on public.phoenix_crm_customers using btree (own_contact_crm_id);

comment on column public.phoenix_crm_customers.own_contact_crm_id is
    'Phoenix''s OWN contact id for this customer, minted from public.crm_contacts_phoenix_id_seq and therefore unique across Phoenix-minted contact ids. Every report outside Phoenix CRM counts the customer under this id, which is why phoenix_crm_customers_no_late_reference() refuses a reference_contact_crm_id that arrives afterwards.';

commit;
