-- =============================================================================
-- DRAFT — PHASE 3B — DO NOT APPLY YET.
-- Workflow Control Center: persistence + versioning + publish + rollback.
-- =============================================================================
-- Apply ONLY via the staged db:phaseNN approval pipeline (CLAUDE.md).
--
-- Posture:
--   * All 5 tables ENABLE ROW LEVEL SECURITY.
--   * Only service_role policies are created.
--   * workflow_versions immutable after insert except superseded_* / notes.
--   * No data inserts. No production-specific identifiers.
-- =============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.workflow_definitions (
  id                  uuid primary key default gen_random_uuid(),
  domain_key          text not null,
  subflow_key         text not null,
  active_version_id   uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by_hr_id    text,
  updated_by_hr_id    text,
  constraint workflow_definitions_domain_subflow_unique unique (domain_key, subflow_key)
);

create index if not exists workflow_definitions_active_idx
  on public.workflow_definitions (active_version_id);

create index if not exists workflow_definitions_domain_subflow_idx
  on public.workflow_definitions (domain_key, subflow_key);

create table if not exists public.workflow_versions (
  id                        uuid primary key default gen_random_uuid(),
  definition_id             uuid not null references public.workflow_definitions(id) on delete restrict,
  version_number            int  not null,
  payload                   jsonb not null,
  payload_hash              text not null,
  published_at              timestamptz not null default now(),
  published_by_hr_id        text not null,
  notes                     text,
  superseded_at             timestamptz,
  superseded_by_version_id  uuid references public.workflow_versions(id) on delete set null,
  constraint workflow_versions_definition_version_unique unique (definition_id, version_number)
);

create index if not exists workflow_versions_definition_version_desc_idx
  on public.workflow_versions (definition_id, version_number desc);

create index if not exists workflow_versions_payload_hash_idx
  on public.workflow_versions (payload_hash);

alter table public.workflow_definitions
  add constraint workflow_definitions_active_version_fk
  foreign key (active_version_id)
  references public.workflow_versions(id)
  on delete set null;

create or replace function public.workflow_versions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.payload            is distinct from old.payload            then raise exception 'workflow_versions.payload is immutable';            end if;
  if new.payload_hash       is distinct from old.payload_hash       then raise exception 'workflow_versions.payload_hash is immutable';       end if;
  if new.version_number     is distinct from old.version_number     then raise exception 'workflow_versions.version_number is immutable';     end if;
  if new.published_at       is distinct from old.published_at       then raise exception 'workflow_versions.published_at is immutable';       end if;
  if new.published_by_hr_id is distinct from old.published_by_hr_id then raise exception 'workflow_versions.published_by_hr_id is immutable'; end if;
  if new.definition_id      is distinct from old.definition_id      then raise exception 'workflow_versions.definition_id is immutable';      end if;
  return new;
end
$$;

drop trigger if exists workflow_versions_block_mutation_trg on public.workflow_versions;
create trigger workflow_versions_block_mutation_trg
  before update on public.workflow_versions
  for each row execute function public.workflow_versions_block_mutation();

create table if not exists public.workflow_drafts (
  id                 uuid primary key default gen_random_uuid(),
  definition_id      uuid not null references public.workflow_definitions(id) on delete cascade,
  owner_hr_id        text not null,
  base_version_id    uuid references public.workflow_versions(id) on delete set null,
  payload            jsonb not null,
  validation_status  text not null default 'valid'
                       check (validation_status in ('valid','warnings','invalid')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint workflow_drafts_definition_owner_unique unique (definition_id, owner_hr_id)
);

create index if not exists workflow_drafts_definition_owner_idx
  on public.workflow_drafts (definition_id, owner_hr_id);

create table if not exists public.workflow_publish_history (
  id              uuid primary key default gen_random_uuid(),
  definition_id   uuid not null references public.workflow_definitions(id) on delete cascade,
  event           text not null check (event in ('publish','rollback','revert')),
  from_version_id uuid references public.workflow_versions(id) on delete set null,
  to_version_id   uuid references public.workflow_versions(id) on delete set null,
  diff_summary    jsonb not null,
  actor_hr_id     text not null,
  reason          text,
  occurred_at     timestamptz not null default now()
);

create index if not exists workflow_publish_history_definition_idx
  on public.workflow_publish_history (definition_id, occurred_at desc);

create table if not exists public.workflow_audit_logs (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid,
  version_id    uuid,
  draft_id      uuid,
  action        text not null,
  actor_hr_id   text,
  actor_role    text,
  payload_hash  text,
  metadata      jsonb,
  occurred_at   timestamptz not null default now()
);

create index if not exists workflow_audit_logs_definition_idx
  on public.workflow_audit_logs (definition_id, occurred_at desc);

alter table public.workflow_definitions      enable row level security;
alter table public.workflow_versions         enable row level security;
alter table public.workflow_drafts           enable row level security;
alter table public.workflow_publish_history  enable row level security;
alter table public.workflow_audit_logs       enable row level security;

drop policy if exists workflow_definitions_service_role     on public.workflow_definitions;
drop policy if exists workflow_versions_service_role        on public.workflow_versions;
drop policy if exists workflow_drafts_service_role          on public.workflow_drafts;
drop policy if exists workflow_publish_history_service_role on public.workflow_publish_history;
drop policy if exists workflow_audit_logs_service_role      on public.workflow_audit_logs;

create policy workflow_definitions_service_role
  on public.workflow_definitions
  for all
  to service_role
  using (true)
  with check (true);

create policy workflow_versions_service_role
  on public.workflow_versions
  for all
  to service_role
  using (true)
  with check (true);

create policy workflow_drafts_service_role
  on public.workflow_drafts
  for all
  to service_role
  using (true)
  with check (true);

create policy workflow_publish_history_service_role
  on public.workflow_publish_history
  for all
  to service_role
  using (true)
  with check (true);

create policy workflow_audit_logs_service_role
  on public.workflow_audit_logs
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================================
-- ROLLBACK SQL (reference only; DO NOT EXECUTE as part of this migration).
-- -----------------------------------------------------------------------------
/*
drop policy if exists workflow_audit_logs_service_role      on public.workflow_audit_logs;
drop policy if exists workflow_publish_history_service_role on public.workflow_publish_history;
drop policy if exists workflow_drafts_service_role          on public.workflow_drafts;
drop policy if exists workflow_versions_service_role        on public.workflow_versions;
drop policy if exists workflow_definitions_service_role     on public.workflow_definitions;

drop trigger if exists workflow_versions_block_mutation_trg on public.workflow_versions;
drop function if exists public.workflow_versions_block_mutation();

alter table if exists public.workflow_definitions
  drop constraint if exists workflow_definitions_active_version_fk;

drop table if exists public.workflow_audit_logs;
drop table if exists public.workflow_publish_history;
drop table if exists public.workflow_drafts;
drop table if exists public.workflow_versions;
drop table if exists public.workflow_definitions;
*/
-- =============================================================================
