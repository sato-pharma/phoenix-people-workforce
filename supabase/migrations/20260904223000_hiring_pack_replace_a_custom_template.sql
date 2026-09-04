-- Replacing a company template's artwork — one transaction, because three rules lock each other.
--
-- WHAT THIS IS FOR. The owner re-uploads a paper he has corrected: a typo in the Arabic, a new
-- logo, a box the government moved. The plan's B6 says what has to happen — "editing the artwork of
-- a live template creates a NEW version and archives the old one, the same rule as
-- template-registry.ts, and the same reason. A signed paper has to stay reprintable exactly as it
-- was signed." Version 1 keeps its own artwork, its own field rules and its own printable link
-- forever; version 2 is what prints today.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY A FUNCTION AND NOT TWO POSTGREST CALLS. The three rules written in 20260904140000 are mutually
-- blocking, by design, and the only order that satisfies all of them is a single transaction:
--
--   • `hiring_pack_custom_templates_one_current` refuses a second current row, so the outgoing
--     version must be archived BEFORE the new one is inserted.
--   • `archived_has_successor` refuses an archived row with no successor, so archiving needs the new
--     version's id — which belongs to a row that does not exist yet.
--   • the `superseded_by` foreign key is what makes that legal, and ONLY because it is DEFERRABLE
--     INITIALLY DEFERRED: it is checked at COMMIT, by which time the new row is there.
--
-- Two PostgREST calls are two transactions. The first would commit an archived row pointing at
-- nothing, and the deferred foreign key would refuse it at that commit — so the replacement cannot
-- be expressed through PostgREST at all, however the calls are ordered. This repository also has a
-- standing rule from an earlier incident: a Supabase client request that times out at 15 seconds
-- STILL COMMITS, so a multi-step mutation split across calls leaves half-applied state with no
-- audit row. Both point the same way.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE PAGES ARE INSERTED HERE TOO, in the same transaction. A version row with no pages is a
-- template that prints a sheet of values over nothing — it looks like a rendering fault rather than
-- a failed upload, and it would be the CURRENT version, so it would have replaced a paper that was
-- working.
--
-- The artwork objects are uploaded BEFORE this is called, which is the opposite of the create path
-- and deliberately so. There the key and the version come from the database, so the row has to exist
-- before a path can be built from it. Here both are already known, so the objects can go up first
-- and be deleted again if this function refuses — leaving no trace. The reverse order would risk a
-- committed version whose artwork never arrived.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.hiring_pack_replace_custom_template(
  p_key uuid,
  p_name text,
  p_name_ar text,
  p_group text,
  p_note text,
  p_default_copies smallint,
  p_print_sides text,
  p_page_width_pt numeric,
  p_page_height_pt numeric,
  p_printable_by_roles text[],
  p_pages jsonb,
  p_actor_hr_id text
)
returns table (new_version_id uuid, new_version integer, archived_version_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_current public.hiring_pack_custom_templates%rowtype;
  v_new_id uuid := gen_random_uuid();
begin
  if p_pages is null or jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) = 0 then
    raise exception 'hiring_pack_replace_custom_template: a new version needs at least one page.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE, so two replacements of one template serialise instead of racing. The second waits,
  -- then re-checks its WHERE against the row it is holding — which is now `archived` — and so finds
  -- nothing and raises below. It does NOT see the row the first one inserted: a locking read cannot
  -- return a row that appeared after the statement began. Failing is the right answer there anyway,
  -- because the second caller's artwork was chosen against a version that is no longer the live one.
  select * into v_current
    from public.hiring_pack_custom_templates
   where key = p_key and status = 'current'
   for update;

  if not found then
    raise exception
      'hiring_pack_replace_custom_template: template % has no current version to replace. It may have just been replaced by somebody else.',
      p_key
      using errcode = 'no_data_found';
  end if;

  update public.hiring_pack_custom_templates
     set status = 'archived',
         -- CAIRO, never `current_date`. Production Postgres runs on UTC, so between Cairo midnight
         -- and 03:00 an unzoned date stamps this paper YESTERDAY — and this is the date the archive
         -- shows for when a signed document stopped being the live one.
         superseded_on = (now() at time zone 'Africa/Cairo')::date,
         superseded_by = v_new_id,
         updated_by_hr_id = p_actor_hr_id
   where id = v_current.id;

  insert into public.hiring_pack_custom_templates (
    id, key, name, name_ar, document_group, note,
    default_copies, print_sides,
    page_width_pt, page_height_pt,
    printable_by_roles, applies_to,
    status, version,
    created_by_hr_id, updated_by_hr_id
  ) values (
    v_new_id, p_key, p_name, p_name_ar, p_group, p_note,
    p_default_copies, p_print_sides,
    p_page_width_pt, p_page_height_pt,
    p_printable_by_roles,
    -- CARRIED, not taken from the caller. `applies_to` has no control on the upload screen, so a
    -- caller who cannot set it would silently erase it on every replacement.
    v_current.applies_to,
    'current', v_current.version + 1,
    p_actor_hr_id, p_actor_hr_id
  );

  insert into public.hiring_pack_custom_template_pages (
    template_id, page_index, storage_path, content_type, size_bytes, width_px, height_px
  )
  select v_new_id,
         (page ->> 'page_index')::integer,
         page ->> 'storage_path',
         page ->> 'content_type',
         (page ->> 'size_bytes')::integer,
         (page ->> 'width_px')::integer,
         (page ->> 'height_px')::integer
    from jsonb_array_elements(p_pages) as page;

  return query select v_new_id, v_current.version + 1, v_current.id;
