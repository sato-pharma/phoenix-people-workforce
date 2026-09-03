-- Company templates — a paper the owner uploads himself, without a code change or a deploy.
--
-- WHAT THIS IS FOR, in his words on 2026-09-03: "I am able to upload any document and give it a name
-- and a role. And after that, it's in the system … adding another template is done inside the system
-- UI instead of giving it to you and you making it from the code."
--
-- WHY THIS IS A SMALL TABLE AND NOT A NEW RENDERER. `renderSheet` in render-placement.ts is, in
-- full, a `<section class="sheet">` holding `<img class="artwork" src="…">` and a list of absolutely
-- positioned spans at point coordinates. Everything else about a government form — the drag, the
-- drop, the field table, the placeholder engine, the hide, the reset — is already generic over
-- exactly that. So a custom template is a different SOURCE for that one `src`, plus a registry that
-- is data instead of a TypeScript union. These two tables are that registry.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- ONE ROW PER VERSION, NOT ONE ROW PER TEMPLATE, and that shape is copied deliberately from
-- `src/lib/hiring-pack/template-registry.ts` rather than invented here. The built-in registry is a
-- flat list of versions — `contract-v1` archived, `contract-v2` current, each carrying its own
-- superseded_on and superseded_by — because these are papers people SIGN. A contract signed in
-- August against version 1 has to be reproducible as the document that was actually signed, not as
-- today's artwork. A row that is edited in place cannot do that.
--
-- So a template has two identities, the same two the built-ins have:
--
--   • `key`  — stable across every version. This is what `custom:<key>` names in HiringPackDocument,
--              the same slot `contract` or `form1` occupies for a built-in.
--   • `id`   — this VERSION's own identity, which is the template_version_id the field layer scopes
--              its rows to. The same slot `contract-v2` occupies.
--
-- Getting these the wrong way round is the failure worth naming: if `custom:<id>` named the version
-- row instead, replacing a template's artwork would change the document key, and every field rule
-- and every added box written against it would silently stop appearing — which is precisely the
-- failure `carryForwardDocumentFields` exists to make visible for built-ins.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.hiring_pack_custom_templates (
  -- This VERSION's identity. Becomes template_version_id on every field-layer row placed on it.
  id uuid primary key default gen_random_uuid(),

  -- The DOCUMENT's identity, stable across versions. `custom:<key>` is the HiringPackDocument value.
  -- Not unique: one key has one row per version, and exactly one of them is current (see the partial
  -- unique index below, which is where that rule is actually enforced).
  key uuid not null default gen_random_uuid(),

  -- What it is called. Arabic is separate rather than a translation table because every other
  -- document in this module carries labelEn and labelAr side by side, and a paper printed in Egypt
  -- needs both on the screen that prints it.
  name text not null check (length(btrim(name)) > 0),
  name_ar text,

  -- ── The paper ───────────────────────────────────────────────────────────────────────────────
  -- In POINTS, because every coordinate in this module is in points and the artwork is placed with
  -- `placedFormCss(widthPt, heightPt, …)`. Read from the PDF's own page box where there is one, so
  -- it is exact rather than assumed — Form 1 is 612.12 x 1008.12pt, which is neither A4 nor US
  -- Letter, and a paper measured by eye would put every field slightly wrong.
  page_width_pt numeric(10, 2) not null check (page_width_pt > 0),
  page_height_pt numeric(10, 2) not null check (page_height_pt > 0),

  -- ── Version status, mirroring TemplateStatus exactly ────────────────────────────────────────
  status text not null default 'current' check (status in ('current', 'archived')),
  version integer not null default 1 check (version > 0),
  effective_from date not null default current_date,
  -- Both null while current; both set when superseded. The CHECK below refuses the half-filled
  -- states, because an archived version with no successor is a paper that stopped printing for no
  -- recorded reason.
  superseded_on date,
  -- DEFERRABLE INITIALLY DEFERRED, and this is not a style choice — without it a template can never
  -- be replaced at all. Measured on staging: the three rules above lock each other. The partial
  -- unique index refuses a second `current` row, so the outgoing version has to be archived FIRST;
  -- `archived_has_successor` refuses an archived row with no successor, so archiving needs the new
  -- version's id; and an immediate foreign key refuses an id whose row does not exist yet. Deferring
  -- to COMMIT is what opens the one order that satisfies all three: generate the new id, archive the
  -- old row pointing at it, insert the new row as current, commit. Every rule still holds at the end
  -- of the transaction, which is the only moment any of them is a statement about reality.
  superseded_by uuid
    references public.hiring_pack_custom_templates (id)
    on delete restrict
    deferrable initially deferred,
  -- Why it changed, or what it is. Shown in the Archive so the record explains itself.
  note text,

  -- ── Who it is for ───────────────────────────────────────────────────────────────────────────
  -- BOTH READINGS OF "give it a name and a role" ARE STORED, deliberately. The instruction reads two
  -- ways — who may PRINT this paper, or which employees it is FOR — and supporting both costs one
  -- column each while picking the wrong one costs a migration. If only one is ever used the other
  -- stays null and does nothing.
  --
  -- Role NAMES, not ids, and no CHECK against a list: the role set lives in TypeScript and moves
  -- with the permission matrix, so a database constraint on it would go stale silently and refuse a
  -- role that exists. Validation belongs in the service, which can read the live matrix.
  -- NULL means "no extra restriction" — the employee_documents permission alone decides, exactly as
  -- it does for a built-in document. An EMPTY array is not the same thing and means nobody.
  printable_by_roles text[],
  -- An optional filter over the employee, shape decided by the service. Null does nothing.
  applies_to jsonb,

  created_at timestamptz not null default now(),
  created_by_hr_id text,
  updated_at timestamptz not null default now(),
  updated_by_hr_id text,

  constraint hiring_pack_custom_templates_supersede_pair
    check ((superseded_on is null) = (superseded_by is null)),
  -- An archived version must say what replaced it; a current one must not claim to have been
  -- replaced. Without this, "which version prints today" has two possible answers.
  constraint hiring_pack_custom_templates_archived_has_successor
    check (
      (status = 'current' and superseded_by is null)
      or (status = 'archived' and superseded_by is not null)
    ),
  constraint hiring_pack_custom_templates_not_self_superseded
    check (superseded_by is null or superseded_by <> id)
);

