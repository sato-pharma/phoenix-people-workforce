-- Hiring pack — a record of what a field used to say.
--
-- ── THE FAILURE THIS CLOSES ─────────────────────────────────────────────────────────────────────
--
-- Editing a field in the field table changes the TEMPLATE: the rule for every person the document is
-- printed for. A save OVERWRITES — `updated_at` and `updated_by_hr_id` are rewritten and the previous
-- rule is gone. On papers people sign, "what did this field print in September" has no answer at all,
-- and "Reset this document" deletes every row without leaving a trace of what it deleted.
--
-- ── WHY A TRIGGER AND NOT APPLICATION CODE ──────────────────────────────────────────────────────
--
-- There are four write paths today — save, delete, reset, carry-forward — and the reset is a bulk
-- delete that does not pass through the single-row path at all. An app-level history would have to be
-- remembered at each one, and the next path added would silently not be recorded. A trigger is
-- written once and cannot be forgotten, including by a hand-run SQL statement during an incident,
-- which is exactly when the record matters most.
--
-- ── WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT ──────────────────────────────────────────────
--
-- SUPERSESSIONS ONLY: update and delete. An insert has no previous state to hold, and the live row's
-- own `created_at` already says when the field was added — recording an all-null "previous" row for
-- every insert would double the table to say nothing.
--
-- THE ACTOR IS RECORDED ON AN UPDATE AND LEFT NULL ON A DELETE, on purpose. On an update the incoming
-- row carries the person making the change. On a delete there is no incoming row, and the only name
-- available is whoever last EDITED the field — which is not who deleted it. This system already knows
-- that `updated_by_hr_id` lies about who wrote a row; writing a name that is wrong is worse than
-- writing none, because a wrong name gets defended rather than looked up. The UI therefore leads with
-- the timestamp, which is the trustworthy half.
--
-- ── NO FOREIGN KEY TO THE FIELD ROW, AND THAT IS THE WHOLE POINT ────────────────────────────────
--
-- `field_id` names the row this is the history of, and it is deliberately NOT a foreign key. With
-- ON DELETE CASCADE the database would erase precisely the record a deletion exists to leave behind
-- — and a cascade runs as the table OWNER, so it would go straight through the append-only revokes
-- below without touching them. With ON DELETE RESTRICT the history would instead make its own subject
-- undeletable. A history that cannot outlive its subject is not a history.
--
-- ── APPEND-ONLY IS ENFORCED BY TRIGGERS, NOT BY REVOKES ─────────────────────────────────────────
--
-- A write REVOKE does not make a table read-only here. `TRUNCATE` fires no ROW triggers, and neither
-- a revoke nor a row trigger binds the table owner. So all three verbs are refused by triggers — a
-- row trigger for update and delete, a STATEMENT-level BEFORE TRUNCATE trigger for truncate — which
-- fire for every role including the owner. The revokes are kept underneath as a second lock.
--
-- ── NOT YET APPLIED TO PRODUCTION ───────────────────────────────────────────────────────────────
--
-- Applying a migration to the production database is one of the two actions that need the owner's
-- separate approval, and it has not been given. ADDITIVE when it is: one new table, two new
-- functions, three new triggers, no existing row touched and nothing dropped. The one behavioural
-- change to an existing object is that updates and deletes on `hiring_pack_document_fields` now also
-- write a history row; they are not otherwise altered, and neither is blocked.

begin;

