-- ─────────────────────────────────────────────────────────────────────────────
-- A record-level conversation thread — for direct orders and marketing requests.
--
-- WHY THIS EXISTS
--
-- The owner, 2026-09-22: "I want to make the conversation option in direct orders and marketing
-- requests at any status even if rejected, for everyone to know the reason and be clarified — every
-- conversation action sends emails, Telegram and in-app."
--
-- Neither module had this. Direct orders carried only a comment attached to each approve/return/
-- reject DECISION — nothing anyone could add once a rung had acted. Marketing requests had an
-- "advisory comment", but only a CC reviewer on the CURRENTLY-ACTIVE step could write one, so the
-- moment a request was rejected / approved / closed / cancelled there was no active step and the box
-- refused every comment. So a requester could never ask why their request was turned down, and no
-- reviewer could answer.
--
-- ── WHY ONE GENERIC TABLE, KEYED BY (module, record_id) ──────────────────────
--
-- The weekly plan thread (employee_plan_comments) and the CV thread (ats_candidate_comments) each
-- built their own table, and the ADDRESSING rule that fans a message out was then copied into each
-- service until conversations/notify.ts pulled it back into one place (the owner's rule, 2026-09-03:
-- "in ANY conversation type in the system, email the submitter, cc the sender"). This table is the
-- storage half of that same "one conversation, many record types" idea: direct orders and marketing
-- requests are two record types that want the identical thread, so they share the row shape and the
-- append-only guarantee rather than minting two near-identical tables. `module` names the record
-- type; `record_id` is that record's own id (a uuid, held as text so a future non-uuid record type
-- costs no migration).
--
-- ── WHY APPEND-ONLY, LIKE employee_plan_comments AND NOT LIKE ats_candidate_comments ──
--
-- A conversation is a running record of who said what and when. UPDATE is refused by trigger so a
-- message cannot be silently rewritten under a reader who has already acted on it — the property the
-- immutable siblings exist to protect. There is deliberately no retract path: unlike a manager's
-- private note on a CV, a message here is addressed to the whole thread and emailed out the instant
-- it is posted, so "take it back" is not a coherent action once everyone has the email.
--
-- author_name and author_role are stamped AS AT the moment of writing, never joined at read time —
-- HR_IDs are reused when a seat is refilled, so a later join would eventually put one person's words
-- in their successor's mouth.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.record_conversation_comments (
  id            uuid        primary key default gen_random_uuid(),
  -- The record type. No enum: a CHECK keeps the two live modules honest while leaving the column
  -- cheap to extend for the next conversation-bearing record type.
  module        text        not null,
  -- The record's own id (a uuid today, held as text — see the table note). No foreign key: a record
  -- can be hard-deleted, and the discussion of why it was rejected should not vanish with it.
  record_id     text        not null,
  -- NULL means "not recorded", and must never be rendered as "system".
  author_hr_id  text,
  author_name   text,
  author_role   text,
  body          text        not null,
  created_at    timestamptz not null default now(),
  constraint record_conversation_comments_module_known
    check (module in ('direct_orders', 'marketing_requests')),
  -- An empty comment is not a comment. The 2000-char ceiling matches the plan and CV threads, so a
  -- person cannot type something in one conversation that another would refuse.
  constraint record_conversation_comments_body_not_blank check (btrim(body) <> ''),
  constraint record_conversation_comments_body_length check (char_length(body) <= 2000)
);

comment on table public.record_conversation_comments is
  'A record-level conversation thread for direct orders and marketing requests, available at ANY status. UPDATE is refused by trigger (append-only); there is no retract. author_* columns are stamped at write time, never joined at read time, because HR_IDs are reused when a seat is refilled. Owner rule, 2026-09-22.';
comment on column public.record_conversation_comments.module is
  'Record type: direct_orders | marketing_requests.';
comment on column public.record_conversation_comments.record_id is
  'The direct order / marketing request id (uuid, held as text).';
comment on column public.record_conversation_comments.author_hr_id is
  'HR_ID of whoever wrote it. NULL means "not recorded", never "system".';

create index if not exists record_conversation_comments_record_idx
  on public.record_conversation_comments (module, record_id, created_at);

alter table public.record_conversation_comments enable row level security;

drop policy if exists phx_record_conversation_comments_service_role on public.record_conversation_comments;
create policy phx_record_conversation_comments_service_role
  on public.record_conversation_comments
  to service_role using (true) with check (true);

grant all on table public.record_conversation_comments to service_role;

-- Deliberately NO grant to anon or authenticated. Visibility in this app is application-scoped —
-- every read goes through the service-role client behind a route that has already checked the
-- viewer can see the underlying record.

-- ── UPDATE is refused ─────────────────────────────────────────────────────────
-- Grants alone would leave service_role free to rewrite a message in place. The trigger is what
-- makes "never silently rewritten" true rather than merely intended.

create or replace function public.phx_record_conversation_comments_no_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'record_conversation_comments is append-only; a posted message cannot be edited'
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.phx_record_conversation_comments_no_update() from public, anon, authenticated;
grant execute on function public.phx_record_conversation_comments_no_update() to service_role;

drop trigger if exists record_conversation_comments_no_update on public.record_conversation_comments;
create trigger record_conversation_comments_no_update
  before update on public.record_conversation_comments
  for each row execute function public.phx_record_conversation_comments_no_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--
--   drop trigger if exists record_conversation_comments_no_update on public.record_conversation_comments;
--   drop function if exists public.phx_record_conversation_comments_no_update();
--   drop table if exists public.record_conversation_comments;
--
-- Dropping the table destroys every message written since it was applied — it is a new table with no
-- other reader, so nothing else breaks, but the words are gone. Take a copy first if any exist.
-- ─────────────────────────────────────────────────────────────────────────────