comment on table public.hiring_pack_custom_templates is
  'Company templates uploaded through the HR Forms UI: one row per VERSION, mirroring template-registry.ts. `key` is the stable document identity (HiringPackDocument custom:<key>); `id` is this version''s identity and is the template_version_id the field layer scopes to. Archived versions are never deleted — a paper somebody signed has to stay reproducible as the document they signed.';

comment on column public.hiring_pack_custom_templates.key is
  'Stable across versions. custom:<key> is the HiringPackDocument value, the slot `contract` or `form1` occupies for a built-in.';
comment on column public.hiring_pack_custom_templates.printable_by_roles is
  'Extra restriction ON TOP of the employee_documents permission. NULL means no extra restriction; an empty array means nobody.';

-- EXACTLY ONE CURRENT VERSION PER TEMPLATE, enforced here rather than in the service. Two current
-- versions is not a state any screen can resolve: it means two different papers both claim to be
-- this template, and picking either one silently is how the wrong artwork reaches a signature page.
-- `currentTemplateVersion` throws on that for the built-ins; a partial unique index is the same
-- guarantee for rows, and it holds against hand-run SQL as well as against the service.
create unique index if not exists hiring_pack_custom_templates_one_current
  on public.hiring_pack_custom_templates (key)
  where status = 'current';

-- One version number per template, so "version 2" names one paper.
create unique index if not exists hiring_pack_custom_templates_version_unique
  on public.hiring_pack_custom_templates (key, version);

-- The list screen: every current template, newest first.
create index if not exists hiring_pack_custom_templates_current_idx
  on public.hiring_pack_custom_templates (status, created_at desc);

