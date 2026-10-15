-- =============================================================================
-- THE ADD PATH WRITES THE DOCTOR'S NAME ROW ITSELF
-- =============================================================================
-- WHAT THIS CHANGES: one new trigger function, `public.phoenix_crm_customers_write_contact_name_row`,
--       and one trigger of the same name on `public.phoenix_crm_customers`. When a row that is a
--       Phoenix-born doctor lands — or an existing one first qualifies — it writes his
--       `public.crm_contacts` name row in the SAME transaction as the customer row. Nothing else is
--       touched: `public.crm_contact_master_refresh` keeps every pass, filter and ordering it has,
--       and no existing row is changed by this file.
--
-- WHY: nothing on the add path wrote `crm_contacts`. The hourly refresh was its only writer, so a
--      doctor a rep added himself existed as a customer with no name row until the next run, and
--      every per-doctor read keyed on `crm_contacts` printed a bare id in that window. Measured on
--      production ozucdzovmcqvepbozvqf, 15 Oct 2026: the four doctors created that day waited a mean
--      of 312 s for their name row, longest 327 s. 20261015132445 made that latency harmless — the
--      refresh no longer aborts for the whole company over it — and recorded under NOT HERE that the
--      latency itself was still there. This file closes it.
--
-- WHY A TRIGGER AND NOT THE DOOR: there is no single add path to edit. Six functions insert into
--      `public.phoenix_crm_customers` on production (read from `pg_proc`, 15 Oct 2026):
--      `phoenix_crm_validate_customer` (the rep's own `new` and `outside` adds, and the manager's
--      `reference` and `listed` validations), `phoenix_crm_add_pharmacy`, `phoenix_crm_save_visit`,
--      `phoenix_crm_load_list_customers` (the SFE's sheet), `phoenix_crm_decide_request` and
--      `phoenix_crm_ensure_reference_customers`. Each is already one transaction, so atomicity was
--      never the hard part — coverage was. A trigger is the one shape that cannot be forgotten by the
--      seventh door, and the table already carries two (`phoenix_crm_customers_no_double_add`,
--      `phoenix_crm_customers_no_late_reference`), so this is the table's own idiom. The app side
--      needs no change at all and gets none: the rule lives in one place instead of six.
--
-- WHY ONLY A PHOENIX-BORN DOCTOR: a customer added BY REFERENCE carries
--      `reference_contact_crm_id`, which `phoenix_crm_seat_reference` took from the contact master
--      itself — so his `crm_contacts` row already exists, by construction. Read on production the
--      same day: 10,502 non-test reference rows, 0 of them without a name row. Covering them would
--      buy nothing and cost something real: `phoenix_crm_ensure_reference_customers` runs on every
--      list read, and an upsert onto an EXISTING `crm_contacts` row takes that row's lock, which the
--      hourly refresh holds for the rest of its slice — so a rep opening his list mid-refresh would
--      wait on it. A Phoenix-born doctor's key is fresh from `crm_contacts_phoenix_id_seq`, so his
--      insert conflicts with nothing and waits for nothing.
--
-- IDENTICAL TO THE REFRESH, DELIBERATELY: the key is `coalesce(reference_contact_crm_id,
--      own_contact_crm_id)`, `source` is 'phoenix', `first_seen_on` is
--      `least(created_at in Cairo, today in Cairo)`, and the conflict arm fills ONLY blanks —
--      `name = coalesce(c.name, excluded.name)` and the same for `speciality` and `phone`. A name the
--      vendor already carries is LEFT ALONE: it is the name every historical report was keyed on, and
--      renaming it would restate months already read. The WHEN clause repeats the name-row pass's own
--      filter (`not is_test`, status in 'active'/'pending'/'dropped'), so `status = 'outside'` writes
--      no name row here either — a customer met out of list is not on anybody's list yet, and the
--      refresh has always excluded him. Because the written values and the guard match the pass
--      exactly, the next refresh finds nothing to change about this doctor: its upsert's own
--      `where` is false for him and it writes no row.
--
-- WHY `UPDATE OF` AND NOT INSERT ALONE: `status = 'outside'` is where a doctor met out of list starts,
--      and the request to add him moves his status, not his row. Firing on that update gives the
--      invariant "a row that qualifies has its name row" instead of "a row that qualified at insert
--      has one", which is the same rule the refresh applies on every run. `name`, `speciality` and
--      `phone` are in the column list for the blank-fill alone: a rep who adds the phone later gets
--      it mirrored, exactly as the refresh would, and a rename still propagates nowhere.
--
-- NO BACKFILL, AND NONE IS MISSING: read on production, 15 Oct 2026 — of the non-test Phoenix-born
--      customers at status active (189), pending (1,807) and dropped (162), ZERO are without a name
--      row. The 56 at `outside` are excluded by the rule above, not by an oversight.
--
-- PINNED BY: `tests/phoenix-crm-add-path-name-row.test.ts`, registered in `tests/run-tests.ts` and so
--       inside the required `validate` job. It reads THIS file and the newest `*contact_refresh*` file
--       and fails unless the two conflict arms are byte-identical — so the refresh pass and this
--       trigger can only ever change together. Five breaks were each watched to fire their own
--       headline assertion before the fix was restored from a copy.
--
-- ROLLBACK: drop the trigger, then the function —
--      `drop trigger if exists phoenix_crm_customers_write_contact_name_row on public.phoenix_crm_customers`
--      followed by `drop function if exists public.phoenix_crm_customers_write_contact_name_row()`.
--      Nothing else is needed — the hourly refresh still creates every name row it ever created, and
--      a row this trigger wrote is one the refresh would have written minutes later anyway.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This file is neither: it writes no row, and it adds one trigger.

begin;

create or replace function public.phoenix_crm_customers_write_contact_name_row()
returns trigger
language plpgsql
-- SECURITY INVOKER, like the table's other two triggers. `public.crm_contacts` and
-- `public.phoenix_crm_customers` carry the SAME grants — postgres and service_role, nothing else
-- (read 15 Oct 2026) — so every caller that can write the customer row can write the name row, and a
-- definer here would only hide that. search_path is pinned empty and every name is qualified.
set search_path = ''
as $$
begin
  insert into public.crm_contacts as c (
    contact_crm_id, name, speciality, phone, source, first_seen_on
  )
  values (
    coalesce(new.reference_contact_crm_id, new.own_contact_crm_id),
    nullif(btrim(new.name), ''),
    nullif(btrim(new.speciality), ''),
    nullif(btrim(new.phone), ''),
    'phoenix',
    least((new.created_at at time zone 'Africa/Cairo')::date, (now() at time zone 'Africa/Cairo')::date)
  )
  on conflict (contact_crm_id) do update set
         -- A name the vendor already carries is left alone: the vendor row is the one every historical
         -- report was keyed on, and renaming it would restate months already read. Only a blank is filled.
         name = coalesce(c.name, excluded.name),
         speciality = coalesce(c.speciality, excluded.speciality),
         phone = coalesce(c.phone, excluded.phone),
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.speciality, c.phone) is distinct from
         (coalesce(c.name, excluded.name), coalesce(c.speciality, excluded.speciality), coalesce(c.phone, excluded.phone))
      or c.first_seen_on > excluded.first_seen_on;
  return null;
end
$$;

comment on function public.phoenix_crm_customers_write_contact_name_row() is
  'Writes a Phoenix-born doctor''s public.crm_contacts name row in the same transaction as his '
  'public.phoenix_crm_customers row, with the same key, values and blank-only conflict arm as '
  'crm_contact_master_refresh''s name-row pass, so the next refresh changes nothing about him.';

-- `create or replace trigger`, not drop-then-create: PostgreSQL 14 added it and both projects run 17.6,
-- so the replace is atomic and the table is never, even for an instant, without this trigger. It also
-- keeps the file free of a DROP, which is what the pre-authorized Supabase doors decline.
create or replace trigger phoenix_crm_customers_write_contact_name_row
after insert or update of status, name, speciality, phone
on public.phoenix_crm_customers
for each row
when (
  -- A reference customer's name row already exists, by construction: see WHY ONLY A PHOENIX-BORN
  -- DOCTOR above. The other two clauses are the refresh name-row pass's own filter, verbatim.
  new.reference_contact_crm_id is null
  and not new.is_test
  and new.status in ('active', 'pending', 'dropped')
)
execute function public.phoenix_crm_customers_write_contact_name_row();

commit;