create table if not exists public.hiring_pack_document_field_history (
  id uuid primary key default gen_random_uuid(),
  -- The field row this supersedes. NOT a foreign key — see the header.
  field_id uuid not null,
  -- Denormalised from the superseded row so the history reads on its own after the field is gone.
  document text not null,
  template_version_id text not null,
  employee_hr_id text,
  default_key text,
  -- 'update' or 'delete' — what happened TO the state held in this row.
  action text not null,

  -- ── THE PREVIOUS STATE, EXACTLY AS IT STOOD ──────────────────────────────────────────────────
  -- Every column the editor can change, so a history row can answer "what did this print" without
  -- reconstructing it from a chain of diffs. The whole state per row costs a few hundred bytes
  -- against a table that gains a row only when somebody edits a form.
  hidden boolean not null,
  page smallint,
  anchor_selector text,
  anchor_dx numeric(8, 2),
  anchor_dy numeric(8, 2),
  x numeric(8, 2) not null,
  y numeric(8, 2) not null,
  w numeric(8, 2) not null,
  h numeric(8, 2) not null,
  align text not null,
  font_size numeric(5, 2) not null,
  source_kind text not null,
  value_key text,
  literal_text text,

  -- When the superseded state was itself written, and by whom. Copied off the old row: this is the
  -- span the state was live for, paired with `changed_at` below.
  was_updated_at timestamptz not null,
  was_updated_by_hr_id text,

  -- When it stopped being true. The trustworthy half — see the header.
  changed_at timestamptz not null default now(),
  -- Who superseded it, on an update. NULL on a delete, deliberately — see the header.
  changed_by_hr_id text,

  constraint hiring_pack_document_field_history_action_known check (action in ('update', 'delete')),
  constraint hiring_pack_document_field_history_actor_upper check (
    changed_by_hr_id is null or changed_by_hr_id = upper(changed_by_hr_id)
  ),
  constraint hiring_pack_document_field_history_was_actor_upper check (
    was_updated_by_hr_id is null or was_updated_by_hr_id = upper(was_updated_by_hr_id)
  )
);

comment on table public.hiring_pack_document_field_history is
  'Append-only record of every superseded state of a hiring-pack field row: one row per update and per delete, holding the PREVIOUS source and geometry in full. Written by a trigger on hiring_pack_document_fields so no write path can forget it, including a bulk reset and hand-run SQL. field_id is deliberately NOT a foreign key — a cascade would erase exactly what a deletion exists to record, and it would run as the table owner, straight past the revokes. Inserts are not recorded: the live row''s created_at already says when a field was added. changed_by_hr_id is NULL on a delete on purpose — the only name available there is whoever last edited the field, not who deleted it.';

comment on column public.hiring_pack_document_field_history.changed_by_hr_id is
  'Who superseded this state, on an update only. NULL on a delete: there is no incoming row to read an actor off, and the last editor is not the deleter. Read the timestamp, not the name — updated_by_hr_id is known to be unreliable across this system.';

-- The read behind "changed 12 Sep, 14:20" on one row of the field table: one field, newest first.
create index if not exists hiring_pack_document_field_history_field_idx
  on public.hiring_pack_document_field_history (field_id, changed_at desc);

-- The read behind a whole document's history, which is also how a reset is reviewed afterwards:
-- every row a reset deleted shares one changed_at to the millisecond.
create index if not exists hiring_pack_document_field_history_document_idx
  on public.hiring_pack_document_field_history (document, template_version_id, changed_at desc);

-- ── THE RECORDER ────────────────────────────────────────────────────────────────────────────────

create or replace function public.hiring_pack_document_field_history_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.hiring_pack_document_field_history (
    field_id, document, template_version_id, employee_hr_id, default_key, action,
    hidden, page, anchor_selector, anchor_dx, anchor_dy,
    x, y, w, h, align, font_size, source_kind, value_key, literal_text,
    was_updated_at, was_updated_by_hr_id, changed_by_hr_id
  ) values (
    old.id, old.document, old.template_version_id, old.employee_hr_id, old.default_key,
    lower(tg_op),
    old.hidden, old.page, old.anchor_selector, old.anchor_dx, old.anchor_dy,
    old.x, old.y, old.w, old.h, old.align, old.font_size,
    old.source_kind, old.value_key, old.literal_text,
    old.updated_at, old.updated_by_hr_id,
    -- On an update the incoming row names the person doing it. On a delete there is no incoming row,
    -- and the last editor is not the deleter — so NULL rather than a name that would be wrong.
    case when tg_op = 'UPDATE' then new.updated_by_hr_id else null end
  );
  -- AFTER trigger: the return value is ignored, and the recorder can never block the edit it records.
  return null;
end;
$$;