-- ── The pages ─────────────────────────────────────────────────────────────────────────────────
-- One row per printed SIDE. A government form is routinely two sides and the mutual-termination
-- agreement is three pages, so a template that could only hold one image would be unable to
-- represent most of the papers this module already prints.
create table if not exists public.hiring_pack_custom_template_pages (
  id uuid primary key default gen_random_uuid(),

  -- CASCADE, and this is the one place a cascade is right in this feature: a page has no meaning
  -- without its version, and the delete it fires on cannot happen to an archived version at all —
  -- the trigger below refuses that. So the only thing this can erase is the pages of a template
  -- that was uploaded by mistake and never superseded anything.
  template_id uuid not null references public.hiring_pack_custom_templates (id) on delete cascade,

  -- Zero-based, matching the `page` column on the field layer so a coordinate means the same thing
  -- on both sides of the join.
  page_index integer not null check (page_index >= 0),

  storage_bucket text not null default 'hiring-pack-templates',
  -- Unique because two rows pointing at one object would let deleting either strand or destroy the
  -- other's artwork. The path carries a random suffix precisely so this can be enforced.
  storage_path text not null unique,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),

  -- The image's own pixel size. Kept because the editor needs the intrinsic size to scale the
  -- artwork to the page's point size, and reading it back off the object would mean fetching a
  -- multi-megabyte PNG to learn two integers.
  width_px integer not null check (width_px > 0),
  height_px integer not null check (height_px > 0),

  created_at timestamptz not null default now(),

  constraint hiring_pack_custom_template_pages_one_per_index unique (template_id, page_index)
);

comment on table public.hiring_pack_custom_template_pages is
  'One row per printed side of a custom template. storage_path points into the private hiring-pack-templates bucket; the artwork is served through an authenticated route, never a public URL.';

create index if not exists hiring_pack_custom_template_pages_order_idx
  on public.hiring_pack_custom_template_pages (template_id, page_index);

-- ── An archived version is never deleted ──────────────────────────────────────────────────────
-- The owner's rule, 2026-08-30: "make the other contract go to archived instead of removing it from
-- system … and any paper I replace, it goes to the archive." An archived row is by definition a
-- paper that was live and was replaced, so something may have been signed against it. Deleting it
-- does not tidy anything — it destroys the only record of what the signed document looked like, and
-- silently, because the reprint still produces a plausible-looking paper from the CURRENT artwork.
--
-- A TRIGGER RATHER THAN A REVOKE, for the reason the field-history table already documents: a revoke
-- does not bind the table OWNER, and every write path here runs as the service role or as postgres.
-- A template uploaded by mistake and never superseded is still deletable, which is the case this
-- deliberately leaves open.
create or replace function public.hiring_pack_custom_templates_archived_is_permanent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'hiring_pack_custom_templates: version % of template % is archived and cannot be deleted. A superseded paper has to stay reproducible as the document somebody signed.',
    old.version, old.key
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.hiring_pack_custom_templates_archived_is_permanent() is
  'Refuses deletion of an archived custom-template version. The owner''s archive rule, enforced in the database because a revoke does not bind the table owner and every write path here runs as owner or service_role.';

drop trigger if exists hiring_pack_custom_templates_no_archived_delete
  on public.hiring_pack_custom_templates;
create trigger hiring_pack_custom_templates_no_archived_delete
  before delete on public.hiring_pack_custom_templates
  for each row
  when (old.status = 'archived')
  execute function public.hiring_pack_custom_templates_archived_is_permanent();

-- ── updated_at ────────────────────────────────────────────────────────────────────────────────
create or replace function public.set_hiring_pack_custom_templates_updated_at()
returns trigger
language plpgsql
-- PARALLEL SAFE is a correctness declaration in this database, not a performance hint: a function
-- left UNSAFE by default silently disables parallel query for anything that touches it.
parallel safe
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hiring_pack_custom_templates_touch_updated_at
  on public.hiring_pack_custom_templates;
create trigger hiring_pack_custom_templates_touch_updated_at
  before update on public.hiring_pack_custom_templates
  for each row
  execute function public.set_hiring_pack_custom_templates_updated_at();

-- ── Grants ────────────────────────────────────────────────────────────────────────────────────
-- Both functions above are SECURITY DEFINER or new in `public`, so both give up the EXECUTE that
-- PostgreSQL grants to PUBLIC on every new function here. REVOKING FROM anon AND authenticated
-- ALONE IS A NO-OP — both are members of PUBLIC and inherit the grant through it, which is how the
-- analytics_* overloads leaked to the anonymous key. Enforced for every migration from
-- 20260719170000 forward by tests/migrations-secdef-revoke-guard.test.ts.
revoke execute on function public.hiring_pack_custom_templates_archived_is_permanent() from public;
revoke execute on function public.set_hiring_pack_custom_templates_updated_at() from public;

