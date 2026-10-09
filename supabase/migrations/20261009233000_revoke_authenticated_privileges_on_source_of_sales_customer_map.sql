-- Take every privilege on public.source_of_sales_customer_map away from `authenticated`, and change
-- nothing else.
--
-- WHAT
--   `authenticated` holds the full privilege set (arwdDxtm) on this table. RLS is ENABLED on it and it
--   has ZERO policies, so every statement a logged-in browser role issues is denied by RLS anyway:
--   a SELECT returns no rows, an INSERT/UPDATE/DELETE fails with a row-level-security violation.
--   The grant therefore cannot be used for anything. This revokes it, so the denial is a plain
--   `permission denied` instead of a silent empty result.
--
-- WHY IT IS SAFE (all checked against production on 2026-10-09)
--   - Every read and write of this table in src/ and app/ goes through getSupabaseAdmin(), the
--     service-role client (25 files); the rest of the 40 files that name it are scripts using the
--     service key, comments, or audit labels. The only code that builds a USER-token client
--     (src/lib/supabase/rls-server.ts) is imported by dashboard invalidation, outstation and payroll,
--     none of which touches this table.
--   - `authenticated` cannot EXECUTE any of the 22 functions that read it (18 SECURITY DEFINER, 4
--     invoker), and neither can `anon`, so no RPC path reaches it as a browser role.
--   - No file in supabase/ or tests/ grants this table to `authenticated` (its origin was not found,
--     so it reads as drift, not as a decision). Fourteen sibling source_of_sales_* tables carry no
--     `authenticated` grant at all, five of them (brick_move_files, customer_ai_answers,
--     distributor_certification, mapping_audit, product_price_history) with no policy, like this
--     one. That is the shape this restores.
--
-- THE ONE SIDE EFFECT, STATED PLAINLY
--   public.source_of_sales_block_groups is a security_invoker view granted to `authenticated` whose
--   definition counts rows of this table. For a browser role those counts have always read 0, because
--   RLS hides every row. After this revoke, `select *` on that view as `authenticated` fails with
--   `permission denied for table source_of_sales_customer_map` instead (measured on staging; a bare
--   `count(*)` still passes, because the planner drops the unused subqueries). Nothing in src/, app/
--   or lib/ reads that view, so no working path changes; it is the same dead result, now loud.
--   service_role is unaffected.
--
-- WHAT THIS DOES NOT CHANGE
--   RLS stays enabled with zero policies (the block asserts it). `rls_enabled_no_policy` therefore
--   stays at 210 and the advisor baseline is untouched. `service_role` and the owner keep everything.
--   `anon` already had nothing.
--
-- RE-APPLY / OTHER DATABASES
--   REVOKE of a privilege not held is a no-op, so this is safe twice. A database without the table is
--   skipped with a notice. The block ends by re-asking the catalog and RAISES if `authenticated` or
--   `anon` still holds any privilege, if RLS has been switched off, or if `service_role` lost one.
--
-- ROLLBACK
--   grant all on public.source_of_sales_customer_map to authenticated;

do $$
declare
  v_priv text;
begin
  set local lock_timeout = '5s';

  if to_regclass('public.source_of_sales_customer_map') is null then
    raise notice 'public.source_of_sales_customer_map does not exist here - skipped';
    return;
  end if;

  revoke all on public.source_of_sales_customer_map from authenticated;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('authenticated', 'public.source_of_sales_customer_map', v_priv) then
      raise exception 'refusing: authenticated still holds % on public.source_of_sales_customer_map', v_priv;
    end if;
    if has_table_privilege('anon', 'public.source_of_sales_customer_map', v_priv) then
      raise exception 'refusing: anon holds % on public.source_of_sales_customer_map', v_priv;
    end if;
  end loop;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.source_of_sales_customer_map'::regclass) then
    raise exception 'refusing: row level security is OFF on public.source_of_sales_customer_map';
  end if;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.source_of_sales_customer_map', v_priv) then
      raise exception 'refusing: service_role lost % on public.source_of_sales_customer_map', v_priv;
    end if;
  end loop;

  raise notice 'revoked all privileges from authenticated on public.source_of_sales_customer_map';
end
$$;