comment on function public.hiring_pack_document_field_history_record() is
  'Writes the superseded state of a hiring-pack field row into hiring_pack_document_field_history. AFTER trigger, so recording can never block an edit. SECURITY DEFINER so the history is written even where the caller could not insert into it directly — which is every caller, since the table takes no writes from anyone but this function.';

drop trigger if exists hiring_pack_document_fields_history on public.hiring_pack_document_fields;
create trigger hiring_pack_document_fields_history
  after update or delete on public.hiring_pack_document_fields
  for each row execute function public.hiring_pack_document_field_history_record();

-- ── APPEND-ONLY ─────────────────────────────────────────────────────────────────────────────────

create or replace function public.hiring_pack_document_field_history_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'hiring_pack_document_field_history is append-only: % is refused. It is the only record of what a field used to print.',
    tg_op
    using errcode = 'restrict_violation';
  return null;
end;
$$;

comment on function public.hiring_pack_document_field_history_is_append_only() is
  'Refuses update, delete and truncate on the field history. A trigger rather than a revoke because neither a revoke nor a row trigger binds the table OWNER, and TRUNCATE fires no row triggers at all — so the three verbs need a row trigger and a statement-level BEFORE TRUNCATE trigger between them.';

drop trigger if exists hiring_pack_document_field_history_no_change
  on public.hiring_pack_document_field_history;
create trigger hiring_pack_document_field_history_no_change
  before update or delete on public.hiring_pack_document_field_history
  for each row execute function public.hiring_pack_document_field_history_is_append_only();

-- STATEMENT-level, because TRUNCATE fires no row triggers — the row trigger above sees nothing.
drop trigger if exists hiring_pack_document_field_history_no_truncate
  on public.hiring_pack_document_field_history;
create trigger hiring_pack_document_field_history_no_truncate
  before truncate on public.hiring_pack_document_field_history
  for each statement execute function public.hiring_pack_document_field_history_is_append_only();

-- The second lock. Not sufficient on its own — a revoke does not bind the owner — but it turns a
-- mistake by any other role into a permission error before the trigger has to raise.
revoke update, delete, truncate on public.hiring_pack_document_field_history from public;
revoke update, delete, truncate on public.hiring_pack_document_field_history from anon;
revoke update, delete, truncate on public.hiring_pack_document_field_history from authenticated;
revoke update, delete, truncate on public.hiring_pack_document_field_history from service_role;

-- RLS on with no policies, matching the field layer it records. Every read goes through the
-- service-role client behind assertPermission; a browser must never reach these rows directly.
alter table public.hiring_pack_document_field_history enable row level security;

commit;

-- ── VERIFY (run after applying; each answers on its own) ────────────────────────────────────────
--
--   select to_regclass('public.hiring_pack_document_field_history');
--   -- expect: the table itself, not null. The ledger is not the database.
--
--   select tgname, tgtype from pg_trigger
--    where tgrelid = 'public.hiring_pack_document_field_history'::regclass and not tgisinternal;
--   -- expect: two rows — _no_change and _no_truncate.
--
--   select tgname from pg_trigger
--    where tgrelid = 'public.hiring_pack_document_fields'::regclass and not tgisinternal;
--   -- expect: hiring_pack_document_fields_history.
--
-- All three refusals, each of which must ERROR:
--   update public.hiring_pack_document_field_history set action = 'update';
--   delete from public.hiring_pack_document_field_history;
--   truncate public.hiring_pack_document_field_history;
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Additive. Dropping the trigger stops the recording; dropping the table DISCARDS every recorded
-- state permanently, and production has no PITR — seven daily physical backups at one-day
-- granularity, restoring the WHOLE database. Read the count first:
--
--   select document, action, count(*) from public.hiring_pack_document_field_history
--    group by 1, 2 order by 1, 2;
--
-- begin;
--   drop trigger if exists hiring_pack_document_fields_history on public.hiring_pack_document_fields;
--   drop function if exists public.hiring_pack_document_field_history_record();
--   drop table if exists public.hiring_pack_document_field_history;
--   drop function if exists public.hiring_pack_document_field_history_is_append_only();
-- commit;
