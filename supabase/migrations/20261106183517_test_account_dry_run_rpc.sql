-- test_account_dry_run_rpc
--
-- WHAT THIS CHANGES: adds public.phx_test_dry_run_rpc(p_function text, p_args jsonb), callable by
-- service_role only. It runs one public function exactly as PostgREST would call it — same named
-- arguments, same search_path — inside a sub-transaction, keeps its answer, then raises and rolls the
-- sub-transaction back, so every check and every refusal inside the function runs and nothing it
-- wrote is kept. A function declared STABLE or IMMUTABLE is NOT run: the answer says
-- {"passthrough": true} and the caller sends the real call, which cannot write.
-- WHY: owner, 2026-11-06 — a test account runs every save in the system fully and saves nothing
-- ("Runs fully, saves nothing"). Its table writes are answered in the app (src/lib/auth/test-dry-run.ts);
-- a database function cannot be, because only the database knows what it returns, so the app sends
-- a test account's VOLATILE function calls here instead.
-- ROLLBACK: drop function if exists public.phx_test_dry_run_rpc(text, jsonb);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new function, no table, no row.

begin;

create or replace function public.phx_test_dry_run_rpc(p_function text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_keys text[];
  v_candidate record;
  v_chosen record;
  v_input_names text[];
  v_input_types oid[];
  v_required int;
  v_ok boolean;
  v_list text := '';
  v_i int;
  v_name text;
  v_type oid;
  v_type_text text;
  v_is_array boolean;
  v_call text;
  v_sql text;
  v_kind text;
  v_result jsonb;
  v_found boolean := false;
begin
  if p_function is null or p_function !~ '^[a-z_][a-z0-9_]{0,62}$' then
    raise exception 'phx_test_dry_run_rpc: not a function name' using errcode = '22023';
  end if;
  if jsonb_typeof(v_args) <> 'object' then
    raise exception 'phx_test_dry_run_rpc: arguments must be an object' using errcode = '22023';
  end if;
  select coalesce(array_agg(k), '{}') into v_keys from jsonb_object_keys(v_args) as k;

  -- Choose the overload PostgREST would: every key named is one of its inputs, and every input with
  -- no default is named. A single unnamed json/jsonb input takes the whole body.
  for v_candidate in
    select p.oid, p.provolatile, p.proretset, p.prorettype, p.pronargs, p.pronargdefaults,
           p.proargnames, p.proargmodes,
           array(select t from unnest(p.proargtypes) with ordinality as u(t, ord) order by ord) as input_types -- 1-based; an oidvector is 0-based
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = p_function and p.prokind = 'f'
  loop
    v_input_types := v_candidate.input_types;
    if v_candidate.proargmodes is null then
      v_input_names := coalesce(v_candidate.proargnames[1:v_candidate.pronargs], '{}');
    else
      select coalesce(array_agg(nm order by ord), '{}') into v_input_names
        from unnest(v_candidate.proargnames, v_candidate.proargmodes::text[]) with ordinality as a(nm, md, ord)
       where md in ('i', 'b', 'v');
    end if;

    if v_candidate.pronargs = 1 and coalesce(v_input_names[1], '') = ''
       and v_input_types[1] in ('json'::regtype, 'jsonb'::regtype) then
      v_chosen := v_candidate;
      v_found := true;
      exit;
    end if;

    v_required := v_candidate.pronargs - v_candidate.pronargdefaults;
    v_ok := v_keys <@ v_input_names;
    if v_ok and v_required > 0 then
      v_ok := v_input_names[1:v_required] <@ v_keys;
    end if;
    if v_ok then
      v_chosen := v_candidate;
      v_found := true;
      exit;
    end if;
  end loop;

  if not v_found then
    raise exception 'Could not find the function public.%(%) in the schema cache', p_function, array_to_string(v_keys, ', ')
      using errcode = '42883';
  end if;

  if v_chosen.provolatile <> 'v' then
    return jsonb_build_object('passthrough', true);
  end if;

  if v_chosen.pronargs = 1 and coalesce(v_input_names[1], '') = ''
     and v_input_types[1] in ('json'::regtype, 'jsonb'::regtype) then
    v_list := format('($1)::%s', pg_catalog.format_type(v_input_types[1], null));
  else
    for v_i in 1 .. coalesce(array_length(v_input_names, 1), 0) loop
      v_name := v_input_names[v_i];
      continue when not (v_args ? v_name);
      v_type := v_input_types[v_i];
      v_type_text := pg_catalog.format_type(v_type, null);
      select t.typcategory = 'A' into v_is_array from pg_catalog.pg_type t where t.oid = v_type;
      if v_list <> '' then v_list := v_list || ', '; end if;
      if v_type in ('json'::regtype, 'jsonb'::regtype) then
        v_list := v_list || format('%I => ($1 -> %L)::%s', v_name, v_name, v_type_text);
      elsif v_is_array and jsonb_typeof(v_args -> v_name) = 'array' then
        -- A JSON array becomes a Postgres array of the input's type ([] stays an empty array).
        v_list := v_list || format(
          '%I => coalesce((select array_agg(e) from jsonb_array_elements_text($1 -> %L) as e), ''{}'')::%s',
          v_name, v_name, v_type_text);
      else
        -- A scalar, a null, or an array written as text ('{a,b}') is cast as written.
        v_list := v_list || format('%I => ($1 ->> %L)::%s', v_name, v_name, v_type_text);
      end if;
    end loop;
  end if;

  v_call := format('public.%I(%s)', p_function, v_list);
  if v_chosen.prorettype = 'void'::regtype then
    v_kind := 'void';
    v_sql := format('select null::jsonb from (select %s) as call', v_call);
  elsif v_chosen.proretset then
    v_kind := 'set';
    v_sql := format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from %s as r', v_call);
  else
    v_kind := 'single';
    v_sql := format('select to_jsonb(%s)', v_call);
  end if;

  -- The sub-transaction: run it, keep the answer in a variable (variables are not rolled back), then
  -- undo every row it wrote. Any error of the function's own escapes as itself — a refusal is real.
  begin
    execute v_sql using v_args into v_result;
    raise exception 'phx_test_dry_run_rpc rollback' using errcode = 'PXDRY';
  exception when sqlstate 'PXDRY' then
    null;
  end;

  return jsonb_build_object('passthrough', false, 'kind', v_kind, 'value', v_result);
end;
$$;

revoke execute on function public.phx_test_dry_run_rpc(text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_test_dry_run_rpc(text, jsonb) to service_role;

comment on function public.phx_test_dry_run_rpc(text, jsonb) is
  'Test accounts (owner, 2026-11-06): runs one VOLATILE public function as PostgREST would, rolls back everything it wrote, and returns its answer. STABLE/IMMUTABLE answer {"passthrough": true}. service_role only. App side: src/lib/auth/test-dry-run.ts.';

commit;
