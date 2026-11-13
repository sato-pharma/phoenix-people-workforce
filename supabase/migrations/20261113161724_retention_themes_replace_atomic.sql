-- retention_themes_replace_atomic
--
-- WHAT THIS CHANGES: three functions, no table and no data.
--   * phx_replace_retention_conversation_themes(conversation, themes) - locks the conversation row
--     and replaces its themes (delete, then insert) in ONE transaction.
--   * phx_update_retention_conversation(conversation, patch, themes, expected updated_at) - locks the
--     conversation row, refuses if it changed since the caller read it, applies the patch (only the
--     eight columns the register edits) and, when themes are given, replaces them - all or nothing.
--   * phx_create_retention_conversation(conversation, themes) - inserts the conversation (only the
--     fourteen columns the register writes on create) and its themes in ONE transaction.
-- WHY: src/lib/retention/service.ts replaced a conversation's themes with two separate calls - a
--   DELETE of every theme row, then an INSERT of the new set - and the update path wrote the
--   conversation itself with a third call before them, with no compare-and-set. A failure between
--   the delete and the insert lost the conversation's confidential themes for good, and a failure
--   after the update left the conversation edited with its old themes. Inside one function the
--   delete, the insert and the update commit together or not at all. Creating a conversation was
--   two calls as well (insert the conversation, then its themes): a failure between them left a
--   conversation with no themes, and a retry made a duplicate.
-- ROLLBACK: drop function if exists public.phx_create_retention_conversation(jsonb, jsonb);
--           drop function if exists public.phx_update_retention_conversation(uuid, jsonb, jsonb, timestamptz);
--           drop function if exists public.phx_replace_retention_conversation_themes(uuid, jsonb);
--   (and revert the service to the separate calls - the service needs these functions once deployed.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive or bulk: it only creates functions.

begin;

-- ---------------------------------------------------------------------------
-- 1. Replace a conversation's themes atomically.
--
-- p_themes is a jsonb ARRAY of {theme_key, sentiment, note}, already normalised and de-duplicated by
-- the service (normalizeThemes). An empty array clears the themes. The (conversation_id, theme_key,
-- sentiment) unique constraint still holds: a duplicate fails the whole call and nothing is lost.
-- ---------------------------------------------------------------------------
create or replace function public.phx_replace_retention_conversation_themes(
  p_conversation_id uuid,
  p_themes jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_inserted integer := 0;
begin
  if p_themes is null or jsonb_typeof(p_themes) <> 'array' then
    raise exception 'Retention themes must be a list.' using errcode = '22023';
  end if;

  -- The row lock serialises two editors of the same conversation, so one replacement cannot
  -- interleave with another and leave a mix of both sets.
  select id into v_id
  from public.hr_retention_conversations
  where id = p_conversation_id
  for update;
  if not found then
    raise exception 'That conversation no longer exists.' using errcode = 'P0002';
  end if;

  delete from public.hr_retention_conversation_themes
  where conversation_id = p_conversation_id;

  insert into public.hr_retention_conversation_themes (conversation_id, theme_key, sentiment, note)
  select p_conversation_id, theme.theme_key, theme.sentiment, theme.note
  from jsonb_to_recordset(p_themes) as theme(theme_key text, sentiment text, note text);
  get diagnostics v_inserted = row_count;

  return v_inserted;
end;
$$;

revoke execute on function public.phx_replace_retention_conversation_themes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.phx_replace_retention_conversation_themes(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Update a conversation and (optionally) its themes in one transaction.
--
-- p_patch carries ONLY the columns updateRetentionConversation builds; any other key is refused, so
-- this function can never be used to rewrite who a conversation was with, its kind or its author.
-- p_themes NULL means "leave the themes alone"; an array replaces them.
-- p_expected_updated_at is the updated_at the caller read; when it is given and the row has moved
-- on, the call is refused with its own message instead of silently overwriting the other edit.
-- ---------------------------------------------------------------------------
create or replace function public.phx_update_retention_conversation(
  p_conversation_id uuid,
  p_patch jsonb,
  p_themes jsonb,
  p_expected_updated_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed constant text[] := array[
    'updated_at',
    'summary',
    'retention_risk',
    'is_regrettable',
    'would_rejoin',
    'follow_up_action',
    'follow_up_due',
    'follow_up_done_at'
  ];
  v_unknown text;
  v_row public.hr_retention_conversations;
  v_new public.hr_retention_conversations;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'A retention conversation update must be an object.' using errcode = '22023';
  end if;

  select key into v_unknown
  from jsonb_object_keys(p_patch) as key
  where key <> all (v_allowed)
  limit 1;
  if v_unknown is not null then
    raise exception 'A retention conversation update cannot change "%".', v_unknown using errcode = '22023';
  end if;

  select * into v_row
  from public.hr_retention_conversations
  where id = p_conversation_id
  for update;
  if not found then
    raise exception 'That conversation no longer exists.' using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'This conversation was changed by someone else since you opened it. Reload it and try again.'
      using errcode = '40001';
  end if;

  -- Values not in the patch keep the row's own value (jsonb_populate_record with a non-null base).
  v_new := jsonb_populate_record(v_row, p_patch);

  update public.hr_retention_conversations set
    updated_at = case when p_patch ? 'updated_at' then v_new.updated_at else updated_at end,
    summary = case when p_patch ? 'summary' then v_new.summary else summary end,
    retention_risk = case when p_patch ? 'retention_risk' then v_new.retention_risk else retention_risk end,
    is_regrettable = case when p_patch ? 'is_regrettable' then v_new.is_regrettable else is_regrettable end,
    would_rejoin = case when p_patch ? 'would_rejoin' then v_new.would_rejoin else would_rejoin end,
    follow_up_action = case when p_patch ? 'follow_up_action' then v_new.follow_up_action else follow_up_action end,
    follow_up_due = case when p_patch ? 'follow_up_due' then v_new.follow_up_due else follow_up_due end,
    follow_up_done_at = case when p_patch ? 'follow_up_done_at' then v_new.follow_up_done_at else follow_up_done_at end
  where id = p_conversation_id
  returning * into v_row;

  if p_themes is not null then
    perform public.phx_replace_retention_conversation_themes(p_conversation_id, p_themes);
  end if;

  return v_row.updated_at;
end;
$$;

revoke execute on function public.phx_update_retention_conversation(uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.phx_update_retention_conversation(uuid, jsonb, jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Create a conversation and its themes in one transaction.
--
-- p_conversation carries ONLY the columns createRetentionConversation builds (the employee snapshot
-- the service read, the conversation's own fields and its author); any other key is refused, so the
-- id, the timestamps and the line snapshot always take their defaults. p_themes is the same jsonb
-- array the replacement takes; it is written through that function so the two can never disagree.
-- ---------------------------------------------------------------------------
create or replace function public.phx_create_retention_conversation(
  p_conversation jsonb,
  p_themes jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed constant text[] := array[
    'kind',
    'employee_hr_id',
    'employee_name',
    'job_title',
    'conducted_on',
    'conducted_by',
    'resignation_id',
    'retention_risk',
    'is_regrettable',
    'would_rejoin',
    'summary',
    'follow_up_action',
    'follow_up_due',
    'created_by'
  ];
  v_unknown text;
  v_id uuid;
begin
  if p_conversation is null or jsonb_typeof(p_conversation) <> 'object' then
    raise exception 'A retention conversation must be an object.' using errcode = '22023';
  end if;

  select key into v_unknown
  from jsonb_object_keys(p_conversation) as key
  where key <> all (v_allowed)
  limit 1;
  if v_unknown is not null then
    raise exception 'A new retention conversation cannot set "%".', v_unknown using errcode = '22023';
  end if;

  insert into public.hr_retention_conversations (
    kind,
    employee_hr_id,
    employee_name,
    job_title,
    conducted_on,
    conducted_by,
    resignation_id,
    retention_risk,
    is_regrettable,
    would_rejoin,
    summary,
    follow_up_action,
    follow_up_due,
    created_by
  )
  select
    r.kind,
    r.employee_hr_id,
    r.employee_name,
    r.job_title,
    r.conducted_on,
    r.conducted_by,
    r.resignation_id,
    r.retention_risk,
    r.is_regrettable,
    r.would_rejoin,
    r.summary,
    r.follow_up_action,
    r.follow_up_due,
    r.created_by
  from jsonb_populate_record(null::public.hr_retention_conversations, p_conversation) as r
  returning id into v_id;

  -- Same transaction: a theme that fails (a duplicate, a bad sentiment) rolls the conversation
  -- back with it, so a retry never finds a half-written one to duplicate.
  perform public.phx_replace_retention_conversation_themes(v_id, coalesce(p_themes, '[]'::jsonb));

  return v_id;
end;
$$;

revoke execute on function public.phx_create_retention_conversation(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.phx_create_retention_conversation(jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
