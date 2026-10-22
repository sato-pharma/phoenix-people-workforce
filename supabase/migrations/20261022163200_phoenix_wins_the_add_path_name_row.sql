-- =============================================================================
-- PHOENIX WINS ON THE ADD PATH TOO: THE NAME-ROW TRIGGER WRITES PHOENIX'S VALUES, NOT ONLY BLANKS
-- =============================================================================
-- WHAT: `public.phoenix_crm_customers_write_contact_name_row()` keeps its key, its values, its source and its
--       first_seen_on, and changes ONE thing — its conflict arm. It was the blank-only arm
--       (`name = coalesce(c.name, excluded.name)`); it is now the arm 20261022163100 gives the refresh's
--       name-row pass, byte for byte: `name = coalesce(excluded.name, c.name)`, and the same for speciality
--       and phone. A Phoenix-born doctor's name, speciality and phone as the rep saves them replace what
--       `crm_contacts` holds the moment the row is saved, and a blank in Phoenix never erases a value.
--       The trigger itself (`after insert or update of status, name, speciality, phone`, WHEN a non-test
--       Phoenix-born row at active/pending/dropped) is NOT re-created: its definition in 20261015135844 stands.
--
-- WHY: owner, 2026-10-22 04:0x Cairo: "CRM Master page and all crm old sources once got data from phoenix
--      crm then phoenix is the source of trust and its data override old crm data". With the blank-only arm a
--      rename or a corrected speciality never reached `crm_contacts`: Dr Tharwat Milad (contact 1000036186)
--      was changed to General Surgery in Phoenix and still read Internal Medicine there. And the arm must
--      match the refresh's, or the trigger and the refresh would hold two opinions about one doctor and the
--      next refresh would undo the add (pinned by tests/phoenix-crm-add-path-name-row.test.ts).
--
-- ONLY A PHOENIX-BORN ROW FIRES IT, AS BEFORE: every such row is trusted (it has no vendor counterpart), so
--      what the trigger offers is always Phoenix's own value — the same value the refresh's name-row pass
--      offers for a trusted row. A validated REFERENCE customer reaches crm_contacts through the refresh.
--
-- ROLLBACK: re-apply the `create or replace function` statement of
--      supabase/migrations/20261015135844_the_add_path_writes_the_doctors_name_row.sql (with
--      20261016233000 re-applied for the refresh, so the two arms stay identical).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This file writes
-- no row: it replaces one trigger function's body.
-- =============================================================================

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
         -- Phoenix's value replaces the one on file; a blank offered keeps what is there.
         name = coalesce(excluded.name, c.name),
         speciality = coalesce(excluded.speciality, c.speciality),
         phone = coalesce(excluded.phone, c.phone),
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.speciality, c.phone) is distinct from
         (coalesce(excluded.name, c.name), coalesce(excluded.speciality, c.speciality), coalesce(excluded.phone, c.phone))
      or c.first_seen_on > excluded.first_seen_on;
  return null;
end
$$;

comment on function public.phoenix_crm_customers_write_contact_name_row() is
  'Writes a Phoenix-born doctor''s public.crm_contacts name row in the same transaction as his '
  'public.phoenix_crm_customers row, with the same key, values and conflict arm as '
  'crm_contact_master_refresh''s name-row pass, so the next refresh changes nothing about him. From '
  '2026-10-22 Phoenix is the source of trust (owner): his name, speciality and phone replace what the row '
  'holds, and a blank never erases a value.';

commit;
