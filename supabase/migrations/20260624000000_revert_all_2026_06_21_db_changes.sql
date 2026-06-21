-- =============================================================================
-- COMPENSATING ROLLBACK — undo all production DB changes made on 2026-06-21.
-- =============================================================================
-- PREPARED, NOT AUTO-APPLIED. This script is the database half of the full
-- 2026-06-21 revert (the code half is the revert commit that restores app/src
-- to 7dc98083). Apply ONLY after explicit approval, and STAGING-FIRST
-- (izhmxvgiktiafqusolot) before PRODUCTION (ozucdzovmcqvepbozvqf).
--
-- It reverses these 12 migrations (newest-effect first), each guarded so it
-- aborts instead of mis-applying if the live shape has drifted:
--   20260623090000_marketing_roi_exclude_codes              (Section 1)
--   20260622120000_marketing_roi_dashboard_region_rollup    (Section 2)
--   20260621230000_marketing_roi_dashboard_line_from_req    (Section 3)
--   20260622130000_report_rpc_statement_timeout_followups   (Section 4)
--   20260622100000_marketing_roi_rpc_statement_timeout      (Section 5)
--   20260622110000_marketing_roi_attribution_index          (Section 6)
--   20260622150000_marketing_pharmacy_mapping_coverage      (Section 7)
--   20260622235900_weekly_batches_contract_source           (Section 8, DESTRUCTIVE)
--   20260623000000_seed_excuse_decision_email_template      (Section 9)
--   20260621250000_line_office_to_head_office_rename        (Section 10)
--   20260621240000_line_anti_infective_rename               (Section 11)
--   20260622090000_revoke_marketing_roi_table_default_grants(Section 12, OPTIONAL/NOT RECOMMENDED)
--
-- WARNINGS:
--   * Sections 1+5+6 REINTRODUCE the known ROI report HTTP 500 + ~105x slowdown
--     (they remove the timeout overrides and the attribution index). Expected
--     for a faithful "undo the whole day" — do not apply if you want ROI working.
--   * Section 8 DROPS a column (loses today's column_contract_source stamps).
--   * Section 12 only re-adds grants that are inert under deny-all RLS; leaving
--     it OFF keeps the least-privilege hardening. It is commented out by default.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Section 1 — reverse exclude_codes: drop the 11-arg RPC, restore the 10-arg one
--             (removes p_exclude_codes from the signature + the req_products
--             exclusion clause from the body).
-- -----------------------------------------------------------------------------
do $rev_excl$
declare
  def text;
  v_new oid := to_regprocedure('public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer,text[])');
begin
  if v_new is null then
    raise notice '[exclude_codes] 11-arg RPC absent; assuming already reverted, skipping.';
  else
    def := pg_get_functiondef(v_new);

    if position($sig$p_limit integer DEFAULT 100, p_exclude_codes text[] DEFAULT '{}'::text[])$sig$ in def) = 0 then
      raise exception '[exclude_codes] signature anchor not found; RPC drifted, aborting.';
    end if;
    def := replace(def,
      $sig$p_limit integer DEFAULT 100, p_exclude_codes text[] DEFAULT '{}'::text[])$sig$,
      'p_limit integer DEFAULT 100)');

    if position($cte_new$  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
  ),$cte_new$ in def) = 0 then
      raise exception '[exclude_codes] req_products body anchor not found; RPC drifted, aborting.';
    end if;
    def := replace(def,
      $cte_new$  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
  ),$cte_new$,
      $cte_old$  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
  ),$cte_old$);

    execute 'drop function if exists public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer,text[])';
    execute def;

    -- DROP/CREATE resets privileges -> re-assert service-role-only hardening.
    revoke all on function public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)
      from public, anon, authenticated;
    grant execute on function public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)
      to service_role;
  end if;
end
$rev_excl$;

-- -----------------------------------------------------------------------------
-- Section 2 — reverse region rollup-family: lateral cm-join -> simple cm-join.
-- -----------------------------------------------------------------------------
do $rev_region$
declare
  def text;
  v_old oid := to_regprocedure('public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)');
