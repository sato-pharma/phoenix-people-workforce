-- headwind_enrollment_code_per_configuration
-- ─────────────────────────────────────────────────────────────────────────────
-- One Headwind enrollment code per set of tablet rules, not one for the whole fleet.
--
-- WHAT THIS CHANGES
--   public.headwind_enrollment_template held exactly one row (id = 1, enforced by
--   `check (id = 1)`). It now holds one row per Headwind configuration:
--     * a new column `configuration_id integer`, UNIQUE, the Headwind configuration
--       the code enrolls a tablet onto (3 "Rep tablets", 4 "Rep tablets — Anti
--       Infective", 5 "Rep tablets — Pedia", and any later line's copy);
--     * a new column `configuration_name text`, the rules' name when the code was
--       saved, so a code whose rules were later deleted from Headwind is still named
--       on the page rather than shown as a number;
--     * the `check (id = 1)` constraint is dropped and `id` takes its value from a
--       new sequence starting at 2, so a new row never collides with the old one.
--   The existing row (id = 1) is KEPT exactly as it is, with configuration_id NULL.
--   Phoenix still reads it: it is attributed to the set of rules its own payload
--   names (`com.hmdm.CONFIG`), and it is never offered for scanning otherwise.
--
-- WHY
--   On 9 Nov 2026 each line got its own copy of "Rep tablets" (docs/devices/
--   headwind-rustdesk.md §8.17), and each copy has its OWN enrollment QR key in
--   Headwind. A tablet enrolled with another line's code lands on the wrong rules and
--   never gets its line app. One stored code for the whole fleet could only ever be
--   right for one line.
--
-- 🔴 THE PAYLOAD IS STILL A CREDENTIAL. Nothing about access changes: RLS stays on
--   with no permissive policy, anon/authenticated stay revoked, and service_role is
--   granted the sequence it now needs to insert a row.
--
-- ROLLBACK
--   Only while no row other than id = 1 exists (otherwise the check cannot be
--   re-added — delete the per-configuration rows first, after copying them aside):
--     alter table public.headwind_enrollment_template alter column id set default 1;
--     drop sequence if exists public.headwind_enrollment_template_id_seq;
--     alter table public.headwind_enrollment_template
--       drop constraint if exists headwind_enrollment_template_configuration_id_key,
--       drop constraint if exists headwind_enrollment_template_configuration_id_check,
--       drop column if exists configuration_id,
--       drop column if exists configuration_name,
--       add constraint headwind_enrollment_template_id_check check (id = 1);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is neither destructive nor bulk: two nullable columns and one sequence are
-- added, one check constraint is relaxed, and no row is updated, backfilled or deleted.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.headwind_enrollment_template
  drop constraint if exists headwind_enrollment_template_id_check;

-- The inline `check (id = 1)` was created without a name, so Postgres named it as above. If it was
-- ever renamed, the drop is a no-op and every new row would be refused; say so here instead.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.headwind_enrollment_template'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\(id = 1\)'
  ) then
    raise exception 'headwind_enrollment_template still carries a check (id = 1) under another name';
  end if;
end
$$;

create sequence if not exists public.headwind_enrollment_template_id_seq
  as smallint
  start with 2
  owned by public.headwind_enrollment_template.id;

alter table public.headwind_enrollment_template
  alter column id set default nextval('public.headwind_enrollment_template_id_seq');

alter table public.headwind_enrollment_template
  add column if not exists configuration_id integer;

alter table public.headwind_enrollment_template
  add column if not exists configuration_name text;

alter table public.headwind_enrollment_template
  add constraint headwind_enrollment_template_configuration_id_key unique (configuration_id);

alter table public.headwind_enrollment_template
  add constraint headwind_enrollment_template_configuration_id_check
  check (configuration_id is null or configuration_id > 0);

comment on table public.headwind_enrollment_template is
  'The Android provisioning JSON from the company''s own Headwind MDM server, one row per set of '
  'tablet rules (configuration_id), copied once from its console because the code pins the agent APK '
  'by signature checksum and cannot be minted elsewhere. The row with configuration_id NULL (id = 1) '
  'predates per-line rules and is kept as it was. CREDENTIAL: scanning it enrolls a tablet into the '
  'company fleet with the agent as device owner — service-role only, never logged, never audited.';

comment on column public.headwind_enrollment_template.configuration_id is
  'The Headwind configuration this code enrolls a tablet onto. Unique: each set of rules has its own '
  'QR key in Headwind, so each has exactly one code. NULL only on the pre-2026-11-09 row (id = 1).';

comment on column public.headwind_enrollment_template.configuration_name is
  'The name of that configuration when the code was saved. Read only when the configuration is no '
  'longer on the Headwind server; otherwise the live name is shown.';

-- Unchanged access: RLS on with no permissive policy, browser roles revoked. service_role now needs
-- the sequence to insert a row.
alter table public.headwind_enrollment_template enable row level security;
revoke all on public.headwind_enrollment_template from anon, authenticated;
revoke all on sequence public.headwind_enrollment_template_id_seq from anon, authenticated;
grant select, insert, update on public.headwind_enrollment_template to service_role;
grant usage, select on sequence public.headwind_enrollment_template_id_seq to service_role;

commit;