end;
$fn$;

comment on function public.hiring_pack_replace_custom_template(
  uuid, text, text, text, text, smallint, text, numeric, numeric, text[], jsonb, text
) is
  'Replaces a company template''s artwork: archives the current version and inserts the next one with its pages, in ONE transaction. The partial unique index, the archived-has-successor check and the deferred superseded_by foreign key are mutually blocking, so this cannot be done through separate PostgREST calls. Returns the new version''s id, its number, and the id of the version it archived.';

-- SECURITY DEFINER, so it gives up the EXECUTE PostgreSQL grants to PUBLIC on every new function.
-- REVOKING FROM anon AND authenticated ALONE IS A NO-OP — both are members of PUBLIC and inherit
-- through it, which is how the analytics_* overloads once leaked to the anonymous key. Enforced by
-- tests/migrations-secdef-revoke-guard.test.ts.
revoke execute on function public.hiring_pack_replace_custom_template(
  uuid, text, text, text, text, smallint, text, numeric, numeric, text[], jsonb, text
) from public;

-- The application calls this as the service role, which is the only caller there should ever be:
-- replacing a company paper is a Super Admin action behind assertPermission, resolved in the route.
grant execute on function public.hiring_pack_replace_custom_template(
  uuid, text, text, text, text, smallint, text, numeric, numeric, text[], jsonb, text
) to service_role;

commit;

notify pgrst, 'reload schema';

-- ── VERIFY (each answers on its own — the Supabase MCP returns only the LAST result set of a
--    multi-statement call, so a block that checks in statement one and summarises in two certifies
--    a check nobody saw) ──────────────────────────────────────────────────────────────────────────
--
--   select p.proname, pg_catalog.array_to_string(p.proacl, ' | ')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'hiring_pack_replace_custom_template';
--   -- expect: one row, acl naming postgres and service_role only. A bare `=X/postgres` entry is the
--   -- PUBLIC grant still standing. `list_migrations` reports the ledger, not the database — ask
--   -- pg_proc.
--
--   select key, version, status, superseded_on, superseded_by
--     from public.hiring_pack_custom_templates where key = :key order by version;
--   -- expect after one replacement: v1 archived pointing at v2's id, v2 current with both nulls.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- One function, nothing existing touched:
--
--   drop function if exists public.hiring_pack_replace_custom_template(
--     uuid, text, text, text, text, smallint, text, numeric, numeric, text[], jsonb, text);
--
-- Versions already created by it are ordinary rows and stay exactly as they are.