begin
  if v_old is null then
    raise exception '[region_rollup] 10-arg RPC absent; Section 1 must run first.';
  end if;
  def := pg_get_functiondef(v_old);
  if position($rg_new$    left join lateral (
      select cmx.brick_id, cmx.region_code, cmx.area_code
      from public.source_of_sales_customer_map cmx
      where lower(btrim(regexp_replace(coalesce(cmx.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
        and cmx.active
        and (cmx.distributor_code = sd.distributor_code
             or exists (select 1 from public.marketing_roi_distributor_rollup rcm
                        where rcm.parent_distributor_code = sd.distributor_code
                          and rcm.sos_distributor_code = cmx.distributor_code))
      order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last
      limit 1
    ) cm on true$rg_new$ in def) = 0 then
    raise notice '[region_rollup] lateral anchor not found; assuming already reverted, skipping.';
  else
    def := replace(def,
      $rg_new$    left join lateral (
      select cmx.brick_id, cmx.region_code, cmx.area_code
      from public.source_of_sales_customer_map cmx
      where lower(btrim(regexp_replace(coalesce(cmx.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
        and cmx.active
        and (cmx.distributor_code = sd.distributor_code
             or exists (select 1 from public.marketing_roi_distributor_rollup rcm
                        where rcm.parent_distributor_code = sd.distributor_code
                          and rcm.sos_distributor_code = cmx.distributor_code))
      order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last
      limit 1
    ) cm on true$rg_new$,
      $rg_old$    left join public.source_of_sales_customer_map cm
      on cm.distributor_code = sd.distributor_code
     and lower(btrim(regexp_replace(coalesce(cm.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
     and cm.active$rg_old$);
    execute def;  -- CREATE OR REPLACE (same 10-arg sig) preserves grants
  end if;
end
$rev_region$;

-- -----------------------------------------------------------------------------
-- Section 3 — reverse line-from-requester: drop the requester employees join,
--             restore Line = mr.line_id only.
-- -----------------------------------------------------------------------------
do $rev_line$
declare
  def text;
  v_old oid := to_regprocedure('public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)');
begin
  if v_old is null then
    raise exception '[line_from_requester] 10-arg RPC absent; Sections 1-2 must run first.';
  end if;
  def := pg_get_functiondef(v_old);
  if position($ln_new$left join public.employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
    left join public.lines l on l.id = coalesce(mr.line_id, emp_req.line_id)$ln_new$ in def) = 0 then
    raise notice '[line_from_requester] requester-join anchor not found; assuming already reverted, skipping.';
  else
    def := replace(def,
      $ln_new$left join public.employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))
    left join public.lines l on l.id = coalesce(mr.line_id, emp_req.line_id)$ln_new$,
      'left join public.lines l on l.id = mr.line_id');
    execute def;
  end if;
end
$rev_line$;

-- -----------------------------------------------------------------------------
-- Section 4 — reverse report-RPC statement_timeout follow-ups (back to default).
-- -----------------------------------------------------------------------------
do $rev_to2$
begin
  if to_regprocedure('public.phx_vacation_report_rows(text[], jsonb, integer, integer)') is not null then
    execute 'alter function public.phx_vacation_report_rows(text[], jsonb, integer, integer) reset statement_timeout';
  end if;
  if to_regprocedure('public.phx_monthly_closing_matrix(text, text)') is not null then
    execute 'alter function public.phx_monthly_closing_matrix(text, text) reset statement_timeout';
  end if;
  if to_regprocedure('public.phx_monthly_closing_direct(text, text)') is not null then
    execute 'alter function public.phx_monthly_closing_direct(text, text) reset statement_timeout';
  end if;
  if to_regprocedure('public.phx_marketing_roi_latest_validated_period()') is not null then
    execute 'alter function public.phx_marketing_roi_latest_validated_period() reset statement_timeout';
  end if;
end
$rev_to2$;

-- -----------------------------------------------------------------------------
-- Section 5 — reverse marketing-ROI RPC statement_timeout (back to default).
--             WARNING: reintroduces the unfiltered ROI report HTTP 500.
-- -----------------------------------------------------------------------------
do $rev_to1$
begin
  if to_regprocedure('public.phx_marketing_request_roi_actuals_v2(uuid[], text[])') is not null then
    execute 'alter function public.phx_marketing_request_roi_actuals_v2(uuid[], text[]) reset statement_timeout';
  end if;
  if to_regprocedure('public.phx_marketing_request_roi_actuals(uuid[])') is not null then
    execute 'alter function public.phx_marketing_request_roi_actuals(uuid[]) reset statement_timeout';
  end if;
  if to_regprocedure('public.phx_marketing_request_view_sales(uuid, text, text, text[])') is not null then
    execute 'alter function public.phx_marketing_request_view_sales(uuid, text, text, text[]) reset statement_timeout';
  end if;
end
$rev_to1$;

-- -----------------------------------------------------------------------------
-- Section 6 — reverse attribution index. WARNING: reintroduces ~105x slowdown.
-- -----------------------------------------------------------------------------
drop index if exists public.sos_rows_roi_attribution_idx;

-- -----------------------------------------------------------------------------
-- Section 7 — reverse pharmacy-mapping-coverage Data Health function (drop it).
-- -----------------------------------------------------------------------------
drop function if exists public.phx_marketing_pharmacy_mapping_coverage();

-- -----------------------------------------------------------------------------
-- Section 8 — reverse weekly_sales_batches.column_contract_source. DESTRUCTIVE:
--             drops the column and any values stamped today.
-- -----------------------------------------------------------------------------
alter table public.weekly_sales_batches
  drop constraint if exists weekly_sales_batches_column_contract_source_check;
alter table public.weekly_sales_batches
  drop column if exists column_contract_source;

-- -----------------------------------------------------------------------------
-- Section 9 — reverse the seeded excuse_decision email template + recipient rule.
--             ('excuse_decision' was newly introduced today, so deletion is safe;
--             any admin edits made to it today are lost.)
-- -----------------------------------------------------------------------------
delete from public.email_template_recipient_rules where template_key = 'excuse_decision';
delete from public.email_templates where template_key = 'excuse_decision';

-- -----------------------------------------------------------------------------
-- Section 10 — reverse the "Office" -> "Head Office" line rename (id=4).
-- -----------------------------------------------------------------------------
update public.lines
set name = 'Office'
where id = 4 and btrim(name) = 'Head Office';

-- -----------------------------------------------------------------------------
-- Section 11 — reverse the "Anti Inf" -> "Anti infective" line rename (id=1).
-- NOTE: the single legacy employees.line_name row normalized 'ANTI INF' ->
-- 'Anti infective' is intentionally NOT reversed: 'Anti infective' is now also
-- the canonical value for many unrelated rows, so a blanket reverse would corrupt
-- them. That row is cosmetic (canonical line = line_id -> lines.name).
-- -----------------------------------------------------------------------------
update public.lines
set name = 'Anti Inf'
where id = 1 and btrim(name) = 'Anti infective';

-- -----------------------------------------------------------------------------
-- Section 12 — OPTIONAL / NOT RECOMMENDED: reverse the least-privilege grant
-- revoke on the two marketing ROI tables. Both are RLS deny-all, so the revoked
-- anon/authenticated grants were inert; reverting only re-adds dead grants + a
-- Supabase advisor flag. RECOMMENDED: leave the hardening in place (keep these
-- commented out). Uncomment ONLY for a byte-for-byte pre-2026-06-21 grant state.
-- -----------------------------------------------------------------------------
-- grant all on table public.marketing_roi_export_audit to anon, authenticated;
-- grant all on table public.marketing_roi_filter_presets to anon, authenticated;

notify pgrst, 'reload schema';

commit;