-- RLS on with no policies, the same posture as the field layer these templates are placed with.
-- Visibility in this application is application-scoped: every read goes through the service-role
-- client behind assertPermission(ctx, 'employee_documents', …). A browser must never reach these
-- rows directly, because the artwork of a company paper is not the browser's to change.
alter table public.hiring_pack_custom_templates enable row level security;
alter table public.hiring_pack_custom_template_pages enable row level security;
revoke all on public.hiring_pack_custom_templates from anon, authenticated;
revoke all on public.hiring_pack_custom_template_pages from anon, authenticated;

commit;

-- ── The bucket ────────────────────────────────────────────────────────────────────────────────
-- Outside the transaction because storage is a platform-managed schema: on a project where it is
-- absent this block does nothing rather than failing the whole migration.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'hiring-pack-templates',
      'hiring-pack-templates',
      -- PRIVATE, and for a reason that is not the obvious one. The artwork of a blank company form
      -- is not itself confidential — but a public bucket URL is guessable and permanent, and this
      -- is the surface a printed paper's appearance comes from. It is served instead through
      -- /api/hiring-pack/template-artwork/[pageId], which checks the same permission as the print
      -- route, so the caller never names a storage object.
      false,
      -- 15MB, matching the hiring-documents bucket. An A4 page rasterised at 300dpi lands around
      -- 2-6MB as a PNG; below this an ordinary scan would be refused, above it one bad upload fills
      -- the bucket.
      15728640,
      -- IMAGES ONLY, and no application/pdf — deliberately narrower than hiring-documents. A PDF is
      -- rasterised in the BROWSER before it is uploaded, one PNG per page, because the alternative
      -- is a native rasteriser in the server bundle and this repo has already been burned once by a
      -- top-level `import sharp` 500ing a whole page when its .so was missing. Accepting a PDF here
      -- would mean accepting a file nothing on the server can turn into artwork.
      array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists hiring_pack_templates_service_role on storage.objects';
    execute $policy$
      create policy hiring_pack_templates_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'hiring-pack-templates')
      with check (bucket_id = 'hiring-pack-templates')
    $policy$;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ── VERIFY (run after applying; each answers on its own — the MCP returns only the LAST result
--    set of a multi-statement call, so a block that verifies in statement one and summarises in two
--    certifies a check nobody saw) ───────────────────────────────────────────────────────────────
--
--   select to_regclass('public.hiring_pack_custom_templates'),
--          to_regclass('public.hiring_pack_custom_template_pages');
--   -- expect: both, not null. The ledger is not the database.
--
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'hiring_pack_custom_templates';
--   -- expect: _pkey, _one_current, _version_unique, _current_idx.
--
--   select id, name from storage.buckets where id = 'hiring-pack-templates';
--   -- expect: one row. Absent means the storage schema was missing when this ran.
--
--   select p.proname, pg_catalog.array_to_string(p.proacl, ' | ')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('hiring_pack_custom_templates_archived_is_permanent',
--                        'set_hiring_pack_custom_templates_updated_at');
--   -- expect: postgres and service_role only. A bare `=X/postgres` entry is the PUBLIC grant still
--   -- standing, which is the leak the revokes above close.
--
-- The archive rule, which must ERROR — run it against a row you have deliberately archived:
--   delete from public.hiring_pack_custom_templates where status = 'archived';
--
-- REPLACING A TEMPLATE — the only order the three rules above permit, and it needs one transaction:
--
--   begin;
--   -- the new version's id is generated here, before its row exists; the deferred FK allows that
--   update public.hiring_pack_custom_templates
--      set status = 'archived', superseded_on = current_date, superseded_by = :new_id
--    where key = :key and status = 'current';
--   insert into public.hiring_pack_custom_templates (id, key, name, page_width_pt, page_height_pt,
--                                                    version, status)
--   values (:new_id, :key, :name, :w, :h, :next_version, 'current');
--   commit;
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Additive. Nothing existing is touched, so dropping these restores the previous shape exactly:
--
--   drop table if exists public.hiring_pack_custom_template_pages;
--   drop table if exists public.hiring_pack_custom_templates;
--   drop function if exists public.hiring_pack_custom_templates_archived_is_permanent();
--   drop function if exists public.set_hiring_pack_custom_templates_updated_at();
--
-- The bucket and its objects are NOT dropped by that, on purpose: deleting a bucket deletes the
-- artwork of every template anybody uploaded, and production has no PITR — seven daily physical
-- backups at one-day granularity, restoring the WHOLE database. Empty it deliberately or leave it.
