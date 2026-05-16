-- Baseline snapshot generated from remote app-owned schema on 2026-05-16.
-- Source backup directory: supabase/backups/20260516185524
-- Active bootstrap starts here; legacy repair migrations were archived out of supabase/migrations.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "internal";


ALTER SCHEMA "internal" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "private"."log_sensitive_data_access"("p_table_name" "text", "p_row_ref" "text", "p_action" "text" DEFAULT 'select'::"text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'private'
    AS $$
begin
  insert into public.sensitive_data_access_audit (
    actor_auth_user_id,
    actor_hr_id,
    actor_role,
    action,
    table_name,
    row_ref,
    reason
  )
  values (
    (select auth.uid()),
    private.phx_current_hr_id(),
    private.phx_current_role(),
    coalesce(nullif(trim(p_action), ''), 'select'),
    coalesce(nullif(trim(p_table_name), ''), 'unknown'),
    nullif(trim(coalesce(p_row_ref, '')), ''),
    nullif(trim(coalesce(p_reason, '')), '')
  );
end;
$$;


ALTER FUNCTION "private"."log_sensitive_data_access"("p_table_name" "text", "p_row_ref" "text", "p_action" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."log_sensitive_data_access_event"("p_table_name" "text", "p_row_ref" "text", "p_action" "text" DEFAULT 'select'::"text", "p_reason" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'private'
    AS $$
begin
  perform private.log_sensitive_data_access(p_table_name, p_row_ref, p_action, p_reason);
  return true;
end;
$$;


ALTER FUNCTION "private"."log_sensitive_data_access_event"("p_table_name" "text", "p_row_ref" "text", "p_action" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_access_employee"("target_hr_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with actor as (
    select e.hr_id, e.line_id, e.department_id
    from public.employees e
    where lower(e.hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
    limit 1
  ),
  target as (
    select e.hr_id, e.manager_hr_id, e.line_id, e.department_id, e.employment_status
    from public.employees e
    where lower(e.hr_id) = lower(coalesce(target_hr_id, ''))
    limit 1
  ),
  access_base as (
    select
      private.phx_has_company_access()
      or lower(coalesce(target_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      or exists (
        select 1
        from target
        where private.phx_current_scope() in ('TEAM', 'HIERARCHY')
          and lower(coalesce(target.manager_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      )
      or exists (
        select 1
        from actor
        join target on true
        where private.phx_current_scope() in ('LINE', 'HIERARCHY')
          and actor.line_id is not null
          and actor.line_id = target.line_id
      )
      or exists (
        select 1
        from actor
        join target on true
        where private.phx_current_scope() in ('DEPARTMENT', 'HR', 'SUPER_ADMIN')
          and actor.department_id is not null
          and actor.department_id = target.department_id
      ) as can_access
  )
  select coalesce(can_access, false)
    and (
      not exists (
        select 1
        from target
        where lower(coalesce(target.employment_status, 'active')) in ('resigned', 'terminated', 'inactive', 'left')
      )
      or private.phx_current_role() in ('Super Admin', 'HR Specialist', 'Finance Manager')
      or lower(coalesce(target_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
    )
  from access_base;
$$;


ALTER FUNCTION "private"."phx_can_access_employee"("target_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_access_line"("target_line" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with actor as (
    select e.line_id, l.name as line_name
    from public.employees e
    left join public.lines l on l.id = e.line_id
    where lower(e.hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
    limit 1
  )
  select
    private.phx_has_company_access()
    or (
      target_line is not null
      and private.phx_current_scope() in ('LINE', 'HIERARCHY', 'TEAM')
      and exists (
        select 1
        from actor
        where lower(coalesce(actor.line_name, '')) = lower(coalesce(target_line, ''))
      )
    );
$$;


ALTER FUNCTION "private"."phx_can_access_line"("target_line" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_manage_geo"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select private.phx_current_role() in (
    'Super Admin',
    'HR Specialist',
    'SFE Manager',
    'Training Manager',
    'Finance Manager'
  );
$$;


ALTER FUNCTION "private"."phx_can_manage_geo"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_manage_leave"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(private.phx_current_role(), 'Employee') in ('Super Admin', 'HR Specialist')
    or coalesce(private.phx_current_scope(), 'SELF') in ('SUPER_ADMIN', 'HR');
$$;


ALTER FUNCTION "private"."phx_can_manage_leave"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_manage_outstation"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select private.phx_current_role() in (
    'Super Admin',
    'HR Specialist',
    'Finance Manager',
    'District Manager',
    'Regional Manager',
    'National Sales Manager',
    'Manager'
  );
$$;


ALTER FUNCTION "private"."phx_can_manage_outstation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_manage_workforce"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select private.phx_current_role() in ('Super Admin', 'HR Specialist')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'HR');
$$;


ALTER FUNCTION "private"."phx_can_manage_workforce"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_can_process_leave_payroll"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(private.phx_current_role(), 'Employee') in ('Super Admin', 'HR Specialist', 'Finance Manager')
    or coalesce(private.phx_current_scope(), 'SELF') in ('SUPER_ADMIN', 'HR', 'FINANCE');
$$;


ALTER FUNCTION "private"."phx_can_process_leave_payroll"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_current_hr_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (
      select uap.hr_id
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.hr_id
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    )
  );
$$;


ALTER FUNCTION "private"."phx_current_hr_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_current_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (
      select coalesce(
        uap.phoenix_role,
        case uap.role
          when 'super_admin' then 'Super Admin'
          when 'admin' then 'Super Admin'
          when 'company_reader' then 'CEO'
          when 'finance' then 'Finance Manager'
          when 'hr' then 'HR Specialist'
          when 'manager' then 'Manager'
          else 'Employee'
        end
      )
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.role
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    ),
    'Employee'
  );
$$;


ALTER FUNCTION "private"."phx_current_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_current_scope"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (
      select uap.scope_type
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    case private.phx_current_role()
      when 'Super Admin' then 'SUPER_ADMIN'
      when 'CEO' then 'COMPANY_READ'
      when 'SFE Manager' then 'COMPANY_READ'
      when 'Finance Manager' then 'FINANCE'
      when 'HR Specialist' then 'HR'
      when 'District Manager' then 'TEAM'
      when 'Manager' then 'TEAM'
      when 'Regional Manager' then 'HIERARCHY'
      when 'National Sales Manager' then 'LINE'
      when 'Product Manager' then 'LINE'
      when 'Group Product Manager' then 'LINE'
      when 'Training Manager' then 'LINE'
      when 'Marketing Manager' then 'LINE'
      else 'SELF'
    end
  );
$$;


ALTER FUNCTION "private"."phx_current_scope"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."phx_has_company_access"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select private.phx_current_role() in ('Super Admin', 'CEO', 'SFE Manager', 'HR Specialist')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'COMPANY_READ', 'HR');
$$;


ALTER FUNCTION "private"."phx_has_company_access"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_offer_and_create_employee"("p_offer_id" "uuid", "p_hr_id" "text", "p_hire_date" "date" DEFAULT NULL::"date", "p_birth_date" "date" DEFAULT NULL::"date", "p_contract_start_date" "date" DEFAULT NULL::"date", "p_contract_renewal_date" "date" DEFAULT NULL::"date", "p_probation_end_date" "date" DEFAULT NULL::"date") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  o record;
  v_hire_date date;
  v_hr_id text;
begin
  select * into o
  from public.job_offers
  where id = p_offer_id;

  if not found then
    raise exception 'Offer % not found', p_offer_id;
  end if;

  if o.status not in ('sent','accepted') then
    raise exception 'Offer % is not in a valid status for acceptance. Current status: %', p_offer_id, o.status;
  end if;

  v_hr_id := trim(p_hr_id);
  if v_hr_id is null or v_hr_id = '' then
    raise exception 'HR_ID is required';
  end if;

  if exists (select 1 from public.employees where hr_id = v_hr_id)
     and coalesce(o.employee_hr_id, '') <> v_hr_id then
    raise exception 'HR_ID % already exists in employees', v_hr_id;
  end if;

  v_hire_date := coalesce(p_hire_date, o.start_date, current_date);

  insert into public.employees (
    hr_id,
    full_name,
    work_email,
    mobile_number,
    job_title,
    hire_date,
    employment_status,
    manager_hr_id,
    department_id,
    line_id,
    area_id,
    position_id,
    birth_date,
    contract_start_date,
    contract_renewal_date,
    probation_end_date,
    onboarding_source,
    onboarding_status,
    payroll_eligible,
    organogram_visible,
    created_at,
    updated_at
  )
  values (
    v_hr_id,
    o.candidate_name,
    o.candidate_email,
    o.candidate_phone,
    o.job_title,
    v_hire_date,
    'active',
    o.manager_hr_id,
    o.department_id,
    o.line_id,
    o.area_id,
    o.position_id,
    p_birth_date,
    coalesce(p_contract_start_date, v_hire_date),
    p_contract_renewal_date,
    p_probation_end_date,
    'job_offer',
    'active',
    true,
    true,
    now(),
    now()
  )
  on conflict (hr_id) do update
  set
    full_name = excluded.full_name,
    work_email = excluded.work_email,
    mobile_number = excluded.mobile_number,
    job_title = excluded.job_title,
    hire_date = excluded.hire_date,
    employment_status = 'active',
    manager_hr_id = excluded.manager_hr_id,
    department_id = excluded.department_id,
    line_id = excluded.line_id,
    area_id = excluded.area_id,
    position_id = excluded.position_id,
    birth_date = coalesce(excluded.birth_date, public.employees.birth_date),
    contract_start_date = coalesce(excluded.contract_start_date, public.employees.contract_start_date),
    contract_renewal_date = coalesce(excluded.contract_renewal_date, public.employees.contract_renewal_date),
    probation_end_date = coalesce(excluded.probation_end_date, public.employees.probation_end_date),
    onboarding_source = 'job_offer',
    onboarding_status = 'active',
    payroll_eligible = true,
    organogram_visible = true,
    updated_at = now();

  insert into public.employee_compensation (
    employee_hr_id,
    gross_salary,
    net_salary,
    created_at,
    updated_at
  )
  values (
    v_hr_id,
    o.salary_amount,
    o.salary_amount,
    now(),
    now()
  )
  on conflict (employee_hr_id) do update
  set
    gross_salary = coalesce(excluded.gross_salary, public.employee_compensation.gross_salary),
    net_salary = coalesce(excluded.net_salary, public.employee_compensation.net_salary),
    updated_at = now();

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    department_id,
    line_id,
    area_id,
    position_id,
    note,
    created_at
  )
  values (
    v_hr_id,
    'hired_from_offer',
    v_hire_date,
    o.department_id,
    o.line_id,
    o.area_id,
    o.position_id,
    'Created from accepted job offer ' || coalesce(o.offer_code, o.id::text),
    now()
  );

  update public.job_offers
  set
    status = 'accepted',
    accepted_at = coalesce(accepted_at, now()),
    employee_hr_id = v_hr_id,
    onboarding_status = 'employee_created',
    updated_at = now()
  where id = p_offer_id;

  insert into public.job_offer_audit_logs (offer_id, action, actor_type, actor_reference, details, created_at)
  values (
    p_offer_id,
    'employee_created',
    'system',
    v_hr_id,
    jsonb_build_object('hr_id', v_hr_id, 'hire_date', v_hire_date),
    now()
  );

  perform public.generate_employee_lifecycle_notifications(v_hr_id);

  return v_hr_id;
end;
$$;


ALTER FUNCTION "public"."accept_offer_and_create_employee"("p_offer_id" "uuid", "p_hr_id" "text", "p_hire_date" "date", "p_birth_date" "date", "p_contract_start_date" "date", "p_contract_renewal_date" "date", "p_probation_end_date" "date") OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."coaching_report_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."coaching_report_number_seq" OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."coaching_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_number" "text" DEFAULT ((('CR-'::"text" || "to_char"("now"(), 'YYYY'::"text")) || '-'::"text") || "lpad"(("nextval"('"public"."coaching_report_number_seq"'::"regclass"))::"text", 6, '0'::"text")) NOT NULL,
    "medical_rep_hr_id" "text" NOT NULL,
    "coach_hr_id" "text" NOT NULL,
    "coach_role" "text",
    "line_id" bigint,
    "area_id" bigint,
    "team_id" bigint,
    "coaching_date" "date" NOT NULL,
    "coaching_month" integer GENERATED ALWAYS AS ((EXTRACT(month FROM "coaching_date"))::integer) STORED,
    "coaching_quarter" integer GENERATED ALWAYS AS ((EXTRACT(quarter FROM "coaching_date"))::integer) STORED,
    "coaching_year" integer GENERATED ALWAYS AS ((EXTRACT(year FROM "coaching_date"))::integer) STORED,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "actual_score" numeric(10,2) DEFAULT 0 NOT NULL,
    "max_score" numeric(10,2) DEFAULT 120 NOT NULL,
    "final_score_percent" numeric(6,2) DEFAULT 0 NOT NULL,
    "performance_zone" "text",
    "area_of_development" "text",
    "strength_points" "text",
    "general_remarks" "text",
    "employee_acknowledged" boolean DEFAULT false NOT NULL,
    "acknowledged_at" timestamp with time zone,
    "submitted_at" timestamp with time zone,
    "locked_at" timestamp with time zone,
    "created_by" "text",
    "updated_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coaching_reports_percent_bounds_check" CHECK ((("final_score_percent" >= (0)::numeric) AND ("final_score_percent" <= (100)::numeric))),
    CONSTRAINT "coaching_reports_score_bounds_check" CHECK ((("actual_score" >= (0)::numeric) AND ("max_score" > (0)::numeric) AND ("actual_score" <= "max_score"))),
    CONSTRAINT "coaching_reports_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'reviewed_by_employee'::"text", 'locked'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."coaching_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."coaching_reports" IS 'Phoenix Coaching & Field Excellence report headers. Access is service-role-only until app-level coaching permissions are implemented.';



CREATE OR REPLACE FUNCTION "public"."acknowledge_coaching_report"("p_report_id" "uuid", "p_employee_hr_id" "text", "p_acknowledgment_text" "text", "p_ip_address" "text" DEFAULT NULL::"text", "p_user_agent" "text" DEFAULT NULL::"text") RETURNS "public"."coaching_reports"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_report public.coaching_reports%rowtype;
  v_updated public.coaching_reports%rowtype;
begin
  select *
  into v_report
  from public.coaching_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Coaching report was not found.';
  end if;

  if upper(btrim(v_report.medical_rep_hr_id)) <> upper(btrim(p_employee_hr_id)) then
    raise exception 'Forbidden: employees can only acknowledge their own coaching reports.';
  end if;

  if v_report.status <> 'submitted' then
    raise exception 'Only submitted coaching reports can be acknowledged.';
  end if;

  insert into public.coaching_report_acknowledgments (
    report_id,
    employee_hr_id,
    acknowledgment_text,
    ip_address,
    user_agent
  )
  values (
    p_report_id,
    v_report.medical_rep_hr_id,
    coalesce(nullif(btrim(p_acknowledgment_text), ''), 'I acknowledge and submit this coaching report review.'),
    nullif(btrim(p_ip_address), ''),
    nullif(btrim(p_user_agent), '')
  );

  update public.coaching_reports
  set
    acknowledged_at = now(),
    employee_acknowledged = true,
    status = 'reviewed_by_employee',
    updated_by = p_employee_hr_id
  where id = p_report_id
  returning *
  into v_updated;

  insert into public.coaching_report_audit_logs (
    report_id,
    actor_hr_id,
    action,
    old_values,
    new_values,
    metadata
  )
  values (
    p_report_id,
    p_employee_hr_id,
    'acknowledged',
    jsonb_build_object('status', v_report.status),
    jsonb_build_object('status', 'reviewed_by_employee', 'acknowledgedAt', v_updated.acknowledged_at),
    jsonb_build_object('acknowledgmentText', coalesce(nullif(btrim(p_acknowledgment_text), ''), 'I acknowledge and submit this coaching report review.'))
  );

  return v_updated;
exception
  when unique_violation then
    raise exception 'This coaching report has already been acknowledged.';
end;
$$;


ALTER FUNCTION "public"."acknowledge_coaching_report"("p_report_id" "uuid", "p_employee_hr_id" "text", "p_acknowledgment_text" "text", "p_ip_address" "text", "p_user_agent" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_lifecycle_notification_event"("p_category" "text", "p_employee_hr_id" "text", "p_scheduled_for" "date", "p_subject" "text", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id uuid;
  v_event_key text;
begin
  if p_employee_hr_id is null or p_scheduled_for is null then
    return null;
  end if;

  v_event_key := p_category || ':' || p_employee_hr_id || ':' || p_scheduled_for::text;

  insert into public.notification_events (
    event_key,
    category,
    employee_hr_id,
    scheduled_for,
    recipients,
    subject,
    status,
    metadata,
    created_at,
    updated_at
  )
  values (
    v_event_key,
    p_category,
    p_employee_hr_id,
    p_scheduled_for,
    '{}'::text[],
    p_subject,
    'pending',
    coalesce(p_metadata, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (event_key) do update
  set
    subject = excluded.subject,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_lifecycle_notification_event"("p_category" "text", "p_employee_hr_id" "text", "p_scheduled_for" "date", "p_subject" "text", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_can_manage_employees"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_phoenix_role() in ('HR Specialist', 'Super Admin');
$$;


ALTER FUNCTION "public"."current_access_can_manage_employees"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_can_manage_payroll"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_phoenix_role() in ('Finance Manager', 'HR Specialist', 'Super Admin');
$$;


ALTER FUNCTION "public"."current_access_can_manage_payroll"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_can_see_employee"("employee_hr_id" "text", "employee_manager_hr_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    public.current_access_can_manage_employees()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    or (
      public.current_access_scope() in ('TEAM', 'HIERARCHY')
      and lower(coalesce(employee_manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    );
$$;


ALTER FUNCTION "public"."current_access_can_see_employee"("employee_hr_id" "text", "employee_manager_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_hr_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select (
    select uap.hr_id
    from public.user_access_profiles uap
    where uap.auth_user_id = auth.uid()
      and uap.is_active = true
    limit 1
  );
$$;


ALTER FUNCTION "public"."current_access_hr_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_access_is_super_admin();
$$;


ALTER FUNCTION "public"."current_access_is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_is_company_reader"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_phoenix_role() in ('CEO', 'SFE Manager', 'Super Admin');
$$;


ALTER FUNCTION "public"."current_access_is_company_reader"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_is_finance"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_phoenix_role() = 'Finance Manager';
$$;


ALTER FUNCTION "public"."current_access_is_finance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_is_hr"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_phoenix_role() = 'HR Specialist';
$$;


ALTER FUNCTION "public"."current_access_is_hr"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_is_super_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_phoenix_role() = 'Super Admin';
$$;


ALTER FUNCTION "public"."current_access_is_super_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_line"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select (
    select uap.line
    from public.user_access_profiles uap
    where uap.auth_user_id = auth.uid()
      and uap.is_active = true
    limit 1
  );
$$;


ALTER FUNCTION "public"."current_access_line"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_manager_hr_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select (
    select uap.manager_hr_id
    from public.user_access_profiles uap
    where uap.auth_user_id = auth.uid()
      and uap.is_active = true
    limit 1
  );
$$;


ALTER FUNCTION "public"."current_access_manager_hr_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (
      select uap.role
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    case public.current_phoenix_role()
      when 'Super Admin' then 'super_admin'
      when 'CEO' then 'company_reader'
      when 'SFE Manager' then 'company_reader'
      when 'Finance Manager' then 'finance'
      when 'HR Specialist' then 'hr'
      when 'District Manager' then 'manager'
      when 'Regional Manager' then 'manager'
      when 'National Sales Manager' then 'manager'
      when 'Product Manager' then 'manager'
      when 'Group Product Manager' then 'manager'
      when 'Training Manager' then 'manager'
      when 'Marketing Manager' then 'manager'
      when 'Manager' then 'manager'
      else 'employee'
    end
  );
$$;


ALTER FUNCTION "public"."current_access_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_access_scope"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (
      select uap.scope_type
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    case public.current_phoenix_role()
      when 'Super Admin' then 'SUPER_ADMIN'
      when 'CEO' then 'COMPANY_READ'
      when 'SFE Manager' then 'COMPANY_READ'
      when 'Finance Manager' then 'FINANCE'
      when 'HR Specialist' then 'HR'
      when 'District Manager' then 'TEAM'
      when 'Manager' then 'TEAM'
      when 'Regional Manager' then 'HIERARCHY'
      when 'National Sales Manager' then 'LINE'
      when 'Product Manager' then 'LINE'
      when 'Group Product Manager' then 'LINE'
      when 'Training Manager' then 'LINE'
      when 'Marketing Manager' then 'LINE'
      else 'SELF'
    end
  );
$$;


ALTER FUNCTION "public"."current_access_scope"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_hr_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
        select coalesce(
          (
            select uap.hr_id
            from public.user_access_profiles uap
            where uap.auth_user_id = auth.uid()
              and uap.is_active = true
            limit 1
          ),
          (
            select a.hr_id
            from public.app_auth_users a
            where a.auth_user_id = auth.uid()
              and a.is_active = true
            limit 1
          )
        );
      $$;


ALTER FUNCTION "public"."current_hr_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_phoenix_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (
      select uap.phoenix_role
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.role
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    ),
    'Employee'
  );
$$;


ALTER FUNCTION "public"."current_phoenix_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_manual_employee_lifecycle"("p_employee_hr_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  e record;
begin
  select * into e from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  update public.employees
  set
    employment_status = coalesce(employment_status, 'active'),
    onboarding_source = coalesce(onboarding_source, 'manual_add'),
    onboarding_status = coalesce(onboarding_status, 'active'),
    payroll_eligible = coalesce(payroll_eligible, true),
    organogram_visible = coalesce(organogram_visible, true),
    updated_at = now()
  where hr_id = p_employee_hr_id;

  insert into public.employee_compensation (employee_hr_id, created_at, updated_at)
  values (p_employee_hr_id, now(), now())
  on conflict (employee_hr_id) do nothing;

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    department_id,
    line_id,
    area_id,
    team_id,
    position_id,
    note,
    created_at
  )
  values (
    p_employee_hr_id,
    'manual_employee_finalized',
    coalesce(e.hire_date, current_date),
    e.department_id,
    e.line_id,
    e.area_id,
    e.team_id,
    e.position_id,
    'Manual employee lifecycle finalized',
    now()
  );

  perform public.generate_employee_lifecycle_notifications(p_employee_hr_id);
end;
$$;


ALTER FUNCTION "public"."finalize_manual_employee_lifecycle"("p_employee_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_get_admin_command_center_data"("p_access_scope" "text" DEFAULT 'company'::"text", "p_access_role" "text" DEFAULT 'Manager'::"text", "p_access_hr_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_result jsonb;
  v_payroll_batch_id uuid;
  v_payroll_batch_month int;
  v_payroll_batch_year int;
  v_payroll record;
  v_sales record;
  v_expenses record;
  v_recruitment record;
  v_risk record;
  v_hr record;
  v_health record;
  v_allowed_hr_ids text[];
begin
  if p_access_scope = 'system' or p_access_role in ('Super Admin', 'CEO', 'HR Specialist', 'Finance Manager') then
    v_allowed_hr_ids := null;
  elsif p_access_role in ('Regional Manager', 'Regional Sales Manager') then
    select array_agg(hr_id) into v_allowed_hr_ids from public.fn_get_employee_hierarchy(p_access_hr_id);
  else
    v_allowed_hr_ids := array[p_access_hr_id];
  end if;

  select
    count(*) filter (where employment_status in ('active', 'on_leave'))::int as active_employees,
    count(*)::int as total_employees,
    count(distinct line_id)::int as unique_lines,
    count(distinct area_id)::int as unique_areas,
    count(*) filter (where manager_hr_id is null and employment_status in ('active', 'on_leave'))::int as employees_without_managers
  into v_hr
  from public.employees
  where (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));

  select id, month, year
  into v_payroll_batch_id, v_payroll_batch_month, v_payroll_batch_year
  from public.salary_batches
  where status = 'approved'
  order by year desc, month desc
  limit 1;

  if v_payroll_batch_id is not null then
    select
      count(*)::int as employees,
      coalesce(sum(gross_salary), 0)::numeric as gross,
      coalesce(sum(net_salary), 0)::numeric as net,
      (select count(*)::int from public.salary_flags where batch_id = v_payroll_batch_id) as flags
    into v_payroll
    from public.salary_records
    where batch_id = v_payroll_batch_id
      and (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));
  else
    select 0::int as employees, 0::numeric as gross, 0::numeric as net, 0::int as flags
    into v_payroll;
  end if;

  with active_batches as (
    select id from public.sales_import_batches
    where status not in ('rejected', 'replaced')
      and replaced_by_batch_id is null
  )
  select
    coalesce(sum(sales_value), 0)::numeric as sales_value,
    coalesce(sum(target_value), 0)::numeric as target_value,
    case when sum(target_value) > 0 then (sum(sales_value) / sum(target_value) * 100)::numeric else 0 end as achievement_rate,
    count(distinct product)::int as active_products
  into v_sales
  from public.sales_records
  where batch_id in (select id from active_batches)
    and (v_allowed_hr_ids is null or employee_hr_id = any(v_allowed_hr_ids) or manager_hr_id = any(v_allowed_hr_ids));

  select
    coalesce(sum(total), 0)::numeric as total_amount,
    coalesce(sum(case when hr_approved = true then total else 0 end), 0)::numeric as approved_amount,
    count(*)::int as total_rows,
    (select count(*)::int from public.payroll_expense_reports) as report_count
  into v_expenses
  from public.payroll_expenses
  where (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));

  select
    count(*)::int as total_offers,
    count(*) filter (where status = 'sent')::int as pending_offers,
    count(*) filter (where status = 'accepted')::int as accepted_offers,
    count(*) filter (where status = 'rejected')::int as rejected_offers,
    case
      when count(*) filter (where status in ('accepted', 'rejected')) > 0
        then (count(*) filter (where status = 'accepted')::numeric / count(*) filter (where status in ('accepted', 'rejected')) * 100)::numeric
      else 0
    end as acceptance_rate
  into v_recruitment
  from public.job_offers;

  select
    (select count(*)::int from public.employee_contracts where status = 'active' and contract_renewal_date < now() + interval '30 days') as expiring_contracts,
    (select count(*)::int from public.employee_probation where status = 'active' and probation_end_date < now() + interval '14 days') as probation_endings
  into v_risk;

  select
    (case when v_hr.active_employees > 0 then (count(*) filter (where manager_hr_id is not null and (job_title is not null or position_id is not null))::numeric / v_hr.active_employees * 100) else 100 end)::numeric as employee_health_rate,
    (select count(*) from public.sales_records)::int as total_sales_rows,
    (select count(*) from public.sales_records where link_status = 'linked')::int as linked_sales_rows
  into v_health
  from public.employees
  where employment_status in ('active', 'on_leave')
    and (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));

  v_result := jsonb_build_object(
    'overview', jsonb_build_object(
      'hr', jsonb_build_object(
        'activeEmployees', coalesce(v_hr.active_employees, 0),
        'totalEmployees', coalesce(v_hr.total_employees, 0),
        'uniqueLines', coalesce(v_hr.unique_lines, 0),
        'uniqueAreas', coalesce(v_hr.unique_areas, 0),
        'employeesWithoutManagers', coalesce(v_hr.employees_without_managers, 0)
      ),
      'payroll', jsonb_build_object(
        'batchLabel', coalesce(v_payroll_batch_month::text || '/' || v_payroll_batch_year::text, 'â€”'),
        'employees', coalesce(v_payroll.employees, 0),
        'gross', coalesce(v_payroll.gross, 0),
        'net', coalesce(v_payroll.net, 0),
        'flags', coalesce(v_payroll.flags, 0)
      ),
      'sales', jsonb_build_object(
        'salesValue', coalesce(v_sales.sales_value, 0),
        'targetValue', coalesce(v_sales.target_value, 0),
        'achievementRate', coalesce(v_sales.achievement_rate, 0),
        'activeProducts', coalesce(v_sales.active_products, 0)
      ),
      'expenses', jsonb_build_object(
        'approvedAmount', coalesce(v_expenses.approved_amount, 0),
        'totalAmount', coalesce(v_expenses.total_amount, 0),
        'totalRows', coalesce(v_expenses.total_rows, 0),
        'reportCount', coalesce(v_expenses.report_count, 0)
      ),
      'recruitment', jsonb_build_object(
        'totalOffers', coalesce(v_recruitment.total_offers, 0),
        'pendingOffers', coalesce(v_recruitment.pending_offers, 0),
        'acceptedOffers', coalesce(v_recruitment.accepted_offers, 0),
        'rejectedOffers', coalesce(v_recruitment.rejected_offers, 0),
        'acceptanceRate', coalesce(v_recruitment.acceptance_rate, 0)
      ),
      'risk', jsonb_build_object(
        'expiringContracts', coalesce(v_risk.expiring_contracts, 0),
        'probationEndings', coalesce(v_risk.probation_endings, 0)
      )
    ),
    'health', jsonb_build_object(
      'employeeHealthRate', coalesce(v_health.employee_health_rate, 100),
      'healthyEmployees', greatest(coalesce(v_hr.active_employees, 0) - coalesce(v_hr.employees_without_managers, 0), 0),
      'totalEmployees', coalesce(v_hr.active_employees, 0),
      'missingManager', coalesce(v_hr.employees_without_managers, 0),
      'missingJobTitle', 0,
      'salesLinkageRate', case when coalesce(v_health.total_sales_rows, 0) > 0 then (v_health.linked_sales_rows::numeric / v_health.total_sales_rows * 100) else 100 end,
      'salesLinkageBatch', null
    ),
    'payrollEligibleCount', coalesce((select count(*) from public.employees where payroll_eligible = true), 0),
    'dataUnavailable', '[]'::jsonb
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."fn_get_admin_command_center_data"("p_access_scope" "text", "p_access_role" "text", "p_access_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_get_audit_module_counts"() RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'total', count(*),
    'auth', count(*) filter (where module = 'auth'),
    'access', count(*) filter (where module = 'access'),
    'coaching', count(*) filter (where module = 'coaching'),
    'recruitment', count(*) filter (where module = 'recruitment'),
    'outstation', count(*) filter (where module = 'outstation'),
    'sales', count(*) filter (where module = 'sales'),
    'governance', count(*) filter (where module = 'governance')
  ) into v_result
  from public.v_unified_audit_logs;
  
  return v_result;
end;
$$;


ALTER FUNCTION "public"."fn_get_audit_module_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_get_broken_auth_accounts"() RETURNS "text"[]
    LANGUAGE "plpgsql"
    AS $$
begin
  return array(
    select a.login_id
    from public.app_auth_users a
    where a.auth_user_id is not null
    and not exists (
      select 1 
      from public.user_access_profiles p 
      where p.auth_user_id = a.auth_user_id
    )
  );
end;
$$;


ALTER FUNCTION "public"."fn_get_broken_auth_accounts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_get_command_center_metrics"() RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_result jsonb;
  v_payroll_batch record;
  v_payroll record;
  v_sales record;
  v_expenses record;
  v_recruitment record;
  v_risk record;
begin
  -- Latest Payroll
  select id, month, year into v_payroll_batch
  from public.salary_batches
  order by year desc, month desc
  limit 1;

  if v_payroll_batch.id is not null then
    select
      count(*)::int as employees,
      coalesce(sum(gross_salary), 0)::numeric as gross,
      coalesce(sum(net_salary), 0)::numeric as net,
      (select count(*)::int from public.salary_flags where batch_id = v_payroll_batch.id) as flags
    into v_payroll
    from public.salary_records
    where batch_id = v_payroll_batch.id;
  end if;

  -- Sales Summary
  select
    coalesce(sum(sales_value), 0)::numeric as sales_value,
    coalesce(sum(target_value), 0)::numeric as target_value,
    case when sum(target_value) > 0 then (sum(sales_value) / sum(target_value) * 100)::numeric else 0 end as achievement_rate
  into v_sales
  from public.sales_records;

  -- Expenses Summary
  select
    coalesce(sum(claimed_total_amount), 0)::numeric as total_amount,
    coalesce(sum(case when status = 'approved' then claimed_total_amount else 0 end), 0)::numeric as approved_amount,
    count(*)::int as report_count
  into v_expenses
  from public.outstation_expense_requests;

  -- Recruitment Summary
  select
    count(*)::int as total_offers,
    count(*) filter (where status = 'sent')::int as pending_offers,
    count(*) filter (where status = 'accepted')::int as accepted_offers,
    count(*) filter (where status = 'rejected')::int as rejected_offers,
    case when count(*) > 0 then (count(*) filter (where status = 'accepted')::numeric / count(*) * 100)::numeric else 0 end as acceptance_rate
  into v_recruitment
  from public.job_offers;

  -- Risk Metrics
  select
    (select count(*)::int from public.employees where employment_status = 'active' and hire_date is not null) as active_employees,
    (select count(*)::int from public.employee_contracts where status = 'active' and end_date < now() + interval '30 days') as expiring_contracts,
    (select count(*)::int from public.employee_probation where status = 'active' and end_date < now() + interval '14 days') as probation_endings
  into v_risk;

  v_result = jsonb_build_object(
    'hr', jsonb_build_object(
      'activeEmployees', v_risk.active_employees,
      'totalEmployees', (select count(*)::int from public.employees)
    ),
    'payroll', jsonb_build_object(
      'batchLabel', coalesce(v_payroll_batch.month::text || '/' || v_payroll_batch.year::text, 'â€”'),
      'employees', coalesce(v_payroll.employees, 0),
      'gross', coalesce(v_payroll.gross, 0),
      'net', coalesce(v_payroll.net, 0),
      'flags', coalesce(v_payroll.flags, 0)
    ),
    'sales', jsonb_build_object(
      'salesValue', v_sales.sales_value,
      'targetValue', v_sales.target_value,
      'achievementRate', v_sales.achievement_rate
    ),
    'expenses', jsonb_build_object(
      'approvedAmount', v_expenses.approved_amount,
      'totalAmount', v_expenses.total_amount,
      'reportCount', v_expenses.report_count
    ),
    'recruitment', jsonb_build_object(
      'totalOffers', v_recruitment.total_offers,
      'pendingOffers', v_recruitment.pending_offers,
      'acceptedOffers', v_recruitment.accepted_offers,
      'rejectedOffers', v_recruitment.rejected_offers,
      'acceptanceRate', v_recruitment.acceptance_rate
    ),
    'risk', jsonb_build_object(
      'expiringContracts', v_risk.expiring_contracts,
      'probationEndings', v_risk.probation_endings
    )
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."fn_get_command_center_metrics"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_get_employee_directory_paginated"("p_search" "text" DEFAULT NULL::"text", "p_line_id" bigint DEFAULT NULL::bigint, "p_area_id" bigint DEFAULT NULL::bigint, "p_department_id" bigint DEFAULT NULL::bigint, "p_team_id" bigint DEFAULT NULL::bigint, "p_status" "text" DEFAULT NULL::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50, "p_access_scope" "text" DEFAULT 'company'::"text", "p_access_role" "text" DEFAULT 'Manager'::"text", "p_access_hr_id" "text" DEFAULT NULL::"text") RETURNS TABLE("employees" "jsonb", "total_count" bigint)
    LANGUAGE "plpgsql"
    AS $$
declare
  v_offset int;
  v_allowed_hr_ids text[];
begin
  v_offset := (p_page - 1) * p_page_size;

  -- Handle permissions - More comprehensive role handling
  if p_access_scope = 'system' or p_access_role in (
    'Super Admin', 'CEO', 'HR Specialist', 'Finance Manager', 
    'National Sales Manager', 'Product Manager', 'Group Product Manager', 
    'SFE Manager', 'Training Manager', 'Marketing Manager'
  ) then
    v_allowed_hr_ids := null; -- Full or broad visibility
  elsif p_access_role in ('Regional Manager', 'Regional Sales Manager') then
    -- Regional managers see their hierarchy
    select array_agg(hr_id) into v_allowed_hr_ids from public.fn_get_employee_hierarchy(p_access_hr_id);
  else
    -- District Managers and others see themselves and their reports
    v_allowed_hr_ids := array[p_access_hr_id];
  end if;

  return query
  with filtered_employees as (
    select e.*
    from public.employees e
    where
      (p_search is null or 
       e.full_name ilike '%' || p_search || '%' or 
       e.hr_id ilike '%' || p_search || '%' or 
       e.work_email ilike '%' || p_search || '%')
      and (p_line_id is null or e.line_id = p_line_id)
      and (p_area_id is null or e.area_id = p_area_id)
      and (p_department_id is null or e.department_id = p_department_id)
      and (p_team_id is null or e.team_id = p_team_id)
      and (p_status is null or e.employment_status = p_status)
      and (
        v_allowed_hr_ids is null
        or e.hr_id = any(v_allowed_hr_ids)
        or e.manager_hr_id = p_access_hr_id -- Always include direct reports for any manager role
      )
  ),
  total as (
    select count(*) as cnt from filtered_employees
  ),
  paginated as (
    select 
      fe.*,
      c.net_salary, c.social_insurance, c.taxes, c.medical_insurance, c.fuel_allowance, c.extra_cost_of_living, c.gross_salary, c.payment_mode,
      d.name as department_name,
      l.name as line_name,
      a.name as area_name,
      p.title as position_title,
      t.name as team_name,
      m.full_name as manager_name
    from filtered_employees fe
    left join public.employee_compensation c on c.employee_hr_id = fe.hr_id
    left join public.departments d on d.id = fe.department_id
    left join public.lines l on l.id = fe.line_id
    left join public.areas a on a.id = fe.area_id
    left join public.positions p on p.id = fe.position_id
    left join public.teams t on t.id = fe.team_id
    left join public.employees m on m.hr_id = fe.manager_hr_id
    order by fe.full_name asc
    limit p_page_size
    offset v_offset
  )
  -- Ensure we return at least one row even if empty, to avoid PGRST errors or empty results in JS
  select 
    (select coalesce(jsonb_agg(to_jsonb(paginated)), '[]'::jsonb) from paginated),
    coalesce((select cnt from total), 0)::bigint;
end;
$$;


ALTER FUNCTION "public"."fn_get_employee_directory_paginated"("p_search" "text", "p_line_id" bigint, "p_area_id" bigint, "p_department_id" bigint, "p_team_id" bigint, "p_status" "text", "p_page" integer, "p_page_size" integer, "p_access_scope" "text", "p_access_role" "text", "p_access_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_get_employee_hierarchy"("p_root_hr_id" "text") RETURNS TABLE("hr_id" "text", "depth" integer)
    LANGUAGE "plpgsql"
    AS $$
begin
  return query
  with recursive employee_tree as (
    -- Anchor member
    select e.hr_id, 1 as depth
    from public.employees e
    where e.hr_id = p_root_hr_id

    union all

    -- Recursive member
    select e.hr_id, t.depth + 1
    from public.employees e
    inner join employee_tree t on e.manager_hr_id = t.hr_id
    where t.depth < 20 -- Safety limit
  )
  select et.hr_id, et.depth from employee_tree et;
end;
$$;


ALTER FUNCTION "public"."fn_get_employee_hierarchy"("p_root_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_employee_lifecycle_notifications"("p_employee_hr_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  e record;
  d integer;
begin
  select * into e
  from public.employees
  where hr_id = p_employee_hr_id;

  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  -- Probation: 30/14/7/0 days
  if e.probation_end_date is not null then
    foreach d in array array[30,14,7,0]
    loop
      perform public.create_lifecycle_notification_event(
        'probation',
        e.hr_id,
        e.probation_end_date - d,
        case when d = 0 then 'Probation ends today: ' else 'Probation reminder: ' end || e.full_name,
        jsonb_build_object('days_before', d, 'target_date', e.probation_end_date)
      );
    end loop;
  end if;

  -- Contract renewal: 60/30/7/0 days
  if e.contract_renewal_date is not null then
    foreach d in array array[60,30,7,0]
    loop
      perform public.create_lifecycle_notification_event(
        'contract_renewal',
        e.hr_id,
        e.contract_renewal_date - d,
        case when d = 0 then 'Contract renewal due today: ' else 'Contract renewal reminder: ' end || e.full_name,
        jsonb_build_object('days_before', d, 'target_date', e.contract_renewal_date)
      );
    end loop;
  end if;

  -- Birthday: current year occurrence only for now; yearly scheduler can regenerate annually
  if e.birth_date is not null then
    perform public.create_lifecycle_notification_event(
      'birthday',
      e.hr_id,
      make_date(extract(year from current_date)::int, extract(month from e.birth_date)::int, extract(day from e.birth_date)::int),
      'Birthday reminder: ' || e.full_name,
      jsonb_build_object('birth_date', e.birth_date)
    );
  end if;
end;
$$;


ALTER FUNCTION "public"."generate_employee_lifecycle_notifications"("p_employee_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_approve_accepted_offer"("p_offer_id" "uuid", "p_approved_by_hr_id" "text" DEFAULT NULL::"text", "p_employee_hr_id" "text" DEFAULT NULL::"text", "p_gross_salary" numeric DEFAULT 0, "p_fuel_allowance" numeric DEFAULT 0, "p_extra_cost_of_living" numeric DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_offer public.job_offers%rowtype;
  v_employee_hr_id text;
  v_prefix text := 'PH';
  v_line_name text;
  v_line_code text;
  v_candidate integer;
  v_attempt integer := 0;
  v_matching_vacancy_id bigint;
  v_monthly_package numeric;
  v_base_salary numeric;
  v_gross_salary numeric;
begin
  select *
  into v_offer
  from public.job_offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  if v_offer.status <> 'accepted' then
    raise exception 'Only accepted offers can be approved.';
  end if;

  if coalesce(trim(v_offer.candidate_name), '') = '' then
    raise exception 'Cannot approve offer without candidate name.';
  end if;

  if coalesce(trim(v_offer.candidate_email), '') = '' then
    raise exception 'Cannot approve offer without candidate email.';
  end if;

  if v_offer.line_id is null then
    raise exception 'Cannot approve offer without line assignment.';
  end if;

  if v_offer.area_id is null then
    raise exception 'Cannot approve offer without area assignment.';
  end if;

  if coalesce(trim(v_offer.manager_hr_id), '') = '' then
    raise exception 'Cannot approve offer without manager HR ID.';
  end if;

  v_employee_hr_id := nullif(trim(coalesce(p_employee_hr_id, v_offer.employee_hr_id, '')), '');

  if v_employee_hr_id is null then
    select coalesce(name, ''), coalesce(code, '')
    into v_line_name, v_line_code
    from public.lines
    where id = v_offer.line_id;

    if position('anti' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'AI';
    elsif position('pedia' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'PD';
    elsif position('cns' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'CN';
    elsif position('office' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'OF';
    end if;

    loop
      v_attempt := v_attempt + 1;
      if v_attempt > 5 then
        raise exception 'Failed to generate a unique HR_ID for prefix %.', v_prefix;
      end if;

      select coalesce(
        max(
          nullif(
            substring(hr_id from ('^' || v_prefix || '-([0-9]+)$')),
            ''
          )::integer
        ),
        0
      ) + 1
      into v_candidate
      from public.employees
      where hr_id like v_prefix || '-%';

      v_employee_hr_id := v_prefix || '-' || lpad(v_candidate::text, 4, '0');

      begin
        insert into public.employees (
          hr_id,
          full_name,
          work_email,
          mobile_number,
          job_title,
          hire_date,
          employment_status,
          manager_hr_id,
          department_id,
          line_id,
          area_id,
          position_id,
          created_at,
          updated_at
        ) values (
          v_employee_hr_id,
          v_offer.candidate_name,
          v_offer.candidate_email,
          v_offer.candidate_phone,
          v_offer.job_title,
          v_offer.start_date,
          'active',
          v_offer.manager_hr_id,
          v_offer.department_id,
          v_offer.line_id,
          v_offer.area_id,
          v_offer.position_id,
          now(),
          now()
        );
        exit;
      exception
        when unique_violation then
          v_employee_hr_id := null;
      end;
    end loop;
  else
    if exists (
      select 1
      from public.employees
      where hr_id = v_employee_hr_id
        and hr_id <> coalesce(v_offer.employee_hr_id, '')
    ) then
      raise exception 'HR_ID % is already in use.', v_employee_hr_id;
    end if;

    insert into public.employees (
      hr_id,
      full_name,
      work_email,
      mobile_number,
      job_title,
      hire_date,
      employment_status,
      manager_hr_id,
      department_id,
      line_id,
      area_id,
      position_id,
      created_at,
      updated_at
    ) values (
      v_employee_hr_id,
      v_offer.candidate_name,
      v_offer.candidate_email,
      v_offer.candidate_phone,
      v_offer.job_title,
      v_offer.start_date,
      'active',
      v_offer.manager_hr_id,
      v_offer.department_id,
      v_offer.line_id,
      v_offer.area_id,
      v_offer.position_id,
      now(),
      now()
    )
    on conflict (hr_id) do update
    set
      full_name = excluded.full_name,
      work_email = excluded.work_email,
      mobile_number = excluded.mobile_number,
      job_title = excluded.job_title,
      hire_date = excluded.hire_date,
      employment_status = excluded.employment_status,
      manager_hr_id = excluded.manager_hr_id,
      department_id = excluded.department_id,
      line_id = excluded.line_id,
      area_id = excluded.area_id,
      position_id = excluded.position_id,
      updated_at = now();
  end if;

  v_monthly_package := coalesce(p_gross_salary, 0);
  v_base_salary := greatest(
    0,
    v_monthly_package - coalesce(p_extra_cost_of_living, 0) - coalesce(p_fuel_allowance, 0)
  );
  v_gross_salary := v_base_salary;

  insert into public.employee_compensation (
    employee_hr_id,
    net_salary,
    comprehensive_wage,
    fuel_allowance,
    extra_cost_of_living,
    gross_salary,
    payment_mode,
    updated_at
  ) values (
    v_employee_hr_id,
    v_base_salary,
    v_base_salary,
    coalesce(p_fuel_allowance, 0),
    coalesce(p_extra_cost_of_living, 0),
    v_gross_salary,
    'two_parts',
    now()
  )
  on conflict (employee_hr_id) do update
  set
    net_salary = excluded.net_salary,
    comprehensive_wage = excluded.comprehensive_wage,
    fuel_allowance = excluded.fuel_allowance,
    extra_cost_of_living = excluded.extra_cost_of_living,
    gross_salary = excluded.gross_salary,
    payment_mode = excluded.payment_mode,
    updated_at = now();

  if v_offer.position_id is not null and v_offer.line_id is not null and v_offer.area_id is not null then
    select pv.id
    into v_matching_vacancy_id
    from public.position_vacancies pv
    where pv.position_id = v_offer.position_id
      and pv.line_id = v_offer.line_id
      and pv.area_id = v_offer.area_id
      and pv.status = 'open'
    order by
      case when pv.manager_hr_id = v_offer.manager_hr_id then 0 else 1 end,
      pv.created_at desc,
      pv.id desc
    limit 1
    for update;

    if v_matching_vacancy_id is not null then
      update public.position_vacancies
      set status = 'filled',
          updated_at = now()
      where id = v_matching_vacancy_id;
    end if;
  end if;

  update public.job_offers
  set employee_hr_id = v_employee_hr_id,
      onboarding_status = 'approved_hired',
      updated_at = now()
  where id = v_offer.id;

  insert into public.job_offer_audit_logs (
    offer_id,
    action,
    actor_type,
    actor_reference,
    details
  ) values (
    v_offer.id,
    'hire_approved',
    'hr',
    p_approved_by_hr_id,
    jsonb_build_object(
      'employeeHrId', v_employee_hr_id,
      'vacancyId', v_matching_vacancy_id
    )
  );

  return jsonb_build_object(
    'employee_hr_id', v_employee_hr_id,
    'offer_id', v_offer.id,
    'vacancy_id', v_matching_vacancy_id
  );
end;
$_$;


ALTER FUNCTION "public"."phx_approve_accepted_offer"("p_offer_id" "uuid", "p_approved_by_hr_id" "text", "p_employee_hr_id" "text", "p_gross_salary" numeric, "p_fuel_allowance" numeric, "p_extra_cost_of_living" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_autofill_replacement_vacancy_from_employee_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_match_count integer := 0;
  v_vacancy record;
  v_effective_date date;
begin
  if lower(coalesce(new.employment_status, 'active')) not in ('active', 'on_leave') then
    return new;
  end if;

  if coalesce(new.payroll_eligible, true) is not true
     or coalesce(new.organogram_visible, true) is not true then
    return new;
  end if;

  if new.area_id is null
     or new.line_id is null
     or new.position_id is null
     or nullif(trim(coalesce(new.manager_hr_id, '')), '') is null then
    return new;
  end if;

  select count(*)
  into v_match_count
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id;

  -- Avoid guessing when more than one live vacancy has the same footprint.
  if v_match_count <> 1 then
    return new;
  end if;

  select id, replacement_for_hr_id
  into v_vacancy
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id
  order by v.created_at asc, v.id asc
  limit 1;

  update public.position_vacancies
  set
    status = 'filled',
    filled_by_hr_id = new.hr_id,
    filled_at = now(),
    note = concat_ws(
      E'\n',
      nullif(note, ''),
      'Auto-filled by replacement ownership engine for ' || new.hr_id || ' on ' || current_date::text || '.'
    ),
    updated_at = now()
  where id = v_vacancy.id
    and lower(coalesce(status, 'open')) = 'open';

  if nullif(trim(coalesce(v_vacancy.replacement_for_hr_id, '')), '') is null then
    return new;
  end if;

  select coalesce(last_working_date, effective_date, resignation_date, current_date)
  into v_effective_date
  from public.employee_resignations
  where vacancy_id = v_vacancy.id
     or employee_hr_id = v_vacancy.replacement_for_hr_id
  order by created_at desc
  limit 1;

  perform public.phx_reassign_replacement_ownership(
    v_vacancy.replacement_for_hr_id,
    new.hr_id,
    coalesce(v_effective_date, current_date)
  );

  return new;
exception
  when undefined_column then
    raise notice 'Replacement ownership auto-fill skipped because expected lifecycle/vacancy columns are missing.';
    return new;
end;
$$;


ALTER FUNCTION "public"."phx_autofill_replacement_vacancy_from_employee_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_create_salary_batch"("p_month" integer, "p_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_created_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_batch public.salary_batches%rowtype;
  v_records jsonb := coalesce(p_records, '[]'::jsonb);
  v_flags jsonb := coalesce(p_flags, '[]'::jsonb);
begin
  if p_month < 1 or p_month > 12 then
    raise exception 'Payroll month must be between 1 and 12.' using errcode = '22023';
  end if;

  if p_year < 2000 or p_year > 2100 then
    raise exception 'Payroll year must be between 2000 and 2100.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_records) <> 'array' then
    raise exception 'Payroll upload records must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_flags) <> 'array' then
    raise exception 'Payroll upload flags must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_array_length(v_records) = 0 then
    raise exception 'Payroll upload records must include at least one salary record.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_records) as record(value)
    where jsonb_typeof(record.value) <> 'object'
  ) then
    raise exception 'Payroll upload records must contain JSON objects.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_flags) as flag(value)
    where jsonb_typeof(flag.value) <> 'object'
  ) then
    raise exception 'Payroll upload flags must contain JSON objects.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_records) as r(hr_id text)
    where nullif(trim(coalesce(r.hr_id, '')), '') is null
  ) then
    raise exception 'Payroll upload records must include HR IDs.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_records) as r(payment_mode text)
    where coalesce(r.payment_mode, 'two_parts') not in ('one_part', 'two_parts')
  ) then
    raise exception 'Payroll upload payment_mode must be one_part or two_parts.' using errcode = '22023';
  end if;

  begin
    insert into public.salary_batches (
      file_name,
      month,
      year,
      status,
      uploaded_by,
      created_at,
      updated_at
    )
    values (
      p_file_name,
      p_month,
      p_year,
      'uploaded',
      p_uploaded_by,
      p_created_at,
      p_created_at
    )
    returning *
    into v_batch;
  exception
    when unique_violation then
      raise exception 'Payroll period %/% already has a batch.', p_month, p_year using errcode = '23505';
  end;

  insert into public.salary_records (
    area,
    base_salary,
    batch_id,
    bonus,
    crm,
    employment_income_tax,
    expenses,
    extra_cost_of_living,
    finger_print,
    first_part,
    fuel_allowance,
    full_name,
    governmental_deductions,
    gross_salary,
    hire_date,
    hr_id,
    incentive,
    job_title,
    line,
    loans,
    medical_insurance,
    month_salary,
    name_ar,
    net_salary,
    other_additions,
    other_deductions,
    overtime,
    comment,
    payment_mode,
    second_part,
    social_insurance,
    total_additions,
    total_deductions,
    unpaid_vacations
  )
  select
    r.area,
    coalesce(r.base_salary, 0),
    v_batch.id,
    r.bonus,
    r.crm,
    r.employment_income_tax,
    r.expenses,
    r.extra_cost_of_living,
    r.finger_print,
    r.first_part,
    r.fuel_allowance,
    r.full_name,
    coalesce(r.governmental_deductions, coalesce(r.social_insurance, 0) + coalesce(r.employment_income_tax, 0)),
    r.gross_salary,
    r.hire_date,
    r.hr_id,
    r.incentive,
    r.job_title,
    r.line,
    r.loans,
    r.medical_insurance,
    coalesce(r.month_salary, coalesce(r.first_part, 0) + coalesce(r.second_part, 0)),
    r.name_ar,
    r.net_salary,
    r.other_additions,
    r.other_deductions,
    r.overtime,
    r.comment,
    coalesce(r.payment_mode, 'two_parts'),
    r.second_part,
    r.social_insurance,
    r.total_additions,
    r.total_deductions,
    r.unpaid_vacations
  from jsonb_to_recordset(v_records) as r(
    area text,
    base_salary numeric,
    bonus numeric,
    crm numeric,
    employment_income_tax numeric,
    expenses numeric,
    extra_cost_of_living numeric,
    finger_print numeric,
    first_part numeric,
    fuel_allowance numeric,
    full_name text,
    governmental_deductions numeric,
    gross_salary numeric,
    hire_date date,
    hr_id text,
    incentive numeric,
    job_title text,
    line text,
    loans numeric,
    medical_insurance numeric,
    month_salary numeric,
    name_ar text,
    net_salary numeric,
    other_additions numeric,
    other_deductions numeric,
    overtime numeric,
    comment text,
    payment_mode text,
    second_part numeric,
    social_insurance numeric,
    total_additions numeric,
    total_deductions numeric,
    unpaid_vacations numeric
  );

  insert into public.salary_flags (
    batch_id,
    flag_type,
    hr_id,
    message,
    severity
  )
  select
    v_batch.id,
    f.flag_type,
    f.hr_id,
    f.message,
    coalesce(f.severity, 'warning')
  from jsonb_to_recordset(v_flags) as f(
    flag_type text,
    hr_id text,
    message text,
    severity text
  );

  return to_jsonb(v_batch);
end;
$$;


ALTER FUNCTION "public"."phx_create_salary_batch"("p_month" integer, "p_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_created_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_delete_salary_batch"("p_batch_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_batch public.salary_batches%rowtype;
  v_deleted_flags integer := 0;
  v_deleted_records integer := 0;
begin
  if p_batch_id is null then
    raise exception 'Payroll upload id is required.' using errcode = '22023';
  end if;

  select *
  into v_batch
  from public.salary_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Payroll upload not found.' using errcode = 'P0002';
  end if;

  perform set_config('request.phx_allow_salary_batch_delete', 'on', true);

  delete from public.salary_flags
  where batch_id = p_batch_id;
  get diagnostics v_deleted_flags = row_count;

  delete from public.salary_records
  where batch_id = p_batch_id;
  get diagnostics v_deleted_records = row_count;

  delete from public.salary_batches
  where id = p_batch_id;

  return jsonb_build_object(
    'id', v_batch.id,
    'month', v_batch.month,
    'year', v_batch.year,
    'status', v_batch.status,
    'file_name', v_batch.file_name,
    'records_deleted', v_deleted_records,
    'flags_deleted', v_deleted_flags
  );
end;
$$;


ALTER FUNCTION "public"."phx_delete_salary_batch"("p_batch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_import_approved_expenses_to_payroll"("p_month" integer, "p_year" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_batch public.salary_batches%rowtype;
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
  v_matched_employees text[] := '{}'::text[];
begin
  select *
  into v_batch
  from public.salary_batches
  where month = p_month
    and year = p_year
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'imported_employees', 0,
      'imported_total', 0,
      'matched_employees', '[]'::jsonb,
      'target_batch_id', null,
      'target_batch_month', null,
      'target_batch_year', null
    );
  end if;

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import expenses before Part 1 is paid or while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  with approved_totals as (
    select
      lower(hr_id) as normalized_hr_id,
      min(hr_id) as hr_id,
      sum(total)::numeric(20,2) as approved_expense
    from public.payroll_expenses
    where hr_approved = true
      and payout_month = p_month
      and payout_year = p_year
      and hr_id is not null
      and trim(hr_id) <> ''
    group by lower(hr_id)
  ),
  matched_totals as (
    select
      sr.hr_id,
      at.approved_expense
    from public.salary_records sr
    join approved_totals at
      on lower(sr.hr_id) = at.normalized_hr_id
    where sr.batch_id = v_batch.id
  ),
  updated_rows as (
    update public.salary_records sr
    set expenses = coalesce(at.approved_expense, 0),
        total_additions = coalesce(sr.total_additions, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0),
        second_part = coalesce(sr.second_part, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0),
        month_salary = coalesce(sr.month_salary, coalesce(sr.first_part, 0) + coalesce(sr.second_part, 0)) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0)
    from (
      select
        sr2.id,
        at2.approved_expense
      from public.salary_records sr2
      left join approved_totals at2
        on lower(sr2.hr_id) = at2.normalized_hr_id
      where sr2.batch_id = v_batch.id
    ) at
    where sr.id = at.id
      and (
        coalesce(sr.expenses, 0) is distinct from coalesce(at.approved_expense, 0)
        or coalesce(sr.second_part, 0) is distinct from coalesce(sr.second_part, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0)
      )
    returning sr.id
  )
  select
    count(*)::integer,
    coalesce(sum(approved_expense), 0)::numeric,
    coalesce(array_agg(hr_id order by hr_id), '{}'::text[])
  into
    v_imported_employees,
    v_imported_total,
    v_matched_employees
  from matched_totals;

  return jsonb_build_object(
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'matched_employees', to_jsonb(v_matched_employees),
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;


ALTER FUNCTION "public"."phx_import_approved_expenses_to_payroll"("p_month" integer, "p_year" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_leave_balances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "leave_type_id" "uuid" NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "year" integer NOT NULL,
    "opening_balance" numeric(8,2) DEFAULT 0 NOT NULL,
    "accrued" numeric(8,2) DEFAULT 0 NOT NULL,
    "consumed" numeric(8,2) DEFAULT 0 NOT NULL,
    "pending" numeric(8,2) DEFAULT 0 NOT NULL,
    "adjusted" numeric(8,2) DEFAULT 0 NOT NULL,
    "carry_forward" numeric(8,2) DEFAULT 0 NOT NULL,
    "available_balance" numeric(8,2) DEFAULT 0 NOT NULL,
    "last_accrual_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "employee_leave_balances_year_check" CHECK ((("year" >= 2000) AND ("year" <= 2100)))
);


ALTER TABLE "public"."employee_leave_balances" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_adjust_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_amount" numeric, "p_reason" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid" DEFAULT "gen_random_uuid"()) RETURNS "public"."employee_leave_balances"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_balance public.employee_leave_balances;
begin
  if coalesce(p_amount, 0) = 0 then
    raise exception 'Adjustment amount must be a non-zero number.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Manual adjustment reason is required.';
  end if;

  v_balance := public.phx_leave_record_delta_atomic(
    p_employee_hr_id,
    p_leave_type_id,
    p_policy_id,
    p_year,
    'adjustment',
    p_amount,
    null,
    p_reason,
    p_actor_hr_id
  );

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.balance.adjusted',
    upper(trim(p_employee_hr_id)),
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'availableBalance', v_balance.available_balance)
  );

  return v_balance;
end;
$$;


ALTER FUNCTION "public"."phx_leave_adjust_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_amount" numeric, "p_reason" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_available"("p_opening" numeric, "p_accrued" numeric, "p_adjusted" numeric, "p_carry_forward" numeric, "p_consumed" numeric, "p_pending" numeric) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select round((
    coalesce(p_opening, 0)
    + coalesce(p_accrued, 0)
    + coalesce(p_adjusted, 0)
    + coalesce(p_carry_forward, 0)
    - coalesce(p_consumed, 0)
    - coalesce(p_pending, 0)
  )::numeric, 2);
$$;


ALTER FUNCTION "public"."phx_leave_available"("p_opening" numeric, "p_accrued" numeric, "p_adjusted" numeric, "p_carry_forward" numeric, "p_consumed" numeric, "p_pending" numeric) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "leave_type_id" "uuid" NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "total_calendar_days" numeric(8,2) DEFAULT 0 NOT NULL,
    "total_working_days" numeric(8,2) DEFAULT 0 NOT NULL,
    "reason" "text",
    "attachment_url" "text",
    "status" "text" DEFAULT 'pending_manager'::"text" NOT NULL,
    "manager_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "hr_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payroll_status" "text" DEFAULT 'not_required'::"text" NOT NULL,
    "manager_comment" "text",
    "hr_comment" "text",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "manager_decision_at" timestamp with time zone,
    "hr_decision_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "balance_leave_type_id" "uuid",
    "payment_status" "text" DEFAULT 'in_review'::"text" NOT NULL,
    "payment_reason" "text",
    "duration_unit" "text" DEFAULT 'full_day'::"text" NOT NULL,
    "hr_balance_decision" "text",
    "manager_of_manager_hr_id" "text",
    "approval_status_date" timestamp with time zone,
    "employee_email" "text",
    "employee_hire_date" "date",
    "employee_id" "text",
    "employee_name" "text",
    "request_type" "text",
    "vacation_type" "text",
    "day_type" "text",
    "duration_days" numeric(10,2),
    "half_day_impact" numeric(10,2),
    "total_days" numeric(10,2),
    "paid_status" "text",
    "available_balance_at_submission" numeric(10,2),
    "first_year_entitlement_at_submission" numeric(10,2),
    "current_annual_entitlement_at_submission" numeric(10,2),
    "used_paid_leave_at_submission" numeric(10,2),
    "remaining_paid_balance_at_submission" numeric(10,2),
    "unpaid_leave_days_at_submission" numeric(10,2),
    "pending_leave_impact_at_submission" numeric(10,2),
    "total_entitled_balance_at_submission" numeric(10,2),
    "rejection_reason" "text",
    "direct_manager" "text",
    "direct_manager_email" "text",
    "direct_manager_hr_id" "text",
    "approved_or_rejected_by" "text",
    "approved_or_rejected_at" timestamp with time zone,
    "submitted_at" timestamp with time zone,
    "employee_area" "text",
    "employee_line" "text",
    "employee_team" "text",
    "team" "text",
    "idempotency_key" "text",
    CONSTRAINT "leave_requests_date_check" CHECK (("end_date" >= "start_date")),
    CONSTRAINT "leave_requests_duration_unit_check" CHECK (("duration_unit" = ANY (ARRAY['full_day'::"text", 'am'::"text", 'pm'::"text"]))),
    CONSTRAINT "leave_requests_hr_balance_decision_check" CHECK ((("hr_balance_decision" IS NULL) OR ("hr_balance_decision" = ANY (ARRAY['deduct'::"text", 'no_deduct'::"text"])))),
    CONSTRAINT "leave_requests_hr_status_check" CHECK (("hr_status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'not_required'::"text"]))),
    CONSTRAINT "leave_requests_manager_status_check" CHECK (("manager_status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'not_required'::"text"]))),
    CONSTRAINT "leave_requests_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['paid'::"text", 'unpaid'::"text", 'in_review'::"text", 'non_deducted'::"text"]))),
    CONSTRAINT "leave_requests_payroll_status_check" CHECK (("payroll_status" = ANY (ARRAY['not_required'::"text", 'pending'::"text", 'processed'::"text", 'blocked'::"text"]))),
    CONSTRAINT "leave_requests_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending_manager'::"text", 'pending_hr'::"text", 'approved'::"text", 'manager_rejected'::"text", 'hr_rejected'::"text", 'cancelled'::"text", 'needs_routing'::"text"])))
);


ALTER TABLE "public"."leave_requests" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_cancel_request_atomic"("p_request_id" "uuid", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid" DEFAULT "gen_random_uuid"()) RETURNS "public"."leave_requests"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_request public.leave_requests;
  v_existing_approval uuid;
begin
  select * into v_request from public.leave_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request was not found.';
  end if;

  if v_request.status = 'cancelled' then
    return v_request;
  end if;

  perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);

  update public.leave_requests
  set hr_comment = coalesce(nullif(trim(coalesce(p_comment, '')), ''), hr_comment),
      status = 'cancelled',
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  select id into v_existing_approval
  from public.leave_approvals
  where request_id = p_request_id and approval_step = 'system' and status = 'cancelled'
  limit 1;

  if v_existing_approval is null then
    insert into public.leave_approvals (
      request_id,
      approver_hr_id,
      approver_role,
      approval_step,
      status,
      comment
    )
    values (
      p_request_id,
      upper(trim(coalesce(p_actor_hr_id, 'SYSTEM'))),
      coalesce(p_actor_role, 'system'),
      'system',
      'cancelled',
      coalesce(nullif(trim(coalesce(p_comment, '')), ''), 'Request cancelled')
    );
  end if;

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.request.cancelled',
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('status', v_request.status, 'comment', p_comment, 'paymentStatus', v_request.payment_status)
  );

  return v_request;
end;
$$;


ALTER FUNCTION "public"."phx_leave_cancel_request_atomic"("p_request_id" "uuid", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_consume_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_balance_leave_type_id uuid;
  v_balance public.employee_leave_balances;
  v_exists uuid;
  v_amount numeric;
begin
  v_balance_leave_type_id := p_request.balance_leave_type_id;
  if v_balance_leave_type_id is null then
    return;
  end if;

  select id into v_exists
  from public.leave_transactions
  where request_id = p_request.id and transaction_type = 'consumed'
  limit 1;
  if v_exists is not null then
    return;
  end if;

  v_balance := public.phx_leave_ensure_balance_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer
  );

  if v_balance.pending > 0 then
    v_amount := least(v_balance.pending, p_request.total_working_days);
    perform public.phx_leave_record_delta_atomic(
      p_request.employee_hr_id,
      v_balance_leave_type_id,
      p_request.policy_id,
      extract(year from p_request.start_date)::integer,
      'pending_reversal',
      v_amount,
      p_request.id,
      'Pending request approved',
      p_actor_hr_id
    );
  end if;

  perform public.phx_leave_record_delta_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer,
    'consumed',
    p_request.total_working_days,
    p_request.id,
    'HR approved leave',
    p_actor_hr_id
  );
end;
$$;


ALTER FUNCTION "public"."phx_leave_consume_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_ensure_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer) RETURNS "public"."employee_leave_balances"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_balance public.employee_leave_balances;
begin
  insert into public.employee_leave_balances (
    employee_hr_id,
    leave_type_id,
    policy_id,
    year,
    available_balance
  )
  values (
    upper(trim(p_employee_hr_id)),
    p_leave_type_id,
    p_policy_id,
    p_year,
    0
  )
  on conflict (employee_hr_id, leave_type_id, policy_id, year) do nothing;

  select *
    into v_balance
  from public.employee_leave_balances
  where employee_hr_id = upper(trim(p_employee_hr_id))
    and leave_type_id = p_leave_type_id
    and policy_id = p_policy_id
    and year = p_year
  for update;

  if v_balance.id is null then
    raise exception 'Leave balance could not be created or locked.';
  end if;

  return v_balance;
end;
$$;


ALTER FUNCTION "public"."phx_leave_ensure_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_hr_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_decision" "text" DEFAULT NULL::"text", "p_correlation_id" "uuid" DEFAULT "gen_random_uuid"()) RETURNS "public"."leave_requests"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_request public.leave_requests;
  v_leave_type public.leave_types;
  v_next_payment_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid HR decision.';
  end if;
  if p_balance_decision is not null and p_balance_decision not in ('deduct', 'no_deduct') then
    raise exception 'Invalid HR balance decision.';
  end if;
  if p_decision = 'rejected' and nullif(trim(coalesce(p_comment, '')), '') is null then
    raise exception 'A rejection comment is required.';
  end if;

  select * into v_request from public.leave_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request was not found.';
  end if;
  if v_request.status not in ('pending_hr', 'manager_approved') then
    raise exception 'This request is not pending HR approval.';
  end if;

  select * into v_leave_type from public.leave_types where id = v_request.leave_type_id;
  if p_decision = 'approved' and v_leave_type.code = 'other' and p_balance_decision is null then
    raise exception 'HR must choose whether Other leave deducts from balance.';
  end if;

  v_next_payment_status := case
    when p_decision = 'rejected' then v_request.payment_status
    when p_balance_decision = 'deduct' then 'paid'
    when p_balance_decision = 'no_deduct' then 'non_deducted'
    when v_request.payment_status = 'unpaid' then 'unpaid'
    when v_leave_type.code in ('sick_leave') then 'paid'
    else v_request.payment_status
  end;

  if p_decision = 'approved' and (p_balance_decision = 'deduct' or (v_request.payment_status = 'paid' and v_request.balance_leave_type_id is not null)) then
    perform public.phx_leave_consume_pending_atomic(v_request, p_actor_hr_id);
  elsif p_decision = 'rejected' then
    perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);
  end if;

  update public.leave_requests
  set hr_balance_decision = case when p_decision = 'approved' then p_balance_decision else hr_balance_decision end,
      hr_comment = nullif(trim(coalesce(p_comment, '')), ''),
      hr_decision_at = now(),
      hr_status = p_decision,
      payment_status = v_next_payment_status,
      payment_reason = case
        when p_decision = 'approved' and p_balance_decision = 'deduct' then 'HR approved deduction from annual leave balance'
        when p_decision = 'approved' and p_balance_decision = 'no_deduct' then 'HR approved without annual balance deduction'
        when p_decision = 'approved' and v_leave_type.code = 'sick_leave' then 'HR approved sick leave after document review'
        else payment_reason
      end,
      payroll_status = case
        when p_decision = 'approved' and coalesce(v_leave_type.affects_payroll, false) then 'pending'
        else payroll_status
      end,
      status = case when p_decision = 'approved' then 'hr_approved' else 'hr_rejected' end,
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into public.leave_approvals (
    request_id,
    approver_hr_id,
    approver_role,
    approval_step,
    status,
    comment
  )
  values (
    p_request_id,
    upper(trim(coalesce(p_actor_hr_id, ''))),
    coalesce(p_actor_role, 'HR Specialist'),
    'hr',
    p_decision,
    nullif(trim(concat_ws(
      ' | ',
      nullif(trim(coalesce(p_comment, '')), ''),
      case when p_balance_decision is null then null else 'Balance decision: ' || p_balance_decision end
    )), '')
  );

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.hr.' || p_decision,
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object(
      'status', v_request.status,
      'payrollStatus', v_request.payroll_status,
      'paymentStatus', v_request.payment_status,
      'balanceDecision', p_balance_decision
    )
  );

  return v_request;
end;
$$;


ALTER FUNCTION "public"."phx_leave_hr_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_decision" "text", "p_correlation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_manager_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid" DEFAULT "gen_random_uuid"()) RETURNS "public"."leave_requests"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_request public.leave_requests;
  v_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid manager decision.';
  end if;
  if p_decision = 'rejected' and nullif(trim(coalesce(p_comment, '')), '') is null then
    raise exception 'A rejection comment is required.';
  end if;

  select * into v_request from public.leave_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request was not found.';
  end if;
  if v_request.status <> 'pending_manager' then
    raise exception 'This request is not pending manager approval.';
  end if;

  v_status := case when p_decision = 'approved' then 'pending_hr' else 'manager_rejected' end;

  update public.leave_requests
  set manager_comment = nullif(trim(coalesce(p_comment, '')), ''),
      manager_decision_at = now(),
      manager_status = p_decision,
      status = v_status,
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into public.leave_approvals (
    request_id,
    approver_hr_id,
    approver_role,
    approval_step,
    status,
    comment
  )
  values (
    p_request_id,
    upper(trim(coalesce(p_actor_hr_id, ''))),
    coalesce(p_actor_role, 'Manager'),
    'manager',
    p_decision,
    nullif(trim(coalesce(p_comment, '')), '')
  );

  if p_decision = 'rejected' then
    perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);
  end if;

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.manager.' || p_decision,
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('status', v_request.status)
  );

  return v_request;
end;
$$;


ALTER FUNCTION "public"."phx_leave_manager_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_record_delta_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_transaction_type" "text", "p_amount" numeric, "p_request_id" "uuid", "p_notes" "text", "p_created_by" "text") RETURNS "public"."employee_leave_balances"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_balance public.employee_leave_balances;
  v_next_opening numeric;
  v_next_accrued numeric;
  v_next_consumed numeric;
  v_next_pending numeric;
  v_next_adjusted numeric;
  v_next_carry_forward numeric;
  v_next_available numeric;
begin
  v_balance := public.phx_leave_ensure_balance_atomic(p_employee_hr_id, p_leave_type_id, p_policy_id, p_year);

  v_next_opening := v_balance.opening_balance;
  v_next_accrued := v_balance.accrued;
  v_next_consumed := v_balance.consumed;
  v_next_pending := v_balance.pending;
  v_next_adjusted := v_balance.adjusted;
  v_next_carry_forward := v_balance.carry_forward;

  if p_transaction_type = 'opening_balance' then v_next_opening := v_next_opening + p_amount; end if;
  if p_transaction_type = 'accrual' then v_next_accrued := v_next_accrued + p_amount; end if;
  if p_transaction_type = 'carry_forward' then v_next_carry_forward := v_next_carry_forward + p_amount; end if;
  if p_transaction_type = 'adjustment' then v_next_adjusted := v_next_adjusted + p_amount; end if;
  if p_transaction_type = 'pending' then v_next_pending := v_next_pending + p_amount; end if;
  if p_transaction_type = 'pending_reversal' then v_next_pending := greatest(0, v_next_pending - p_amount); end if;
  if p_transaction_type = 'consumed' then v_next_consumed := v_next_consumed + p_amount; end if;
  if p_transaction_type = 'consumed_reversal' then v_next_consumed := greatest(0, v_next_consumed - p_amount); end if;

  v_next_available := public.phx_leave_available(
    v_next_opening,
    v_next_accrued,
    v_next_adjusted,
    v_next_carry_forward,
    v_next_consumed,
    v_next_pending
  );

  insert into public.leave_transactions (
    employee_hr_id,
    leave_type_id,
    policy_id,
    request_id,
    transaction_type,
    amount,
    balance_before,
    balance_after,
    notes,
    created_by
  )
  values (
    upper(trim(p_employee_hr_id)),
    p_leave_type_id,
    p_policy_id,
    p_request_id,
    p_transaction_type,
    p_amount,
    v_balance.available_balance,
    v_next_available,
    p_notes,
    p_created_by
  );

  update public.employee_leave_balances
  set opening_balance = v_next_opening,
      accrued = v_next_accrued,
      consumed = v_next_consumed,
      pending = v_next_pending,
      adjusted = v_next_adjusted,
      carry_forward = v_next_carry_forward,
      available_balance = v_next_available,
      updated_at = now()
  where id = v_balance.id
  returning * into v_balance;

  return v_balance;
end;
$$;


ALTER FUNCTION "public"."phx_leave_record_delta_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_transaction_type" "text", "p_amount" numeric, "p_request_id" "uuid", "p_notes" "text", "p_created_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_release_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_balance_leave_type_id uuid;
  v_balance public.employee_leave_balances;
  v_exists uuid;
  v_amount numeric;
begin
  v_balance_leave_type_id := p_request.balance_leave_type_id;
  if v_balance_leave_type_id is null then
    return;
  end if;

  select id into v_exists
  from public.leave_transactions
  where request_id = p_request.id and transaction_type = 'pending_reversal'
  limit 1;
  if v_exists is not null then
    return;
  end if;

  v_balance := public.phx_leave_ensure_balance_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer
  );

  if v_balance.pending <= 0 then
    return;
  end if;

  v_amount := least(v_balance.pending, p_request.total_working_days);
  perform public.phx_leave_record_delta_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer,
    'pending_reversal',
    v_amount,
    p_request.id,
    'Pending request released',
    p_actor_hr_id
  );
end;
$$;


ALTER FUNCTION "public"."phx_leave_release_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_run_accrual_atomic"("p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_month" integer, "p_entries" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid" DEFAULT "gen_random_uuid"()) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_entry record;
  v_period text := p_year::text || '-' || lpad(p_month::text, 2, '0');
  v_notes text := 'monthly-accrual:' || p_year::text || '-' || lpad(p_month::text, 2, '0');
  v_processed integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_exists uuid;
  v_balance public.employee_leave_balances;
begin
  if p_month < 1 or p_month > 12 then
    raise exception 'Invalid accrual month.';
  end if;

  for v_entry in
    select *
    from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb))
      as entry(employee_hr_id text, amount numeric, accrual_date date, period text)
  loop
    if coalesce(v_entry.amount, 0) <= 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_notes := 'monthly-accrual:' || coalesce(v_entry.period, v_period);

    select id into v_exists
    from public.leave_transactions
    where employee_hr_id = upper(trim(v_entry.employee_hr_id))
      and leave_type_id = p_leave_type_id
      and policy_id = p_policy_id
      and transaction_type = 'accrual'
      and notes = v_notes
    limit 1;

    if v_exists is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_balance := public.phx_leave_record_delta_atomic(
      v_entry.employee_hr_id,
      p_leave_type_id,
      p_policy_id,
      p_year,
      'accrual',
      v_entry.amount,
      null,
      v_notes,
      p_actor_hr_id
    );

    update public.employee_leave_balances
    set last_accrual_date = greatest(coalesce(last_accrual_date, v_entry.accrual_date), v_entry.accrual_date),
        updated_at = now()
    where id = v_balance.id;

    v_processed := v_processed + 1;
    v_total := v_total + v_entry.amount;
  end loop;

  insert into public.leave_accrual_runs (
    correlation_id,
    period,
    year,
    month,
    status,
    dry_run,
    actor_hr_id,
    processed_count,
    skipped_count,
    total_amount,
    completed_at,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    v_period,
    p_year,
    p_month,
    'completed',
    false,
    p_actor_hr_id,
    v_processed,
    v_skipped,
    v_total,
    now(),
    jsonb_build_object('entryCount', coalesce(jsonb_array_length(p_entries), 0))
  );

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.accrual.completed',
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('period', v_period, 'processed', v_processed, 'skipped', v_skipped, 'totalAmount', v_total)
  );

  return jsonb_build_object(
    'period', v_period,
    'month', p_month,
    'year', p_year,
    'processed', v_processed,
    'skipped', v_skipped,
    'totalAmount', v_total
  );
end;
$$;


ALTER FUNCTION "public"."phx_leave_run_accrual_atomic"("p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_month" integer, "p_entries" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_leave_submit_request_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_total_calendar_days" numeric, "p_total_working_days" numeric, "p_reason" "text", "p_attachment_url" "text", "p_status" "text", "p_manager_status" "text", "p_hr_status" "text", "p_payroll_status" "text", "p_should_consume" boolean, "p_allow_negative_balance" boolean, "p_accruals" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_leave_type_id" "uuid" DEFAULT NULL::"uuid", "p_payment_status" "text" DEFAULT 'in_review'::"text", "p_payment_reason" "text" DEFAULT NULL::"text", "p_duration_unit" "text" DEFAULT 'full_day'::"text", "p_correlation_id" "uuid" DEFAULT "gen_random_uuid"()) RETURNS "public"."leave_requests"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_request public.leave_requests;
  v_balance public.employee_leave_balances;
  v_entry record;
  v_notes text;
  v_exists uuid;
  v_balance_leave_type_id uuid;
begin
  if p_end_date < p_start_date then
    raise exception 'Invalid leave date range.';
  end if;
  if p_total_working_days <= 0 then
    raise exception 'The selected range contains no working leave days.';
  end if;
  if p_duration_unit not in ('full_day', 'am', 'pm') then
    raise exception 'Invalid duration selection.';
  end if;
  if p_duration_unit in ('am', 'pm') and p_start_date <> p_end_date then
    raise exception 'AM/PM leave is only allowed for single-day requests.';
  end if;
  if p_payment_status not in ('paid', 'unpaid', 'in_review', 'non_deducted') then
    raise exception 'Invalid leave payment status.';
  end if;

  v_balance_leave_type_id := p_balance_leave_type_id;

  if p_should_consume then
    if v_balance_leave_type_id is null then
      raise exception 'Balance leave type is required for deductible leave.';
    end if;

    v_balance := public.phx_leave_ensure_balance_atomic(
      p_employee_hr_id,
      v_balance_leave_type_id,
      p_policy_id,
      extract(year from p_start_date)::integer
    );

    for v_entry in
      select *
      from jsonb_to_recordset(coalesce(p_accruals, '[]'::jsonb))
        as accrual(period text, amount numeric, accrual_date date)
    loop
      v_notes := 'monthly-accrual:' || v_entry.period;
      select id into v_exists
      from public.leave_transactions
      where employee_hr_id = upper(trim(p_employee_hr_id))
        and leave_type_id = v_balance_leave_type_id
        and policy_id = p_policy_id
        and transaction_type = 'accrual'
        and notes = v_notes
      limit 1;

      if v_exists is null and coalesce(v_entry.amount, 0) > 0 then
        v_balance := public.phx_leave_record_delta_atomic(
          p_employee_hr_id,
          v_balance_leave_type_id,
          p_policy_id,
          extract(year from p_start_date)::integer,
          'accrual',
          v_entry.amount,
          null,
          v_notes,
          p_actor_hr_id
        );

        update public.employee_leave_balances
        set last_accrual_date = greatest(coalesce(last_accrual_date, v_entry.accrual_date), v_entry.accrual_date),
            updated_at = now()
        where id = v_balance.id
        returning * into v_balance;
      end if;
    end loop;

    if not p_allow_negative_balance and v_balance.available_balance < p_total_working_days then
      raise exception 'Insufficient leave balance. Available: % days.', v_balance.available_balance;
    end if;
  end if;

  insert into public.leave_requests (
    attachment_url,
    balance_leave_type_id,
    duration_unit,
    employee_hr_id,
    end_date,
    hr_status,
    leave_type_id,
    manager_status,
    payment_reason,
    payment_status,
    payroll_status,
    policy_id,
    reason,
    start_date,
    status,
    total_calendar_days,
    total_working_days
  )
  values (
    p_attachment_url,
    v_balance_leave_type_id,
    p_duration_unit,
    upper(trim(p_employee_hr_id)),
    p_end_date,
    p_hr_status,
    p_leave_type_id,
    p_manager_status,
    nullif(trim(coalesce(p_payment_reason, '')), ''),
    p_payment_status,
    p_payroll_status,
    p_policy_id,
    nullif(trim(coalesce(p_reason, '')), ''),
    p_start_date,
    p_status,
    p_total_calendar_days,
    p_total_working_days
  )
  returning * into v_request;

  if p_should_consume then
    perform public.phx_leave_record_delta_atomic(
      p_employee_hr_id,
      v_balance_leave_type_id,
      p_policy_id,
      extract(year from p_start_date)::integer,
      'pending',
      p_total_working_days,
      v_request.id,
      'Request submitted',
      p_actor_hr_id
    );
  end if;

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.request.submitted',
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object(
      'status', v_request.status,
      'workingDays', p_total_working_days,
      'durationUnit', p_duration_unit,
      'paymentStatus', p_payment_status,
      'paymentReason', p_payment_reason,
      'balanceLeaveTypeId', v_balance_leave_type_id
    )
  );

  return v_request;
end;
$$;


ALTER FUNCTION "public"."phx_leave_submit_request_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_total_calendar_days" numeric, "p_total_working_days" numeric, "p_reason" "text", "p_attachment_url" "text", "p_status" "text", "p_manager_status" "text", "p_hr_status" "text", "p_payroll_status" "text", "p_should_consume" boolean, "p_allow_negative_balance" boolean, "p_accruals" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_leave_type_id" "uuid", "p_payment_status" "text", "p_payment_reason" "text", "p_duration_unit" "text", "p_correlation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_prevent_closed_salary_batch_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(current_setting('request.phx_allow_salary_batch_delete', true), '') = 'on' then
    return old;
  end if;

  if old.status in ('approved', 'locked') or old.part1_paid_at is not null then
    raise exception 'Payroll batch cannot be deleted after Part 1 is paid or while status is %.', old.status using errcode = 'P0001';
  end if;

  return old;
end;
$$;


ALTER FUNCTION "public"."phx_prevent_closed_salary_batch_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_prevent_closed_salary_batch_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if old.status in ('approved', 'locked') then
    if old.status = 'approved'
      and new.status = 'locked'
      and new.id is not distinct from old.id
      and new.month is not distinct from old.month
      and new.year is not distinct from old.year
      and new.file_name is not distinct from old.file_name
      and new.uploaded_by is not distinct from old.uploaded_by
      and new.approved_at is not distinct from old.approved_at
      and new.approved_by is not distinct from old.approved_by
      and new.part1_paid_at is not distinct from old.part1_paid_at
      and new.part1_paid_by is not distinct from old.part1_paid_by
      and new.part2_ready_at is not distinct from old.part2_ready_at
      and new.part2_ready_by is not distinct from old.part2_ready_by
      and new.rejected_reason is not distinct from old.rejected_reason
      and new.created_at is not distinct from old.created_at then
      return new;
    end if;

    raise exception 'Payroll batch cannot be updated while status is %.', old.status using errcode = 'P0001';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."phx_prevent_closed_salary_batch_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_prevent_closed_salary_detail_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_batch_id uuid;
  v_batch_status text;
  v_part1_paid_at timestamptz;
begin
  if tg_op = 'DELETE' then
    v_batch_id := old.batch_id;
  else
    v_batch_id := new.batch_id;
  end if;

  select status, part1_paid_at
  into v_batch_status, v_part1_paid_at
  from public.salary_batches
  where id = v_batch_id;

  if v_batch_status in ('approved', 'locked') then
    raise exception 'Payroll batch cannot be changed while status is %.', v_batch_status using errcode = 'P0001';
  end if;

  if tg_table_name = 'salary_records' and v_part1_paid_at is not null then
    if tg_op <> 'UPDATE' then
      raise exception 'Salary records cannot be inserted or deleted after Part 1 is paid.' using errcode = 'P0001';
    end if;

    if new.batch_id is distinct from old.batch_id
      or new.hr_id is distinct from old.hr_id
      or new.full_name is distinct from old.full_name
      or new.name_ar is distinct from old.name_ar
      or new.job_title is distinct from old.job_title
      or new.line is distinct from old.line
      or new.area is distinct from old.area
      or new.hire_date is distinct from old.hire_date
      or new.base_salary is distinct from old.base_salary
      or new.gross_salary is distinct from old.gross_salary
      or new.net_salary is distinct from old.net_salary
      or new.first_part is distinct from old.first_part
      or new.extra_cost_of_living is distinct from old.extra_cost_of_living
      or new.fuel_allowance is distinct from old.fuel_allowance
      or new.social_insurance is distinct from old.social_insurance
      or new.employment_income_tax is distinct from old.employment_income_tax
      or new.governmental_deductions is distinct from old.governmental_deductions
      or new.payment_mode is distinct from old.payment_mode then
      raise exception 'Part 1 salary fields cannot be changed after Part 1 is paid.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."phx_prevent_closed_salary_detail_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_prevent_duplicate_salary_period"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if exists (
    select 1
    from public.salary_batches existing
    where existing.month = new.month
      and existing.year = new.year
      and existing.id is distinct from new.id
  ) then
    raise exception 'Payroll period %/% already has a batch.', new.month, new.year using errcode = '23505';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."phx_prevent_duplicate_salary_period"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_prevent_employee_hr_id_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.hr_id is distinct from old.hr_id then
    raise exception 'HR_ID is immutable after employee creation. Use the governed HR_ID rename workflow.';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."phx_prevent_employee_hr_id_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_reassign_replacement_ownership"("p_previous_hr_id" "text", "p_replacement_hr_id" "text", "p_effective_date" "date" DEFAULT NULL::"date") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_previous_hr_id text := upper(trim(coalesce(p_previous_hr_id, '')));
  v_replacement_hr_id text := upper(trim(coalesce(p_replacement_hr_id, '')));
  v_effective_date date := coalesce(p_effective_date, current_date);
  v_previous_status text;
  v_replacement_name text;
  v_replacement_status text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  if v_previous_hr_id = '' or v_replacement_hr_id = '' then
    return jsonb_build_object('applied', false, 'reason', 'missing_hr_id');
  end if;

  if v_previous_hr_id = v_replacement_hr_id then
    return jsonb_build_object('applied', false, 'reason', 'same_hr_id');
  end if;

  select lower(coalesce(employment_status, 'active'))
  into v_previous_status
  from public.employees
  where hr_id = v_previous_hr_id;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if v_previous_status not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  select full_name, lower(coalesce(employment_status, 'active'))
  into v_replacement_name, v_replacement_status
  from public.employees
  where hr_id = v_replacement_hr_id
    and coalesce(payroll_eligible, true) is true
    and coalesce(organogram_visible, true) is true;

  if not found or v_replacement_status not in ('active', 'on_leave') then
    return jsonb_build_object('applied', false, 'reason', 'replacement_employee_not_active');
  end if;

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users u
         set manager_hr_id = $2, updated_at = now()
         where u.is_active is true
           and (
             u.manager_hr_id = $1
             or exists (
               select 1
               from public.employees e
               where e.hr_id = u.hr_id
                 and e.pending_manager_replacement_for_hr_id = $1
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('app_auth_users_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('app_auth_users_reassigned', null);
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles u
         set manager_hr_id = $2, updated_at = now()
         where u.is_active is true
           and (
             u.manager_hr_id = $1
             or exists (
               select 1
               from public.employees e
               where e.hr_id = u.hr_id
                 and e.pending_manager_replacement_for_hr_id = $1
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', null);
    end;
  end if;

  update public.employees
  set
    manager_hr_id = v_replacement_hr_id,
    pending_manager_replacement_for_hr_id = null,
    updated_at = now()
  where (
      manager_hr_id = v_previous_hr_id
      or pending_manager_replacement_for_hr_id = v_previous_hr_id
    )
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_reassigned', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_replacement_hr_id,
    manager_name = v_replacement_name,
    manager_replacement_for_hr_id = null,
    note = case
      when coalesce(note, '') ilike '%Replacement ownership engine:%' then note
      else concat_ws(
        E'\n',
        nullif(note, ''),
        'Replacement ownership engine: moved live vacancy manager from '
          || v_previous_hr_id || ' to ' || v_replacement_hr_id || ' on ' || current_date::text || '.'
      )
    end,
    updated_at = now()
  where (
      manager_hr_id = v_previous_hr_id
      or manager_replacement_for_hr_id = v_previous_hr_id
    )
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_reassigned', v_count);

  if to_regclass('public.sales_records') is not null then
    begin
      execute
        'update public.sales_records
         set manager_hr_id = $2
         where manager_hr_id = $1
           and (
             year > extract(year from $3::date)::integer
             or (
               year = extract(year from $3::date)::integer
               and month >= extract(month from $3::date)::integer
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id, v_effective_date;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('sales_records_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('sales_records_reassigned', null);
    end;
  end if;

  if to_regclass('public.sales_targets') is not null then
    begin
      execute
        'update public.sales_targets
         set manager_hr_id = $2
         where manager_hr_id = $1
           and (
             year > extract(year from $3::date)::integer
             or (
               year = extract(year from $3::date)::integer
               and month >= extract(month from $3::date)::integer
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id, v_effective_date;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('sales_targets_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('sales_targets_reassigned', null);
    end;
  end if;

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous_hr_id,
    'replacement_hr_id', v_replacement_hr_id,
    'effective_date', v_effective_date
  ) || v_result;
end;
$_$;


ALTER FUNCTION "public"."phx_reassign_replacement_ownership"("p_previous_hr_id" "text", "p_replacement_hr_id" "text", "p_effective_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_release_terminal_manager_ownership"("p_previous_hr_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_previous public.employees%rowtype;
  v_upstream_name text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  select *
  into v_previous
  from public.employees
  where hr_id = upper(trim(coalesce(p_previous_hr_id, '')));

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if lower(coalesce(v_previous.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  if nullif(trim(coalesce(v_previous.manager_hr_id, '')), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'upstream_manager_missing');
  end if;

  select full_name
  into v_upstream_name
  from public.employees
  where hr_id = v_previous.manager_hr_id;

  update public.employees
  set
    manager_hr_id = v_previous.manager_hr_id,
    pending_manager_replacement_for_hr_id = v_previous.hr_id,
    updated_at = now()
  where manager_hr_id = v_previous.hr_id
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_released_to_upstream', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_previous.manager_hr_id,
    manager_name = v_upstream_name,
    manager_replacement_for_hr_id = v_previous.hr_id,
    note = case
      when coalesce(note, '') ilike '%Pending replacement ownership:%' then note
      else concat_ws(
        E'\n',
        nullif(note, ''),
        'Pending replacement ownership: temporarily moved from terminal manager '
          || v_previous.hr_id || ' to upstream manager ' || v_previous.manager_hr_id
          || ' on ' || current_date::text || '.'
      )
    end,
    updated_at = now()
  where manager_hr_id = v_previous.hr_id
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_released_to_upstream', v_count);

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous.hr_id, v_previous.manager_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('app_auth_users_released_to_upstream', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('app_auth_users_released_to_upstream', null);
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous.hr_id, v_previous.manager_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_released_to_upstream', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_released_to_upstream', null);
    end;
  end if;

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous.hr_id,
    'upstream_manager_hr_id', v_previous.manager_hr_id
  ) || v_result;
end;
$_$;


ALTER FUNCTION "public"."phx_release_terminal_manager_ownership"("p_previous_hr_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_release_terminal_manager_ownership_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if lower(coalesce(new.employment_status, 'active')) in ('resigned', 'terminated', 'inactive') then
    perform public.phx_release_terminal_manager_ownership(new.hr_id);
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."phx_release_terminal_manager_ownership_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_replace_salary_batch"("p_batch_id" "uuid", "p_expected_month" integer, "p_expected_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_updated_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_batch public.salary_batches%rowtype;
  v_records jsonb := coalesce(p_records, '[]'::jsonb);
  v_flags jsonb := coalesce(p_flags, '[]'::jsonb);
begin
  if jsonb_typeof(v_records) <> 'array' then
    raise exception 'Payroll replacement records must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_flags) <> 'array' then
    raise exception 'Payroll replacement flags must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_array_length(v_records) = 0 then
    raise exception 'Payroll replacement records must include at least one salary record.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_records) as r(payment_mode text)
    where coalesce(r.payment_mode, 'two_parts') not in ('one_part', 'two_parts')
  ) then
    raise exception 'Payroll replacement payment_mode must be one_part or two_parts.' using errcode = '22023';
  end if;

  select *
  into v_batch
  from public.salary_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Payroll upload not found.' using errcode = 'P0002';
  end if;

  if v_batch.part1_paid_at is not null or v_batch.status not in ('uploaded', 'part1_ready', 'rejected') then
    raise exception 'Payroll batch cannot be replaced after Part 1 is paid or while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  if v_batch.month is distinct from p_expected_month or v_batch.year is distinct from p_expected_year then
    raise exception 'Payroll batch period changed before replacement could be applied.' using errcode = 'P0001';
  end if;

  delete from public.salary_records
  where batch_id = p_batch_id;

  insert into public.salary_records (
    area,
    base_salary,
    batch_id,
    bonus,
    crm,
    employment_income_tax,
    expenses,
    extra_cost_of_living,
    finger_print,
    first_part,
    fuel_allowance,
    full_name,
    governmental_deductions,
    gross_salary,
    hire_date,
    hr_id,
    incentive,
    job_title,
    line,
    loans,
    medical_insurance,
    month_salary,
    name_ar,
    net_salary,
    other_additions,
    other_deductions,
    overtime,
    comment,
    payment_mode,
    second_part,
    social_insurance,
    total_additions,
    total_deductions,
    unpaid_vacations
  )
  select
    r.area,
    coalesce(r.base_salary, 0),
    p_batch_id,
    r.bonus,
    r.crm,
    r.employment_income_tax,
    r.expenses,
    r.extra_cost_of_living,
    r.finger_print,
    r.first_part,
    r.fuel_allowance,
    r.full_name,
    coalesce(r.governmental_deductions, coalesce(r.social_insurance, 0) + coalesce(r.employment_income_tax, 0)),
    r.gross_salary,
    r.hire_date,
    r.hr_id,
    r.incentive,
    r.job_title,
    r.line,
    r.loans,
    r.medical_insurance,
    coalesce(r.month_salary, coalesce(r.first_part, 0) + coalesce(r.second_part, 0)),
    r.name_ar,
    r.net_salary,
    r.other_additions,
    r.other_deductions,
    r.overtime,
    r.comment,
    coalesce(r.payment_mode, 'two_parts'),
    r.second_part,
    r.social_insurance,
    r.total_additions,
    r.total_deductions,
    r.unpaid_vacations
  from jsonb_to_recordset(v_records) as r(
    area text,
    base_salary numeric,
    bonus numeric,
    crm numeric,
    employment_income_tax numeric,
    expenses numeric,
    extra_cost_of_living numeric,
    finger_print numeric,
    first_part numeric,
    fuel_allowance numeric,
    full_name text,
    governmental_deductions numeric,
    gross_salary numeric,
    hire_date date,
    hr_id text,
    incentive numeric,
    job_title text,
    line text,
    loans numeric,
    medical_insurance numeric,
    month_salary numeric,
    name_ar text,
    net_salary numeric,
    other_additions numeric,
    other_deductions numeric,
    overtime numeric,
    comment text,
    payment_mode text,
    second_part numeric,
    social_insurance numeric,
    total_additions numeric,
    total_deductions numeric,
    unpaid_vacations numeric
  );

  delete from public.salary_flags
  where batch_id = p_batch_id;

  insert into public.salary_flags (
    batch_id,
    flag_type,
    hr_id,
    message,
    severity
  )
  select
    p_batch_id,
    f.flag_type,
    f.hr_id,
    f.message,
    coalesce(f.severity, 'warning')
  from jsonb_to_recordset(v_flags) as f(
    flag_type text,
    hr_id text,
    message text,
    severity text
  );

  update public.salary_batches
  set
    approved_at = null,
    approved_by = null,
    file_name = p_file_name,
    locked_at = null,
    part1_paid_at = null,
    part1_paid_by = null,
    part2_ready_at = null,
    part2_ready_by = null,
    rejected_reason = null,
    status = 'uploaded',
    updated_at = p_updated_at,
    uploaded_by = p_uploaded_by
  where id = p_batch_id
  returning *
  into v_batch;

  return to_jsonb(v_batch);
end;
$$;


ALTER FUNCTION "public"."phx_replace_salary_batch"("p_batch_id" "uuid", "p_expected_month" integer, "p_expected_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_updated_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."phx_resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_effective_date" "date", "p_submitted_date" "date", "p_employee_status" "text", "p_reason" "text" DEFAULT NULL::"text", "p_workflow_notes" "text" DEFAULT NULL::"text", "p_actor" "text" DEFAULT NULL::"text", "p_submitted_by_hr_id" "text" DEFAULT NULL::"text", "p_vacancy_code" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_employee public.employees%rowtype;
  v_employee_status text;
  v_line_name text;
  v_manager_name text;
  v_resignation_id uuid;
  v_vacancy_code text;
  v_vacancy_id bigint;
begin
  v_employee_status := lower(nullif(trim(coalesce(p_employee_status, 'resigned')), ''));

  if v_employee_status not in ('resigned', 'terminated', 'inactive') then
    raise exception 'Resignation employee status must be resigned, terminated, or inactive.';
  end if;

  if p_effective_date is null then
    raise exception 'Effective resignation date is required.';
  end if;

  if p_submitted_date is null then
    p_submitted_date := current_date;
  end if;

  select *
  into v_employee
  from public.employees
  where hr_id = upper(trim(p_employee_hr_id))
  for update;

  if not found then
    raise exception 'Employee was not found in the directory.';
  end if;

  if lower(coalesce(v_employee.employment_status, 'active')) in ('resigned', 'terminated') then
    raise exception 'Employee is already in a terminal lifecycle status.';
  end if;

  select name into v_line_name
  from public.lines
  where id = v_employee.line_id;

  select full_name into v_manager_name
  from public.employees
  where hr_id = v_employee.manager_hr_id;

  v_vacancy_code := coalesce(
    nullif(trim(p_vacancy_code), ''),
    'resignation_' || v_employee.hr_id || '_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
  );

  insert into public.position_vacancies (
    area_id,
    created_at,
    department_id,
    job_title,
    line_id,
    manager_hr_id,
    manager_name,
    note,
    position_id,
    region_name,
    replacement_for_hr_id,
    status,
    updated_at,
    vacancy_code
  )
  values (
    v_employee.area_id,
    now(),
    v_employee.department_id,
    v_employee.job_title,
    v_employee.line_id,
    v_employee.manager_hr_id,
    v_manager_name,
    'Auto-opened from resignation of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective ' || p_effective_date::text || '.',
    v_employee.position_id,
    v_employee.region_name,
    v_employee.hr_id,
    'open',
    now(),
    v_vacancy_code
  )
  returning id into v_vacancy_id;

  insert into public.employee_resignations (
    employee_hr_id,
    employee_name,
    job_title,
    line_name,
    submitted_date,
    effective_date,
    resignation_date,
    last_working_date,
    reason,
    workflow_notes,
    status,
    exit_status,
    notes,
    created_by,
    create_vacancy,
    vacancy_id,
    submitted_by_hr_id,
    created_at,
    updated_at
  )
  values (
    v_employee.hr_id,
    v_employee.full_name,
    v_employee.job_title,
    v_line_name,
    p_submitted_date,
    p_effective_date,
    p_submitted_date,
    p_effective_date,
    p_reason,
    case
      when nullif(trim(coalesce(p_workflow_notes, '')), '') is null then
        '[' || now()::text || '] ' || coalesce(p_actor, 'system') || ': submitted resignation'
      else
        '[' || now()::text || '] ' || coalesce(p_actor, 'system') || ': submitted resignation - ' || p_workflow_notes
    end,
    'submitted',
    'submitted',
    coalesce(p_workflow_notes, p_reason),
    p_actor,
    true,
    v_vacancy_id,
    p_submitted_by_hr_id,
    now(),
    now()
  )
  returning id into v_resignation_id;

  update public.employees
  set
    employment_status = v_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    resignation_date = p_submitted_date,
    payroll_eligible = false,
    organogram_visible = false,
    updated_at = now()
  where hr_id = v_employee.hr_id;

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users set is_active = false, updated_at = now() where hr_id = $1'
        using v_employee.hr_id;
    exception when undefined_column then
      raise notice 'app_auth_users access deactivation skipped because expected columns are missing.';
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = $1'
        using v_employee.hr_id;
    exception when undefined_column then
      raise notice 'user_access_profiles access deactivation skipped because expected columns are missing.';
    end;
  end if;

  return jsonb_build_object(
    'employee_hr_id', v_employee.hr_id,
    'employee_status', v_employee_status,
    'resignation_id', v_resignation_id,
    'replacement_for_hr_id', v_employee.hr_id,
    'vacancy_id', v_vacancy_id,
    'vacancy_code', v_vacancy_code
  );
end;
$_$;


ALTER FUNCTION "public"."phx_resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_effective_date" "date", "p_submitted_date" "date", "p_employee_status" "text", "p_reason" "text", "p_workflow_notes" "text", "p_actor" "text", "p_submitted_by_hr_id" "text", "p_vacancy_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_resignation_date" "date", "p_last_working_date" "date", "p_reason" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_submitted_by_hr_id" "text" DEFAULT NULL::"text", "p_create_vacancy" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  e record;
  v_resignation_id uuid;
  v_vacancy_id bigint;
  v_vacancy_code text;
begin
  select * into e
  from public.employees
  where hr_id = p_employee_hr_id;

  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  if p_last_working_date is null then
    raise exception 'Last working date is required';
  end if;

  if p_resignation_date is null then
    raise exception 'Resignation date is required';
  end if;

  if p_last_working_date < p_resignation_date then
    raise exception 'Last working date cannot be before resignation date';
  end if;

  if p_create_vacancy then
    v_vacancy_code := 'VAC-' || p_employee_hr_id || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

    insert into public.position_vacancies (
      vacancy_code,
      department_id,
      line_id,
      area_id,
      team_id,
      position_id,
      job_title,
      status,
      note,
      manager_hr_id,
      region_name,
      created_at,
      updated_at
    )
    values (
      v_vacancy_code,
      e.department_id,
      e.line_id,
      e.area_id,
      e.team_id,
      e.position_id,
      e.job_title,
      'open',
      'Auto-created from resignation of ' || e.full_name || ' (' || e.hr_id || ')',
      e.manager_hr_id,
      e.region_name,
      now(),
      now()
    )
    returning id into v_vacancy_id;
  end if;

  insert into public.employee_resignations (
    employee_hr_id,
    resignation_date,
    last_working_date,
    reason,
    exit_status,
    notes,
    create_vacancy,
    vacancy_id,
    submitted_by_hr_id,
    created_at,
    updated_at
  )
  values (
    p_employee_hr_id,
    p_resignation_date,
    p_last_working_date,
    p_reason,
    'approved',
    p_notes,
    p_create_vacancy,
    v_vacancy_id,
    p_submitted_by_hr_id,
    now(),
    now()
  )
  returning id into v_resignation_id;

  update public.employees
  set
    employment_status = 'resigned',
    resignation_date = p_resignation_date,
    last_working_date = p_last_working_date,
    exit_reason = p_reason,
    exit_status = 'approved',
    payroll_eligible = false,
    organogram_visible = false,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  update public.app_auth_users
  set
    is_active = false,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  update public.notification_events
  set
    status = 'cancelled',
    updated_at = now(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', 'employee_resigned')
  where employee_hr_id = p_employee_hr_id
    and status in ('pending','scheduled');

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    effective_to,
    department_id,
    line_id,
    area_id,
    team_id,
    position_id,
    note,
    created_at
  )
  values (
    p_employee_hr_id,
    'resignation',
    p_resignation_date,
    p_last_working_date,
    e.department_id,
    e.line_id,
    e.area_id,
    e.team_id,
    e.position_id,
    'Resignation recorded. Vacancy ID: ' || coalesce(v_vacancy_id::text, 'none') || '. Reason: ' || coalesce(p_reason, 'not provided'),
    now()
  );

  insert into public.audit_logs (
    actor_login_id,
    entity_type,
    entity_id,
    summary,
    old_values,
    new_values,
    created_at
  )
  values (
    p_submitted_by_hr_id,
    'employee_resignation',
    p_employee_hr_id,
    'Employee resigned and lifecycle updated',
    jsonb_build_object('employment_status', e.employment_status, 'organogram_visible', e.organogram_visible, 'payroll_eligible', e.payroll_eligible),
    jsonb_build_object('employment_status', 'resigned', 'organogram_visible', false, 'payroll_eligible', false, 'vacancy_id', v_vacancy_id),
    now()
  );

  return v_resignation_id;
end;
$$;


ALTER FUNCTION "public"."resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_resignation_date" "date", "p_last_working_date" "date", "p_reason" "text", "p_notes" "text", "p_submitted_by_hr_id" "text", "p_create_vacancy" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_coaching_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_coaching_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_coaching_report"("p_report_id" "uuid", "p_actor_hr_id" "text", "p_area_of_development" "text" DEFAULT NULL::"text", "p_strength_points" "text" DEFAULT NULL::"text", "p_general_remarks" "text" DEFAULT NULL::"text", "p_scores" "jsonb" DEFAULT NULL::"jsonb") RETURNS "public"."coaching_reports"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_report public.coaching_reports%rowtype;
  v_updated public.coaching_reports%rowtype;
  v_actual_score numeric(10, 2);
  v_score_count int;
  v_final_percent numeric(6, 2);
  v_zone text;
begin
  select *
  into v_report
  from public.coaching_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Coaching report was not found.';
  end if;

  if v_report.status <> 'draft' then
    raise exception 'Only draft coaching reports can be submitted.';
  end if;

  if p_scores is not null then
    if jsonb_typeof(p_scores) <> 'object' then
      raise exception 'Coaching scores must be a JSON object.';
    end if;

    with provided as (
      select
        key,
        case
          when jsonb_typeof(value) = 'object' then value ->> 'score'
          else value #>> '{}'
        end as score_text
      from jsonb_each(p_scores)
    )
    select count(*)
    into v_score_count
    from provided;

    if v_score_count <> 20 then
      raise exception 'Exactly 20 coaching scores are required before submission.';
    end if;

    if exists (
      with expected(score_item_key) as (
        values
          ('medical_patient_knowledge'), ('product_knowledge'), ('competitor_knowledge'),
          ('opening_patient_profile_attractive_approach'), ('asking_questions_probing'),
          ('presentation_skills'), ('closing_asking_for_business'), ('handling_customer_objection'),
          ('body_language_tone_of_voice'), ('professional_pharmacy_feedback'),
          ('assertiveness_asking_for_business'), ('customer_adaptation_relationship'),
          ('time_territory_planning'), ('using_promotional_material'), ('pre_call_planning'),
          ('execution_follow_up'), ('appearance'), ('dress_code'), ('attitude'), ('discipline')
      ),
      provided as (
        select
          key,
          case
            when jsonb_typeof(value) = 'object' then value ->> 'score'
            else value #>> '{}'
          end as score_text
        from jsonb_each(p_scores)
      )
      select 1
      from provided p
      full outer join expected e on e.score_item_key = p.key
      where e.score_item_key is null
        or p.key is null
        or p.score_text is null
        or p.score_text !~ '^[0-9]+$'
        or p.score_text::int < 1
        or p.score_text::int > 6
    ) then
      raise exception 'Coaching score payload contains missing, unknown, or out-of-range items.';
    end if;

    delete from public.coaching_score_items
    where report_id = p_report_id;

    insert into public.coaching_score_items (
      report_id,
      parameter_category,
      score_item_key,
      score_item_label,
      score,
      display_order,
      area_to_be_improved,
      strength_point
    )
    with expected(score_item_key, parameter_category, score_item_label, display_order) as (
      values
        ('medical_patient_knowledge', 'knowledge', 'Medical & Patient/Physician Knowledge', 1),
        ('product_knowledge', 'knowledge', 'Product Knowledge', 2),
        ('competitor_knowledge', 'knowledge', 'Competitor Knowledge', 3),
        ('opening_patient_profile_attractive_approach', 'call_structure_skills', 'Opening, Patient Profile & Attractive Approach', 4),
        ('asking_questions_probing', 'call_structure_skills', 'Asking Questions / Probing', 5),
        ('presentation_skills', 'call_structure_skills', 'Presentation Skills', 6),
        ('closing_asking_for_business', 'call_structure_skills', 'Closing & Asking for Business', 7),
        ('handling_customer_objection', 'business_intelligence', 'Handling Customer Objection', 8),
        ('body_language_tone_of_voice', 'business_intelligence', 'Body Language & Tone of Voice', 9),
        ('professional_pharmacy_feedback', 'business_intelligence', 'Professional Pharmacy Feedback', 10),
        ('assertiveness_asking_for_business', 'business_intelligence', 'Assertiveness in Asking for Business', 11),
        ('customer_adaptation_relationship', 'business_intelligence', 'Customer Adaptation & Relationship', 12),
        ('time_territory_planning', 'business_planning', 'Time & Territory Planning', 13),
        ('using_promotional_material', 'business_planning', 'Using Promotional Material', 14),
        ('pre_call_planning', 'business_planning', 'Pre-Call Planning', 15),
        ('execution_follow_up', 'business_planning', 'Execution & Follow-Up', 16),
        ('appearance', 'personal_skills', 'Appearance', 17),
        ('dress_code', 'personal_skills', 'Dress Code', 18),
        ('attitude', 'personal_skills', 'Attitude', 19),
        ('discipline', 'personal_skills', 'Discipline', 20)
    ),
    normalized as (
      select
        e.*,
        p_scores -> e.score_item_key as raw_value
      from expected e
    )
    select
      p_report_id,
      parameter_category,
      score_item_key,
      score_item_label,
      case
        when jsonb_typeof(raw_value) = 'object' then (raw_value ->> 'score')::int
        else (raw_value #>> '{}')::int
      end,
      display_order,
      nullif(btrim(case when jsonb_typeof(raw_value) = 'object' then raw_value ->> 'areaToBeImproved' else null end), ''),
      nullif(btrim(case when jsonb_typeof(raw_value) = 'object' then raw_value ->> 'strengthPoint' else null end), '')
    from normalized;
  end if;

  select count(*), coalesce(sum(score), 0)
  into v_score_count, v_actual_score
  from public.coaching_score_items
  where report_id = p_report_id;

  if v_score_count <> 20 then
    raise exception 'Exactly 20 coaching scores are required before submission.';
  end if;

  v_final_percent := round((v_actual_score / 120) * 100, 2);
  v_zone := case
    when v_final_percent < 50 then 'critical_red'
    when v_final_percent <= 65 then 'red_zone'
    when v_final_percent <= 80 then 'yellow_zone'
    when v_final_percent <= 90 then 'green_zone'
    else 'excellence_zone'
  end;

  update public.coaching_reports
  set
    actual_score = v_actual_score,
    area_of_development = coalesce(p_area_of_development, area_of_development),
    final_score_percent = v_final_percent,
    general_remarks = coalesce(p_general_remarks, general_remarks),
    max_score = 120,
    performance_zone = v_zone,
    status = 'submitted',
    strength_points = coalesce(p_strength_points, strength_points),
    submitted_at = coalesce(submitted_at, now()),
    locked_at = null,
    updated_by = p_actor_hr_id
  where id = p_report_id
  returning *
  into v_updated;

  insert into public.coaching_report_audit_logs (
    report_id,
    actor_hr_id,
    action,
    old_values,
    new_values
  )
  values (
    p_report_id,
    p_actor_hr_id,
    'submitted',
    jsonb_build_object('status', v_report.status),
    jsonb_build_object(
      'status', 'submitted',
      'actualScore', v_actual_score,
      'finalScorePercent', v_final_percent,
      'performanceZone', v_zone
    )
  );

  return v_updated;
end;
$_$;


ALTER FUNCTION "public"."submit_coaching_report"("p_report_id" "uuid", "p_actor_hr_id" "text", "p_area_of_development" "text", "p_strength_points" "text", "p_general_remarks" "text", "p_scores" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "internal"."phoenix_date_offset_repair_audit" (
    "id" bigint NOT NULL,
    "repair_key" "text" NOT NULL,
    "table_name" "text" NOT NULL,
    "primary_key" "text" NOT NULL,
    "column_name" "text" NOT NULL,
    "old_value" "date" NOT NULL,
    "new_value" "date" NOT NULL,
    "evidence" "text" NOT NULL,
    "repaired_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "internal"."phoenix_date_offset_repair_audit" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "internal"."phoenix_date_offset_repair_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "internal"."phoenix_date_offset_repair_audit_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "internal"."phoenix_date_offset_repair_audit_id_seq" OWNED BY "internal"."phoenix_date_offset_repair_audit"."id";



CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_constraints_20260511180815" (
    "backed_up_at" timestamp with time zone,
    "table_name" "text",
    "conname" "name",
    "contype" "char",
    "constraint_definition" "text"
);


ALTER TABLE "private"."rls_gap_closure_backup_constraints_20260511180815" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_constraints_20260511180835" (
    "backed_up_at" timestamp with time zone,
    "table_name" "text",
    "conname" "name",
    "contype" "char",
    "constraint_definition" "text"
);


ALTER TABLE "private"."rls_gap_closure_backup_constraints_20260511180835" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_constraints_20260511181049" (
    "backed_up_at" timestamp with time zone,
    "table_name" "text",
    "conname" "name",
    "contype" "char",
    "constraint_definition" "text"
);


ALTER TABLE "private"."rls_gap_closure_backup_constraints_20260511181049" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_constraints_20260511181154" (
    "backed_up_at" timestamp with time zone,
    "table_name" "text",
    "conname" "name",
    "contype" "char",
    "constraint_definition" "text"
);


ALTER TABLE "private"."rls_gap_closure_backup_constraints_20260511181154" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_grants_20260511180815" (
    "backed_up_at" timestamp with time zone,
    "grantor" "information_schema"."sql_identifier",
    "grantee" "information_schema"."sql_identifier",
    "table_catalog" "information_schema"."sql_identifier",
    "table_schema" "information_schema"."sql_identifier",
    "table_name" "information_schema"."sql_identifier",
    "privilege_type" "information_schema"."character_data",
    "is_grantable" "information_schema"."yes_or_no",
    "with_hierarchy" "information_schema"."yes_or_no"
);


ALTER TABLE "private"."rls_gap_closure_backup_grants_20260511180815" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_grants_20260511180835" (
    "backed_up_at" timestamp with time zone,
    "grantor" "information_schema"."sql_identifier",
    "grantee" "information_schema"."sql_identifier",
    "table_catalog" "information_schema"."sql_identifier",
    "table_schema" "information_schema"."sql_identifier",
    "table_name" "information_schema"."sql_identifier",
    "privilege_type" "information_schema"."character_data",
    "is_grantable" "information_schema"."yes_or_no",
    "with_hierarchy" "information_schema"."yes_or_no"
);


ALTER TABLE "private"."rls_gap_closure_backup_grants_20260511180835" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_grants_20260511181049" (
    "backed_up_at" timestamp with time zone,
    "grantor" "information_schema"."sql_identifier",
    "grantee" "information_schema"."sql_identifier",
    "table_catalog" "information_schema"."sql_identifier",
    "table_schema" "information_schema"."sql_identifier",
    "table_name" "information_schema"."sql_identifier",
    "privilege_type" "information_schema"."character_data",
    "is_grantable" "information_schema"."yes_or_no",
    "with_hierarchy" "information_schema"."yes_or_no"
);


ALTER TABLE "private"."rls_gap_closure_backup_grants_20260511181049" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_grants_20260511181154" (
    "backed_up_at" timestamp with time zone,
    "grantor" "information_schema"."sql_identifier",
    "grantee" "information_schema"."sql_identifier",
    "table_catalog" "information_schema"."sql_identifier",
    "table_schema" "information_schema"."sql_identifier",
    "table_name" "information_schema"."sql_identifier",
    "privilege_type" "information_schema"."character_data",
    "is_grantable" "information_schema"."yes_or_no",
    "with_hierarchy" "information_schema"."yes_or_no"
);


ALTER TABLE "private"."rls_gap_closure_backup_grants_20260511181154" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_policies_20260511180815" (
    "backed_up_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "private"."rls_gap_closure_backup_policies_20260511180815" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_policies_20260511180835" (
    "backed_up_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "private"."rls_gap_closure_backup_policies_20260511180835" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_policies_20260511181049" (
    "backed_up_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "private"."rls_gap_closure_backup_policies_20260511181049" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."rls_gap_closure_backup_policies_20260511181154" (
    "backed_up_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "private"."rls_gap_closure_backup_policies_20260511181154" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."security_definer_function_exceptions" (
    "function_signature" "text" NOT NULL,
    "schema_name" "text" NOT NULL,
    "function_name" "text" NOT NULL,
    "identity_arguments" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "reviewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_by" "text" DEFAULT CURRENT_USER NOT NULL
);


ALTER TABLE "private"."security_definer_function_exceptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_scopes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    CONSTRAINT "access_scopes_name_check" CHECK (("name" = ANY (ARRAY['SELF'::"text", 'TEAM'::"text", 'HIERARCHY'::"text", 'LINE'::"text", 'COMPANY'::"text", 'NONE'::"text"])))
);

ALTER TABLE ONLY "public"."access_scopes" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."access_scopes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_auth_users" (
    "login_id" "text" NOT NULL,
    "password_hash" "text" NOT NULL,
    "role" "text" NOT NULL,
    "hr_id" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "email" "text",
    "line" "text" DEFAULT 'Other'::"text" NOT NULL,
    "manager_hr_id" "text",
    "sales_scope_override" "text",
    "auth_user_id" "uuid",
    "auth_email" "text",
    "session_version" integer DEFAULT 1 NOT NULL,
    "force_password_reset" boolean DEFAULT false NOT NULL,
    "failed_login_attempts" integer DEFAULT 0 NOT NULL,
    "last_failed_login_at" timestamp with time zone,
    "locked_until" timestamp with time zone,
    CONSTRAINT "app_auth_users_role_check" CHECK (("role" = ANY (ARRAY['Employee'::"text", 'Employee medical rep'::"text", 'Medical Rep'::"text", 'District Manager'::"text", 'Regional Manager'::"text", 'Regional Sales Manager'::"text", 'National Sales Manager'::"text", 'Product Manager'::"text", 'Group Product Manager'::"text", 'SFE Manager'::"text", 'Training Manager'::"text", 'Marketing Manager'::"text", 'Finance Manager'::"text", 'HR Specialist'::"text", 'Manager'::"text", 'CEO'::"text", 'Super Admin'::"text"])))
);

ALTER TABLE ONLY "public"."app_auth_users" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_auth_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."areas" (
    "id" bigint NOT NULL,
    "line_id" bigint NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."areas" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."areas" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."areas_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."areas_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."areas_id_seq" OWNED BY "public"."areas"."id";



CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_login_id" "text",
    "entity_type" "text" NOT NULL,
    "entity_id" "text",
    "summary" "text" NOT NULL,
    "old_values" "jsonb",
    "new_values" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."audit_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auth_login_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "login_id" "text" NOT NULL,
    "ip" "text",
    "success" boolean DEFAULT false NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."auth_login_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."brick_reference_imports" (
    "id" bigint NOT NULL,
    "file_name" "text" NOT NULL,
    "line" "text" NOT NULL,
    "row_count" integer DEFAULT 0 NOT NULL,
    "brick_count" integer DEFAULT 0 NOT NULL,
    "uploaded_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."brick_reference_imports" OWNER TO "postgres";


ALTER TABLE "public"."brick_reference_imports" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."brick_reference_imports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."brick_reference_rows" (
    "id" bigint NOT NULL,
    "import_id" bigint NOT NULL,
    "line" "text" NOT NULL,
    "area" "text" DEFAULT ''::"text" NOT NULL,
    "brick_name_raw" "text" NOT NULL,
    "brick_name_normalized" "text" NOT NULL,
    "source_details" "text" DEFAULT ''::"text" NOT NULL,
    "source_file_name" "text",
    "source_row" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dsm_hr_id" "text"
);


ALTER TABLE "public"."brick_reference_rows" OWNER TO "postgres";


ALTER TABLE "public"."brick_reference_rows" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."brick_reference_rows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."coaching_quarterly_summary" WITH ("security_invoker"='true') AS
 WITH "ranked" AS (
         SELECT "r"."medical_rep_hr_id",
            "r"."coaching_year",
            "r"."coaching_quarter",
            "r"."final_score_percent",
            "r"."performance_zone",
            "r"."coaching_date",
            "r"."created_at",
            "first_value"("r"."final_score_percent") OVER (PARTITION BY "r"."medical_rep_hr_id", "r"."coaching_year", "r"."coaching_quarter" ORDER BY "r"."coaching_date", "r"."created_at") AS "first_score",
            "first_value"("r"."final_score_percent") OVER (PARTITION BY "r"."medical_rep_hr_id", "r"."coaching_year", "r"."coaching_quarter" ORDER BY "r"."coaching_date" DESC, "r"."created_at" DESC) AS "latest_score",
            "first_value"("r"."performance_zone") OVER (PARTITION BY "r"."medical_rep_hr_id", "r"."coaching_year", "r"."coaching_quarter" ORDER BY "r"."coaching_date" DESC, "r"."created_at" DESC) AS "latest_zone"
           FROM "public"."coaching_reports" "r"
          WHERE ("r"."status" = ANY (ARRAY['submitted'::"text", 'reviewed_by_employee'::"text", 'locked'::"text"]))
        )
 SELECT "medical_rep_hr_id",
    "coaching_year" AS "year",
    "coaching_quarter" AS "quarter",
    ("count"(*))::integer AS "coaching_count",
    "round"("avg"("final_score_percent"), 2) AS "average_score",
    "max"("final_score_percent") AS "best_score",
    "min"("final_score_percent") AS "lowest_score",
    "max"("latest_score") AS "latest_score",
    "max"("first_score") AS "first_score",
    "round"(("max"("latest_score") - "max"("first_score")), 2) AS "improvement_score",
    "max"("latest_zone") AS "latest_zone"
   FROM "ranked"
  GROUP BY "medical_rep_hr_id", "coaching_year", "coaching_quarter";


ALTER VIEW "public"."coaching_quarterly_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coaching_report_acknowledgments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid" NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "acknowledged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "acknowledgment_text" "text" NOT NULL,
    "ip_address" "text",
    "user_agent" "text"
);


ALTER TABLE "public"."coaching_report_acknowledgments" OWNER TO "postgres";


COMMENT ON TABLE "public"."coaching_report_acknowledgments" IS 'Employee acknowledgment history for submitted coaching reports.';



CREATE TABLE IF NOT EXISTS "public"."coaching_report_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid",
    "actor_hr_id" "text",
    "action" "text" NOT NULL,
    "old_values" "jsonb",
    "new_values" "jsonb",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."coaching_report_audit_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."coaching_report_audit_logs" IS 'Module-specific audit trail for coaching report lifecycle events.';



CREATE TABLE IF NOT EXISTS "public"."employees" (
    "hr_id" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "name_ar" "text",
    "crm_id" "text",
    "crm_username" "text",
    "work_email" "text",
    "mobile_number" "text",
    "job_title" "text",
    "hire_date" "date",
    "employment_status" "text",
    "education" "text",
    "manager_hr_id" "text",
    "department_id" bigint,
    "line_id" bigint,
    "area_id" bigint,
    "team_id" bigint,
    "position_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "region_name" "text",
    "contract_signed_date" "date",
    "contract_renewal_date" "date",
    "probation_end_date" "date",
    "contract_start_date" "date",
    "contract_day" integer,
    "contract_month_number" integer,
    "contract_month_clean" "text",
    "birth_date" "date",
    "onboarding_source" "text",
    "onboarding_status" "text" DEFAULT 'active'::"text",
    "resignation_date" "date",
    "last_working_date" "date",
    "exit_reason" "text",
    "exit_status" "text",
    "payroll_eligible" boolean DEFAULT true,
    "organogram_visible" boolean DEFAULT true,
    "national_id" "text",
    "gender" "text",
    "bank_account" "text",
    "social_insurance_number" "text",
    "medical_insurance_number" "text",
    "basic_salary" numeric,
    "base_salary" numeric,
    "gross_salary" numeric,
    "net_salary" numeric,
    "fuel_allowance" numeric,
    "extra_cost_of_living" numeric,
    "medical_insurance" numeric,
    "social_insurance" numeric,
    "taxes" numeric,
    "payment_mode" "text",
    "residence_address" "text",
    "residence_city" "text",
    "residence_area" "text",
    "contract_type" "text",
    "bank_name" "text",
    "has_bank_account" "text",
    "medical_insurance_status" "text",
    "social_insurance_status" "text",
    "pending_manager_replacement_for_hr_id" "text",
    CONSTRAINT "employees_has_bank_account_allowed_chk" CHECK ((("has_bank_account" IS NULL) OR ("has_bank_account" = ANY (ARRAY['yes'::"text", 'no'::"text"])))),
    CONSTRAINT "employees_medical_insurance_status_allowed_chk" CHECK ((("medical_insurance_status" IS NULL) OR ("medical_insurance_status" = ANY (ARRAY['yes'::"text", 'no'::"text", 'pending'::"text"])))),
    CONSTRAINT "employees_social_insurance_status_allowed_chk" CHECK ((("social_insurance_status" IS NULL) OR ("social_insurance_status" = ANY (ARRAY['yes'::"text", 'no'::"text", 'pending'::"text"]))))
);


ALTER TABLE "public"."employees" OWNER TO "postgres";


COMMENT ON COLUMN "public"."employees"."national_id" IS 'Government national identity number captured as fixed employee master data.';



COMMENT ON COLUMN "public"."employees"."gender" IS 'Employee gender value for HR master data reporting.';



COMMENT ON COLUMN "public"."employees"."bank_account" IS 'Employee bank account reference used by HR/payroll operations.';



COMMENT ON COLUMN "public"."employees"."social_insurance_number" IS 'Employee social insurance identifier.';



COMMENT ON COLUMN "public"."employees"."medical_insurance_number" IS 'Employee medical insurance identifier.';



COMMENT ON COLUMN "public"."employees"."basic_salary" IS 'Fixed employee master basic salary reference. Initialized from base_salary only when no more explicit source exists.';



COMMENT ON COLUMN "public"."employees"."base_salary" IS 'Fixed employee master base salary reference. Backfilled from employee_compensation/salary_records where available.';



COMMENT ON COLUMN "public"."employees"."gross_salary" IS 'Fixed employee master gross salary reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."net_salary" IS 'Fixed employee master net salary reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."fuel_allowance" IS 'Fixed employee master fuel allowance reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."extra_cost_of_living" IS 'Fixed employee master extra cost of living reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."medical_insurance" IS 'Fixed employee master medical insurance amount/reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."social_insurance" IS 'Fixed employee master social insurance amount/reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."taxes" IS 'Fixed employee master tax amount/reference copied from employee_compensation first, salary_records fallback second.';



COMMENT ON COLUMN "public"."employees"."payment_mode" IS 'Fixed employee master salary payment mode copied from employee_compensation when available.';



COMMENT ON COLUMN "public"."employees"."residence_address" IS 'Employee residence address copied from employee_locations when available.';



COMMENT ON COLUMN "public"."employees"."residence_city" IS 'Employee residence city copied from employee_locations when available.';



COMMENT ON COLUMN "public"."employees"."residence_area" IS 'Employee residence area copied from employee_locations when available.';



COMMENT ON COLUMN "public"."employees"."contract_type" IS 'Employee fixed contract type copied from employee_contracts when available.';



COMMENT ON COLUMN "public"."employees"."bank_name" IS 'Employee bank name used as fixed payroll reference master data.';



COMMENT ON COLUMN "public"."employees"."has_bank_account" IS 'Employee Master Data flag indicating whether HR has a payroll bank account on file. Allowed values: yes, no.';



COMMENT ON COLUMN "public"."employees"."medical_insurance_status" IS 'Employee Master Data enrollment status for medical insurance. Allowed values: yes, no, pending.';



COMMENT ON COLUMN "public"."employees"."social_insurance_status" IS 'Employee Master Data enrollment status for social insurance. Allowed values: yes, no, pending.';



COMMENT ON COLUMN "public"."employees"."pending_manager_replacement_for_hr_id" IS 'Terminal manager HR_ID whose replacement should inherit this employee report when hired.';



CREATE TABLE IF NOT EXISTS "public"."lines" (
    "id" bigint NOT NULL,
    "department_id" bigint NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."lines" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."teams" (
    "id" bigint NOT NULL,
    "area_id" bigint NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."teams" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."teams" OWNER TO "postgres";


COMMENT ON COLUMN "public"."teams"."area_id" IS 'Optional Area scope for disambiguating Team names in Employee Master imports.';



COMMENT ON COLUMN "public"."teams"."code" IS 'Stable normalized Team lookup code used by Employee Master import mapping.';



COMMENT ON COLUMN "public"."teams"."is_active" IS 'Controls whether the Team is available as an active global lookup option.';



CREATE OR REPLACE VIEW "public"."coaching_reports_summary" WITH ("security_invoker"='true') AS
 SELECT "r"."id" AS "report_id",
    "r"."report_number",
    "rep"."full_name" AS "medical_rep_name",
    "r"."medical_rep_hr_id",
    "coach"."full_name" AS "coach_name",
    "r"."coach_hr_id",
    "l"."name" AS "line_name",
    "a"."name" AS "area_name",
    "t"."name" AS "team_name",
    "r"."coaching_date",
    "r"."coaching_month",
    "r"."coaching_quarter",
    "r"."coaching_year",
    "r"."actual_score",
    "r"."max_score",
    "r"."final_score_percent",
    "r"."performance_zone",
    "r"."status",
    "r"."employee_acknowledged" AS "acknowledged",
    "r"."acknowledged_at",
    "r"."submitted_at",
    "r"."created_at",
    "r"."updated_at",
    "r"."line_id",
    "r"."area_id",
    "r"."team_id"
   FROM ((((("public"."coaching_reports" "r"
     JOIN "public"."employees" "rep" ON (("rep"."hr_id" = "r"."medical_rep_hr_id")))
     JOIN "public"."employees" "coach" ON (("coach"."hr_id" = "r"."coach_hr_id")))
     LEFT JOIN "public"."lines" "l" ON (("l"."id" = "r"."line_id")))
     LEFT JOIN "public"."areas" "a" ON (("a"."id" = "r"."area_id")))
     LEFT JOIN "public"."teams" "t" ON (("t"."id" = "r"."team_id")));


ALTER VIEW "public"."coaching_reports_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coaching_score_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid" NOT NULL,
    "parameter_category" "text" NOT NULL,
    "score_item_key" "text" NOT NULL,
    "score_item_label" "text" NOT NULL,
    "score" integer NOT NULL,
    "display_order" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "area_to_be_improved" "text",
    "strength_point" "text",
    CONSTRAINT "coaching_score_items_score_check" CHECK ((("score" >= 1) AND ("score" <= 6)))
);


ALTER TABLE "public"."coaching_score_items" OWNER TO "postgres";


COMMENT ON TABLE "public"."coaching_score_items" IS 'Dynamic score rows for each coaching report. Expected total is 20 items scored from 1 to 6.';



COMMENT ON COLUMN "public"."coaching_score_items"."area_to_be_improved" IS 'Optional coach note for what should be improved on this specific scoring point.';



COMMENT ON COLUMN "public"."coaching_score_items"."strength_point" IS 'Optional coach note for what was strong on this specific scoring point.';



CREATE TABLE IF NOT EXISTS "public"."contract_renewal_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid",
    "employee_hr_id" "text" NOT NULL,
    "action" "text" NOT NULL,
    "old_renewal_date" "date",
    "new_renewal_date" "date",
    "actor" "text",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contract_renewal_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contract_renewal_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "current_contract_id" "text",
    "employee_name" "text" DEFAULT ''::"text" NOT NULL,
    "job_title" "text",
    "line_name" "text",
    "area_name" "text",
    "current_renewal_date" "date",
    "requested_renewal_date" "date" NOT NULL,
    "proposed_start_date" "date",
    "proposed_end_date" "date",
    "new_contract_document_url" "text",
    "new_contract_document_name" "text",
    "signed_contract_url" "text",
    "signed_contract_name" "text",
    "signed_at" timestamp with time zone,
    "workflow_notes" "text",
    "status" "text" DEFAULT 'requested'::"text" NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "manager_reviewed_at" timestamp with time zone,
    "manager_reviewed_by" "text",
    "hr_reviewed_at" timestamp with time zone,
    "hr_reviewed_by" "text",
    "decision_at" timestamp with time zone,
    "decision_by" "text",
    "decision_reason" "text",
    "completed_contract_id" "text",
    CONSTRAINT "contract_renewal_requests_status_check" CHECK (("status" = ANY (ARRAY['requested'::"text", 'manager_review'::"text", 'hr_review'::"text", 'renewed'::"text", 'not_renewed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."contract_renewal_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" bigint NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."departments" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."departments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."departments"."is_active" IS 'Controls whether the department is available as an active global lookup option.';



CREATE SEQUENCE IF NOT EXISTS "public"."departments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."departments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."departments_id_seq" OWNED BY "public"."departments"."id";



CREATE TABLE IF NOT EXISTS "public"."email_notification_policies" (
    "notification_type" "text" NOT NULL,
    "label" "text" NOT NULL,
    "description" "text",
    "enabled" boolean DEFAULT true NOT NULL,
    "recipient_mode" "text" DEFAULT 'hr_notifications'::"text" NOT NULL,
    "include_hr_inbox" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    "recipient_modes" "text"[] DEFAULT ARRAY['hr_notifications'::"text"] NOT NULL,
    "target_titles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "target_lines" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "template_subject" "text",
    "template_title" "text",
    "template_greeting" "text",
    "template_body_text" "text",
    "template_closing_text" "text",
    "template_preview_text" "text",
    CONSTRAINT "email_notification_policies_recipient_mode_check" CHECK (("recipient_mode" = ANY (ARRAY['hr_notifications'::"text", 'employee'::"text", 'direct_manager'::"text", 'manager_manager'::"text", 'manager_chain'::"text", 'employee_and_direct_manager'::"text", 'candidate'::"text", 'same_line_selected_titles'::"text", 'selected_titles_all_lines'::"text", 'selected_titles_selected_lines'::"text"]))),
    CONSTRAINT "email_notification_policies_recipient_modes_check" CHECK (("recipient_modes" <@ ARRAY['hr_notifications'::"text", 'employee'::"text", 'direct_manager'::"text", 'manager_manager'::"text", 'manager_chain'::"text", 'employee_and_direct_manager'::"text", 'candidate'::"text", 'same_line_selected_titles'::"text", 'selected_titles_all_lines'::"text", 'selected_titles_selected_lines'::"text"])),
    CONSTRAINT "email_notification_policies_type_check" CHECK (("notification_type" = ANY (ARRAY['probation'::"text", 'contract_renewal'::"text", 'birthday'::"text", 'offer'::"text", 'resignation'::"text", 'leave'::"text", 'password_reset'::"text", 'user_created'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."email_notification_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_compensation" (
    "employee_hr_id" "text" NOT NULL,
    "net_salary" numeric(14,2),
    "social_insurance" numeric(14,2),
    "taxes" numeric(14,2),
    "medical_insurance" numeric(14,2),
    "comprehensive_wage" numeric(14,2),
    "subscription_wage" numeric(14,2),
    "fuel_allowance" numeric(14,2),
    "extra_cost_of_living" numeric(14,2),
    "gross_salary" numeric(14,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "payment_mode" "text" DEFAULT 'one_part'::"text" NOT NULL,
    CONSTRAINT "employee_compensation_payment_mode_check" CHECK (("payment_mode" = ANY (ARRAY['one_part'::"text", 'two_parts'::"text"])))
);


ALTER TABLE "public"."employee_compensation" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_contracts" (
    "id" bigint NOT NULL,
    "hr_id" "text" NOT NULL,
    "contract_type" "text" DEFAULT 'fixed-term'::"text" NOT NULL,
    "contract_renewal_date" "date" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "employee_hr_id" "text",
    "contract_signed_date" "date",
    "contract_start_date" "date",
    "contract_end_date" "date",
    "document_url" "text",
    "document_name" "text",
    "signed_document_url" "text",
    "signed_document_name" "text",
    "created_by" "text",
    CONSTRAINT "employee_contracts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'renewed'::"text", 'terminated'::"text"])))
);


ALTER TABLE "public"."employee_contracts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."employee_contracts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."employee_contracts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."employee_contracts_id_seq" OWNED BY "public"."employee_contracts"."id";



CREATE TABLE IF NOT EXISTS "public"."employee_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "document_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "file_key" "text" NOT NULL,
    "file_name" "text",
    "mime_type" "text",
    "size_bytes" integer,
    "uploaded_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."employee_documents" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_history" (
    "id" bigint NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "effective_from" "date" NOT NULL,
    "effective_to" "date",
    "department_id" bigint,
    "line_id" bigint,
    "area_id" bigint,
    "team_id" bigint,
    "position_id" bigint,
    "note" "text",
    "changed_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "change_type" "text" NOT NULL
);

ALTER TABLE ONLY "public"."employee_history" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_history" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."employee_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."employee_history_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."employee_history_id_seq" OWNED BY "public"."employee_history"."id";



CREATE OR REPLACE VIEW "public"."employee_linkage_health" WITH ("security_invoker"='true') AS
 SELECT "e"."hr_id",
    "e"."full_name",
    "e"."job_title",
    "e"."employment_status",
    "e"."manager_hr_id",
    "m"."full_name" AS "manager_name",
    "l"."name" AS "line_name",
    "a"."name" AS "area_name",
        CASE
            WHEN (("e"."manager_hr_id" IS NULL) OR (TRIM(BOTH FROM "e"."manager_hr_id") = ''::"text")) THEN 'missing_manager'::"text"
            WHEN ("m"."hr_id" IS NULL) THEN 'manager_not_found'::"text"
            WHEN (("e"."job_title" IS NULL) OR (TRIM(BOTH FROM "e"."job_title") = ''::"text")) THEN 'missing_job_title'::"text"
            WHEN ("e"."line_id" IS NULL) THEN 'missing_line'::"text"
            WHEN ("e"."area_id" IS NULL) THEN 'missing_area'::"text"
            ELSE 'ok'::"text"
        END AS "health_status"
   FROM ((("public"."employees" "e"
     LEFT JOIN "public"."employees" "m" ON (("lower"("m"."hr_id") = "lower"("e"."manager_hr_id"))))
     LEFT JOIN "public"."lines" "l" ON (("l"."id" = "e"."line_id")))
     LEFT JOIN "public"."areas" "a" ON (("a"."id" = "e"."area_id")));


ALTER VIEW "public"."employee_linkage_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."employee_linkage_health_summary" WITH ("security_invoker"='true') AS
 SELECT ("count"(*))::integer AS "total_employees",
    ("count"(*) FILTER (WHERE ("health_status" = 'ok'::"text")))::integer AS "healthy_employees",
    ("count"(*) FILTER (WHERE ("health_status" = 'missing_manager'::"text")))::integer AS "missing_manager",
    ("count"(*) FILTER (WHERE ("health_status" = 'manager_not_found'::"text")))::integer AS "manager_not_found",
    ("count"(*) FILTER (WHERE ("health_status" = 'missing_job_title'::"text")))::integer AS "missing_job_title",
    ("count"(*) FILTER (WHERE ("health_status" = 'missing_line'::"text")))::integer AS "missing_line",
    ("count"(*) FILTER (WHERE ("health_status" = 'missing_area'::"text")))::integer AS "missing_area",
        CASE
            WHEN ("count"(*) = 0) THEN (1)::numeric
            ELSE "round"((("count"(*) FILTER (WHERE ("health_status" = 'ok'::"text")))::numeric / ("count"(*))::numeric), 4)
        END AS "health_rate"
   FROM "public"."employee_linkage_health";


ALTER VIEW "public"."employee_linkage_health_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_locations" (
    "id" bigint NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "residence_address" "text",
    "residence_city" "text",
    "residence_area" "text",
    "residence_latitude" double precision,
    "residence_longitude" double precision,
    "geocode_status" "text",
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."employee_locations" OWNER TO "postgres";


ALTER TABLE "public"."employee_locations" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."employee_locations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."employee_probation" (
    "id" bigint NOT NULL,
    "hr_id" "text" NOT NULL,
    "probation_end_date" "date" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "employee_hr_id" "text",
    CONSTRAINT "employee_probation_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'passed'::"text", 'extended'::"text", 'terminated'::"text"])))
);


ALTER TABLE "public"."employee_probation" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."employee_probation_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."employee_probation_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."employee_probation_id_seq" OWNED BY "public"."employee_probation"."id";



CREATE TABLE IF NOT EXISTS "public"."employee_resignations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "resignation_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "last_working_date" "date" NOT NULL,
    "reason" "text",
    "exit_status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "notes" "text",
    "create_vacancy" boolean DEFAULT true NOT NULL,
    "vacancy_id" bigint,
    "submitted_by_hr_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "employee_name" "text" NOT NULL,
    "job_title" "text",
    "line_name" "text",
    "submitted_date" "date" NOT NULL,
    "effective_date" "date" NOT NULL,
    "workflow_notes" "text",
    "status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "created_by" "text",
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "text",
    "approved_at" timestamp with time zone,
    "approved_by" "text",
    "rejected_at" timestamp with time zone,
    "rejected_by" "text",
    "rejected_reason" "text",
    "completed_at" timestamp with time zone,
    "completed_by" "text",
    "cancelled_at" timestamp with time zone,
    "cancelled_by" "text",
    CONSTRAINT "employee_resignations_effective_after_submitted" CHECK (("effective_date" >= "submitted_date")),
    CONSTRAINT "employee_resignations_exit_status_check" CHECK (("exit_status" = ANY (ARRAY['submitted'::"text", 'approved'::"text", 'cancelled'::"text", 'completed'::"text"]))),
    CONSTRAINT "employee_resignations_status_check" CHECK (("status" = ANY (ARRAY['submitted'::"text", 'under_review'::"text", 'approved'::"text", 'rejected'::"text", 'completed'::"text", 'cancelled'::"text"])))
);

ALTER TABLE ONLY "public"."employee_resignations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_resignations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."geo_bricks" (
    "id" bigint NOT NULL,
    "line" "text",
    "area" "text",
    "brick_name" "text" NOT NULL,
    "brick_code" "text" NOT NULL,
    "employee_hr_id" "text",
    "employee_name" "text",
    "latitude" double precision,
    "longitude" double precision,
    "coverage_status" "text" DEFAULT 'unassigned'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."geo_bricks" OWNER TO "postgres";


ALTER TABLE "public"."geo_bricks" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."geo_bricks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."geo_locations" (
    "id" bigint NOT NULL,
    "source_type" "text" NOT NULL,
    "source_key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "address_text" "text",
    "city" "text",
    "area" "text",
    "line" "text",
    "latitude" double precision,
    "longitude" double precision,
    "geocode_status" "text",
    "geocode_provider" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."geo_locations" OWNER TO "postgres";


ALTER TABLE "public"."geo_locations" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."geo_locations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."geo_trip_routes" (
    "id" bigint NOT NULL,
    "employee_hr_id" "text",
    "employee_name" "text",
    "trip_date" timestamp with time zone,
    "from_text" "text" NOT NULL,
    "to_text" "text" NOT NULL,
    "from_lat" double precision,
    "from_lng" double precision,
    "to_lat" double precision,
    "to_lng" double precision,
    "google_distance_meters" double precision,
    "google_duration_seconds" double precision,
    "claimed_amount" double precision DEFAULT 0 NOT NULL,
    "expected_amount" double precision DEFAULT 0 NOT NULL,
    "variance_amount" double precision DEFAULT 0 NOT NULL,
    "variance_percent" double precision DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'normal'::"text" NOT NULL,
    "source_file_month" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."geo_trip_routes" OWNER TO "postgres";


ALTER TABLE "public"."geo_trip_routes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."geo_trip_routes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."job_offer_audit_logs" (
    "id" bigint NOT NULL,
    "offer_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "actor_type" "text" DEFAULT 'system'::"text" NOT NULL,
    "actor_reference" "text",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."job_offer_audit_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_offer_audit_logs" OWNER TO "postgres";


ALTER TABLE "public"."job_offer_audit_logs" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."job_offer_audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."job_offers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "offer_code" "text" NOT NULL,
    "candidate_name" "text" NOT NULL,
    "candidate_email" "text" NOT NULL,
    "candidate_phone" "text",
    "job_title" "text" NOT NULL,
    "department_id" bigint,
    "line_id" bigint,
    "manager_hr_id" "text",
    "salary_amount" numeric,
    "start_date" "date",
    "expires_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'sent'::"text" NOT NULL,
    "secure_token_hash" "text" NOT NULL,
    "token_last_four" "text" NOT NULL,
    "accepted_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "expired_at" timestamp with time zone,
    "employee_hr_id" "text",
    "onboarding_status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "created_by_hr_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "template_key" "text",
    "area_scope" "text",
    "area_id" bigint,
    "position_id" bigint,
    CONSTRAINT "job_offers_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'accepted'::"text", 'rejected'::"text", 'expired'::"text"])))
);

ALTER TABLE ONLY "public"."job_offers" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_offers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_accrual_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "correlation_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period" "text" NOT NULL,
    "year" integer NOT NULL,
    "month" integer NOT NULL,
    "status" "text" DEFAULT 'completed'::"text" NOT NULL,
    "dry_run" boolean DEFAULT false NOT NULL,
    "actor_hr_id" "text",
    "processed_count" integer DEFAULT 0 NOT NULL,
    "skipped_count" integer DEFAULT 0 NOT NULL,
    "total_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_accrual_runs_month_check" CHECK ((("month" >= 1) AND ("month" <= 12))),
    CONSTRAINT "leave_accrual_runs_status_check" CHECK (("status" = ANY (ARRAY['completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."leave_accrual_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "approver_hr_id" "text" NOT NULL,
    "approver_role" "text" NOT NULL,
    "approval_step" "text" NOT NULL,
    "status" "text" NOT NULL,
    "comment" "text",
    "action_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_approvals_status_check" CHECK (("status" = ANY (ARRAY['approved'::"text", 'rejected'::"text", 'cancelled'::"text", 'adjusted'::"text"]))),
    CONSTRAINT "leave_approvals_step_check" CHECK (("approval_step" = ANY (ARRAY['manager'::"text", 'hr'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."leave_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_attachment_objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid",
    "employee_hr_id" "text" NOT NULL,
    "storage_mode" "text" DEFAULT 'local'::"text" NOT NULL,
    "bucket" "text",
    "object_path" "text",
    "public_url" "text",
    "original_name" "text",
    "content_type" "text",
    "size_bytes" bigint,
    "checksum" "text",
    "uploaded_by_hr_id" "text",
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_attachment_objects_mode_check" CHECK (("storage_mode" = ANY (ARRAY['local'::"text", 'supabase'::"text"])))
);


ALTER TABLE "public"."leave_attachment_objects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "correlation_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "request_id" "uuid",
    "employee_hr_id" "text",
    "actor_hr_id" "text",
    "actor_role" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."leave_audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_notification_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "stage" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "recipients" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "provider_response" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_text" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_notification_attempts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."leave_notification_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "country" "text" DEFAULT 'EG'::"text" NOT NULL,
    "annual_days_first_year" numeric(8,2) DEFAULT 15 NOT NULL,
    "annual_days_after_first_year" numeric(8,2) DEFAULT 21 NOT NULL,
    "accrual_method" "text" DEFAULT 'prorated'::"text" NOT NULL,
    "accrual_frequency" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "allow_negative_balance" boolean DEFAULT false NOT NULL,
    "carry_forward_enabled" boolean DEFAULT false NOT NULL,
    "carry_forward_limit" numeric(8,2) DEFAULT 0 NOT NULL,
    "carry_forward_expiry_months" integer DEFAULT 0 NOT NULL,
    "weekend_days" integer[] DEFAULT ARRAY[5, 6] NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_policies_accrual_frequency_check" CHECK (("accrual_frequency" = 'monthly'::"text")),
    CONSTRAINT "leave_policies_accrual_method_check" CHECK (("accrual_method" = 'monthly'::"text")),
    CONSTRAINT "leave_policies_weekend_days_check" CHECK (("weekend_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]))
);


ALTER TABLE "public"."leave_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_request_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_hr_id" "text",
    "actor_role" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "reason" "text",
    "override_reason" "text",
    "payload_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."leave_request_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "leave_type_id" "uuid" NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "request_id" "uuid",
    "transaction_type" "text" NOT NULL,
    "amount" numeric(8,2) NOT NULL,
    "balance_before" numeric(8,2) DEFAULT 0 NOT NULL,
    "balance_after" numeric(8,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_transactions_type_check" CHECK (("transaction_type" = ANY (ARRAY['opening_balance'::"text", 'accrual'::"text", 'carry_forward'::"text", 'adjustment'::"text", 'pending'::"text", 'pending_reversal'::"text", 'consumed'::"text", 'consumed_reversal'::"text"])))
);


ALTER TABLE "public"."leave_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "is_paid" boolean DEFAULT true NOT NULL,
    "affects_payroll" boolean DEFAULT false NOT NULL,
    "requires_attachment" boolean DEFAULT false NOT NULL,
    "requires_manager_approval" boolean DEFAULT true NOT NULL,
    "requires_hr_approval" boolean DEFAULT true NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "employee_selectable" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."leave_types" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lines_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lines_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lines_id_seq" OWNED BY "public"."lines"."id";



CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_delivery_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "notification_type" "text" NOT NULL,
    "employee_name" "text",
    "employee_email" "text",
    "recipients" "text"[] NOT NULL,
    "subject" "text" NOT NULL,
    "provider_message_id" "text",
    "status" "text" DEFAULT 'sent'::"text" NOT NULL,
    "opened_at" timestamp with time zone,
    "clicked_at" timestamp with time zone,
    "ignored" boolean DEFAULT false,
    "sent_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE ONLY "public"."notification_delivery_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_delivery_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_key" "text" NOT NULL,
    "category" "text" NOT NULL,
    "employee_hr_id" "text",
    "scheduled_for" "date" NOT NULL,
    "recipients" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "subject" "text" NOT NULL,
    "status" "text" NOT NULL,
    "provider_message_id" "text",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."notification_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_outbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dedupe_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 5 NOT NULL,
    "next_attempt_at" timestamp with time zone DEFAULT "now"(),
    "locked_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "provider_message_id" "text",
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notification_outbox_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "notification_outbox_max_attempts_check" CHECK (("max_attempts" >= 1)),
    CONSTRAINT "notification_outbox_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'sent'::"text", 'failed'::"text"])))
);

ALTER TABLE ONLY "public"."notification_outbox" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_outbox" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outstation_expense_requests" (
    "id" bigint NOT NULL,
    "employee_hr_id" "text" NOT NULL,
    "employee_name" "text" NOT NULL,
    "employee_role" "text" NOT NULL,
    "line" "text",
    "area" "text",
    "transportation_type" "text" NOT NULL,
    "trip_start_date" timestamp with time zone NOT NULL,
    "trip_end_date" timestamp with time zone NOT NULL,
    "residence_address" "text",
    "residence_city" "text",
    "residence_area" "text",
    "residence_latitude" double precision,
    "residence_longitude" double precision,
    "captured_latitude" double precision NOT NULL,
    "captured_longitude" double precision NOT NULL,
    "captured_accuracy_meters" double precision NOT NULL,
    "captured_at" timestamp with time zone NOT NULL,
    "captured_location_source" "text" DEFAULT 'browser_gps'::"text" NOT NULL,
    "submitted_at" timestamp with time zone,
    "offline_captured" boolean DEFAULT false NOT NULL,
    "distance_from_residence_km" double precision,
    "distance_km" double precision,
    "duration_minutes" double precision,
    "route_polyline" "text",
    "minimum_required_distance_km" double precision DEFAULT 60 NOT NULL,
    "same_day_trip" boolean DEFAULT false NOT NULL,
    "overnight_days" integer DEFAULT 0 NOT NULL,
    "allowance_breakdown_json" "jsonb",
    "fuel_amount" double precision DEFAULT 0 NOT NULL,
    "allowance_amount" double precision DEFAULT 0 NOT NULL,
    "ticket_amount" double precision DEFAULT 0 NOT NULL,
    "expected_total_amount" double precision DEFAULT 0 NOT NULL,
    "claimed_total_amount" double precision DEFAULT 0 NOT NULL,
    "variance_amount" double precision DEFAULT 0 NOT NULL,
    "variance_percent" double precision DEFAULT 0 NOT NULL,
    "eligibility_status" "text" NOT NULL,
    "eligibility_reason" "text" NOT NULL,
    "territory_validation_status" "text" DEFAULT 'not_available'::"text" NOT NULL,
    "territory_validation_reason" "text",
    "to_city" "text",
    "to_area" "text",
    "to_label" "text",
    "suspicious_location_score" double precision DEFAULT 0 NOT NULL,
    "fraud_flags_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "approval_recommendation" "text" DEFAULT 'manager_review'::"text" NOT NULL,
    "approval_reason" "text" DEFAULT ''::"text" NOT NULL,
    "calculation_status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "attachment_count" integer DEFAULT 0,
    "expense_type" "text" DEFAULT 'traveling'::"text",
    "kilometer_reading" double precision,
    "medical_trip_hr_id" "text",
    "medical_trip_name" "text",
    "notes" "text"
);


ALTER TABLE "public"."outstation_expense_requests" OWNER TO "postgres";


ALTER TABLE "public"."outstation_expense_requests" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."outstation_expense_requests_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."outstation_location_audit_logs" (
    "id" bigint NOT NULL,
    "expense_request_id" bigint,
    "employee_hr_id" "text" NOT NULL,
    "previous_latitude" double precision,
    "previous_longitude" double precision,
    "previous_captured_at" timestamp with time zone,
    "residence_latitude" double precision,
    "residence_longitude" double precision,
    "captured_latitude" double precision NOT NULL,
    "captured_longitude" double precision NOT NULL,
    "captured_accuracy_meters" double precision NOT NULL,
    "distance_km" double precision,
    "duration_minutes" double precision,
    "speed_check_result" "text",
    "accuracy_check_result" "text",
    "timestamp_check_result" "text",
    "territory_check_result" "text",
    "calculated_distance_km" double precision,
    "suspicious_location_score" double precision DEFAULT 0 NOT NULL,
    "fraud_flags_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "validation_result" "text" NOT NULL,
    "validation_reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."outstation_location_audit_logs" OWNER TO "postgres";


ALTER TABLE "public"."outstation_location_audit_logs" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."outstation_location_audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."outstation_policy_rules" (
    "id" bigint NOT NULL,
    "role_name" "text" NOT NULL,
    "minimum_distance_km" double precision DEFAULT 60 NOT NULL,
    "fuel_rate_per_km" double precision DEFAULT 1.8 NOT NULL,
    "same_day_allowance" double precision DEFAULT 0 NOT NULL,
    "overnight_allowance" double precision DEFAULT 0 NOT NULL,
    "return_day_allowance" double precision DEFAULT 0 NOT NULL,
    "gps_accuracy_threshold_meters" double precision DEFAULT 100 NOT NULL,
    "max_offline_sync_delay_hours" double precision DEFAULT 8 NOT NULL,
    "requires_ticket_attachment" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."outstation_policy_rules" OWNER TO "postgres";


ALTER TABLE "public"."outstation_policy_rules" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."outstation_policy_rules_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."password_setup_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "login_id" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "sent_to_email" "text",
    "created_by_login_id" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "password_setup_tokens_purpose_check" CHECK (("purpose" = ANY (ARRAY['setup'::"text", 'reset'::"text"])))
);


ALTER TABLE "public"."password_setup_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_expense_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_name" "text" NOT NULL,
    "row_count" integer DEFAULT 0 NOT NULL,
    "total_expenses" numeric DEFAULT 0 NOT NULL,
    "approved_rows" integer DEFAULT 0 NOT NULL,
    "trip_date_from" "date",
    "trip_date_to" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payroll_expense_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid",
    "trip_id" "text" NOT NULL,
    "specialist" "text" NOT NULL,
    "hr_id" "text",
    "expense_date" "date",
    "to_date" "date",
    "request_type" "text",
    "transportation_type" "text",
    "trip_type" "text",
    "from_location" "text",
    "to_location" "text",
    "location" "text",
    "travel_cost" numeric DEFAULT 0 NOT NULL,
    "meeting_amount" numeric DEFAULT 0 NOT NULL,
    "allowance" numeric DEFAULT 0 NOT NULL,
    "total" numeric DEFAULT 0 NOT NULL,
    "km" numeric DEFAULT 0 NOT NULL,
    "description" "text",
    "status" "text",
    "hr_status" "text",
    "hr_notes" "text",
    "am_workload" numeric DEFAULT 0 NOT NULL,
    "pm_workload" numeric DEFAULT 0 NOT NULL,
    "open_status" "text",
    "hr_approved" boolean DEFAULT false NOT NULL,
    "hr_comment" "text" DEFAULT ''::"text" NOT NULL,
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "payout_month" integer NOT NULL,
    "payout_year" integer NOT NULL,
    "source_file_name" "text" DEFAULT ''::"text" NOT NULL,
    "source_row" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payroll_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_resignation_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hr_id" "text" NOT NULL,
    "employee_name" "text" NOT NULL,
    "name_ar" "text",
    "job_title" "text",
    "line_name" "text",
    "area_name" "text",
    "hire_date" "date",
    "last_payout_month" integer NOT NULL,
    "last_payout_year" integer NOT NULL,
    "source_file_name" "text",
    "source_row" integer,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payroll_resignation_candidates_month_check" CHECK ((("last_payout_month" >= 1) AND ("last_payout_month" <= 12))),
    CONSTRAINT "payroll_resignation_candidates_year_check" CHECK ((("last_payout_year" >= 2000) AND ("last_payout_year" <= 2100)))
);


ALTER TABLE "public"."payroll_resignation_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "id" bigint NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource" "text",
    "action" "text"
);

ALTER TABLE ONLY "public"."permissions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."permissions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."permissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."permissions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."permissions_id_seq" OWNED BY "public"."permissions"."id";



CREATE TABLE IF NOT EXISTS "public"."platform_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "description" "text",
    "updated_by_user_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."platform_settings" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."position_vacancies" (
    "id" bigint NOT NULL,
    "vacancy_code" "text" NOT NULL,
    "department_id" bigint,
    "line_id" bigint,
    "area_id" bigint,
    "team_id" bigint,
    "position_id" bigint,
    "job_title" "text",
    "source_row_number" integer,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "manager_hr_id" "text",
    "manager_name" "text",
    "region_name" "text",
    "replacement_for_hr_id" "text",
    "filled_by_hr_id" "text",
    "filled_at" timestamp with time zone,
    "manager_replacement_for_hr_id" "text"
);

ALTER TABLE ONLY "public"."position_vacancies" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."position_vacancies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."position_vacancies"."replacement_for_hr_id" IS 'HR_ID of the resigned/terminated employee whose position opened this vacancy.';



COMMENT ON COLUMN "public"."position_vacancies"."filled_by_hr_id" IS 'HR_ID of the active employee hired into this vacancy.';



COMMENT ON COLUMN "public"."position_vacancies"."filled_at" IS 'Timestamp when the vacancy was filled by an employee creation/replacement flow.';



COMMENT ON COLUMN "public"."position_vacancies"."manager_replacement_for_hr_id" IS 'Terminal manager HR_ID whose replacement should inherit this open subordinate vacancy when hired.';



CREATE SEQUENCE IF NOT EXISTS "public"."position_vacancies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."position_vacancies_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."position_vacancies_id_seq" OWNED BY "public"."position_vacancies"."id";



CREATE TABLE IF NOT EXISTS "public"."positions" (
    "id" bigint NOT NULL,
    "department_id" bigint,
    "line_id" bigint,
    "area_id" bigint,
    "team_id" bigint,
    "code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."positions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."positions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."positions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."positions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."positions_id_seq" OWNED BY "public"."positions"."id";



CREATE TABLE IF NOT EXISTS "public"."public_holidays" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "year" integer NOT NULL,
    "country" "text" DEFAULT 'EG'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "end_date" "date" DEFAULT CURRENT_DATE,
    "duration_days" numeric(6,2) DEFAULT 1,
    CONSTRAINT "public_holidays_duration_days_check" CHECK (("duration_days" > (0)::numeric)),
    CONSTRAINT "public_holidays_end_date_check" CHECK (("end_date" >= "date"))
);


ALTER TABLE "public"."public_holidays" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_permission_overrides" (
    "role_name" "text" NOT NULL,
    "resource" "text" NOT NULL,
    "action" "text" NOT NULL,
    "is_allowed" boolean DEFAULT true NOT NULL,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."role_permission_overrides" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_permission_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" bigint NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."roles" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."roles" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."roles_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."roles_id_seq" OWNED BY "public"."roles"."id";



CREATE TABLE IF NOT EXISTS "public"."salary_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_name" "text" NOT NULL,
    "month" integer NOT NULL,
    "year" integer NOT NULL,
    "status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "uploaded_by" "text",
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "locked_at" timestamp with time zone,
    "rejected_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "part1_paid_at" timestamp with time zone,
    "part1_paid_by" "text",
    "part2_ready_at" timestamp with time zone,
    "part2_ready_by" "text"
);


ALTER TABLE "public"."salary_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."salary_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "hr_id" "text",
    "flag_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "text"
);


ALTER TABLE "public"."salary_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."salary_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "hr_id" "text" NOT NULL,
    "full_name" "text",
    "line" "text",
    "area" "text",
    "job_title" "text",
    "gross_salary" numeric DEFAULT 0 NOT NULL,
    "expenses" numeric DEFAULT 0 NOT NULL,
    "incentive" numeric DEFAULT 0 NOT NULL,
    "overtime" numeric DEFAULT 0 NOT NULL,
    "bonus" numeric DEFAULT 0 NOT NULL,
    "extra_cost_of_living" numeric DEFAULT 0 NOT NULL,
    "fuel_allowance" numeric DEFAULT 0 NOT NULL,
    "other_additions" numeric DEFAULT 0 NOT NULL,
    "total_additions" numeric DEFAULT 0 NOT NULL,
    "social_insurance" numeric DEFAULT 0 NOT NULL,
    "employment_income_tax" numeric DEFAULT 0 NOT NULL,
    "crm" numeric DEFAULT 0 NOT NULL,
    "finger_print" numeric DEFAULT 0 NOT NULL,
    "unpaid_vacations" numeric DEFAULT 0 NOT NULL,
    "medical_insurance" numeric DEFAULT 0 NOT NULL,
    "loans" numeric DEFAULT 0 NOT NULL,
    "other_deductions" numeric DEFAULT 0 NOT NULL,
    "total_deductions" numeric DEFAULT 0 NOT NULL,
    "net_salary" numeric DEFAULT 0 NOT NULL,
    "first_part" numeric DEFAULT 0 NOT NULL,
    "second_part" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "hire_date" "date",
    "name_ar" "text",
    "comment" "text",
    "base_salary" numeric DEFAULT 0 NOT NULL,
    "governmental_deductions" numeric DEFAULT 0 NOT NULL,
    "month_salary" numeric DEFAULT 0 NOT NULL,
    "payment_mode" "text" DEFAULT 'two_parts'::"text" NOT NULL,
    CONSTRAINT "salary_records_payment_mode_check" CHECK (("payment_mode" = ANY (ARRAY['one_part'::"text", 'two_parts'::"text"])))
);


ALTER TABLE "public"."salary_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_audit_logs" (
    "id" bigint NOT NULL,
    "action" "text" NOT NULL,
    "batch_id" "uuid",
    "actor_username" "text",
    "actor_display_name" "text",
    "line" "text",
    "period" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."sales_audit_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_audit_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sales_audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sales_audit_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sales_audit_logs_id_seq" OWNED BY "public"."sales_audit_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."sales_import_batches" (
    "id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "line" "text" NOT NULL,
    "month" integer NOT NULL,
    "year" integer NOT NULL,
    "period" "text" NOT NULL,
    "status" "text" DEFAULT 'staged'::"text" NOT NULL,
    "schema_type" "text" DEFAULT 'raw_sales'::"text" NOT NULL,
    "total_records" integer DEFAULT 0 NOT NULL,
    "valid_records" integer DEFAULT 0 NOT NULL,
    "warning_records" integer DEFAULT 0 NOT NULL,
    "failed_records" integer DEFAULT 0 NOT NULL,
    "linked_records" integer DEFAULT 0 NOT NULL,
    "linkage_rate" numeric DEFAULT 0 NOT NULL,
    "uploaded_by" "text" DEFAULT 'system'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "duplicate_hash" "text" DEFAULT ''::"text" NOT NULL,
    "is_duplicate" boolean DEFAULT false NOT NULL,
    "replacement_for_batch_id" "uuid",
    "replaced_by_batch_id" "uuid",
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "rejected_by" "text",
    "rejected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_import_batches_month_check" CHECK ((("month" >= 1) AND ("month" <= 12))),
    CONSTRAINT "sales_import_batches_year_check" CHECK (("year" >= 2000))
);

ALTER TABLE ONLY "public"."sales_import_batches" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_records" (
    "id" bigint NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "employee_hr_id" "text",
    "employee_crm_id" "text",
    "employee_lookup_key" "text",
    "employee_name" "text",
    "manager_hr_id" "text",
    "line" "text" NOT NULL,
    "territory" "text" NOT NULL,
    "sales_type" "text" NOT NULL,
    "family" "text" NOT NULL,
    "product" "text" NOT NULL,
    "factory_price" numeric DEFAULT 0 NOT NULL,
    "month" integer NOT NULL,
    "year" integer NOT NULL,
    "sales_units" numeric DEFAULT 0 NOT NULL,
    "sales_value" numeric DEFAULT 0 NOT NULL,
    "target_units" numeric DEFAULT 0 NOT NULL,
    "target_value" numeric DEFAULT 0 NOT NULL,
    "validation_state" "text" DEFAULT 'valid'::"text" NOT NULL,
    "validation_notes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "link_status" "text" DEFAULT 'unlinked'::"text" NOT NULL,
    "link_confidence" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_records_month_check" CHECK ((("month" >= 1) AND ("month" <= 12))),
    CONSTRAINT "sales_records_year_check" CHECK (("year" >= 2000))
);

ALTER TABLE ONLY "public"."sales_records" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_role_overrides" (
    "hr_id" "text" NOT NULL,
    "role" "text" NOT NULL,
    "note" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_role_overrides_role_check" CHECK (("role" = ANY (ARRAY['MR'::"text", 'DSM'::"text", 'NSM'::"text"])))
);

ALTER TABLE ONLY "public"."sales_role_overrides" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_role_overrides" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sales_employee_linkage_health" WITH ("security_invoker"='true') AS
 SELECT "r"."batch_id",
    "b"."file_name",
    "b"."period",
    "b"."line",
    "r"."row_number",
    "r"."employee_hr_id",
    "er"."full_name" AS "employee_name",
    "er"."job_title" AS "employee_job_title",
    "ero"."role" AS "employee_role_override",
    "r"."manager_hr_id",
    "mr"."full_name" AS "manager_name",
    "mr"."job_title" AS "manager_job_title",
    "mro"."role" AS "manager_role_override",
    "r"."employee_lookup_key",
    "r"."territory",
    "r"."product",
    "r"."sales_value",
    "r"."target_value",
    "r"."validation_state",
    "r"."link_status",
        CASE
            WHEN (("lower"(COALESCE("r"."employee_hr_id", ''::"text")) = 'c-o1'::"text") OR ("lower"(COALESCE("r"."manager_hr_id", ''::"text")) = 'c-o1'::"text")) THEN 'excluded_c_o1'::"text"
            WHEN (("r"."employee_hr_id" IS NULL) AND ("r"."manager_hr_id" IS NOT NULL)) THEN 'area_without_mr'::"text"
            WHEN (("r"."employee_hr_id" IS NOT NULL) AND ("er"."hr_id" IS NULL)) THEN 'mr_not_found'::"text"
            WHEN (("r"."manager_hr_id" IS NOT NULL) AND ("mr"."hr_id" IS NULL)) THEN 'manager_not_found'::"text"
            WHEN (("r"."manager_hr_id" IS NULL) OR (TRIM(BOTH FROM "r"."manager_hr_id") = ''::"text")) THEN 'missing_manager_hr_id'::"text"
            WHEN (("er"."hr_id" IS NOT NULL) AND (COALESCE("ero"."role", ''::"text") <> 'MR'::"text") AND (COALESCE("er"."job_title", ''::"text") !~* '(medical|representative|mr)'::"text")) THEN 'mr_role_check'::"text"
            WHEN (("mr"."hr_id" IS NOT NULL) AND (COALESCE("mro"."role", ''::"text") <> 'DSM'::"text") AND (COALESCE("mr"."job_title", ''::"text") !~* '(district|dsm|manager)'::"text")) THEN 'dsm_role_check'::"text"
            ELSE 'ok'::"text"
        END AS "linkage_health_status"
   FROM ((((("public"."sales_records" "r"
     JOIN "public"."sales_import_batches" "b" ON (("b"."id" = "r"."batch_id")))
     LEFT JOIN "public"."employees" "er" ON (("lower"("er"."hr_id") = "lower"("r"."employee_hr_id"))))
     LEFT JOIN "public"."employees" "mr" ON (("lower"("mr"."hr_id") = "lower"("r"."manager_hr_id"))))
     LEFT JOIN "public"."sales_role_overrides" "ero" ON (("lower"("ero"."hr_id") = "lower"("r"."employee_hr_id"))))
     LEFT JOIN "public"."sales_role_overrides" "mro" ON (("lower"("mro"."hr_id") = "lower"("r"."manager_hr_id"))));


ALTER VIEW "public"."sales_employee_linkage_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sales_employee_linkage_health_summary" WITH ("security_invoker"='true') AS
 SELECT "batch_id",
    "file_name",
    "period",
    "line",
    ("count"(*))::integer AS "total_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'ok'::"text")))::integer AS "healthy_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'area_without_mr'::"text")))::integer AS "area_without_mr_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'mr_not_found'::"text")))::integer AS "mr_not_found_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'manager_not_found'::"text")))::integer AS "manager_not_found_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'missing_manager_hr_id'::"text")))::integer AS "missing_manager_hr_id_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'mr_role_check'::"text")))::integer AS "mr_role_check_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'dsm_role_check'::"text")))::integer AS "dsm_role_check_rows",
    ("count"(*) FILTER (WHERE ("linkage_health_status" = 'excluded_c_o1'::"text")))::integer AS "excluded_c_o1_rows",
        CASE
            WHEN ("count"(*) FILTER (WHERE ("linkage_health_status" <> 'excluded_c_o1'::"text")) = 0) THEN (1)::numeric
            ELSE "round"((("count"(*) FILTER (WHERE ("linkage_health_status" = ANY (ARRAY['ok'::"text", 'area_without_mr'::"text"]))))::numeric / NULLIF(("count"(*) FILTER (WHERE ("linkage_health_status" <> 'excluded_c_o1'::"text")))::numeric, (0)::numeric)), 4)
        END AS "linkage_health_rate"
   FROM "public"."sales_employee_linkage_health"
  GROUP BY "batch_id", "file_name", "period", "line";


ALTER VIEW "public"."sales_employee_linkage_health_summary" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sales_records_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sales_records_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sales_records_id_seq" OWNED BY "public"."sales_records"."id";



CREATE TABLE IF NOT EXISTS "public"."sensitive_data_access_audit" (
    "id" bigint NOT NULL,
    "actor_auth_user_id" "uuid",
    "actor_hr_id" "text",
    "actor_role" "text",
    "action" "text" NOT NULL,
    "table_name" "text" NOT NULL,
    "row_ref" "text",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sensitive_data_access_audit" OWNER TO "postgres";


ALTER TABLE "public"."sensitive_data_access_audit" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."sensitive_data_access_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."system_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid",
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text",
    "metadata" "jsonb",
    "ip_address" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."system_audit_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_audit_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."teams_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."teams_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."teams_id_seq" OWNED BY "public"."teams"."id";



CREATE TABLE IF NOT EXISTS "public"."thread_members" (
    "thread_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "thread_members_role_check" CHECK (("role" = ANY (ARRAY['member'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."thread_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_access_profiles" (
    "auth_user_id" "uuid" NOT NULL,
    "hr_id" "text" NOT NULL,
    "role" "text" DEFAULT 'employee'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "login_id" "text",
    "line" "text",
    "manager_hr_id" "text",
    "phoenix_role" "text",
    "scope_type" "text",
    CONSTRAINT "user_access_profiles_phoenix_role_check" CHECK ((("phoenix_role" IS NULL) OR ("phoenix_role" = ANY (ARRAY['Employee'::"text", 'Medical Rep'::"text", 'District Manager'::"text", 'Regional Manager'::"text", 'Regional Sales Manager'::"text", 'National Sales Manager'::"text", 'Product Manager'::"text", 'Group Product Manager'::"text", 'SFE Manager'::"text", 'Training Manager'::"text", 'Marketing Manager'::"text", 'Finance Manager'::"text", 'HR Specialist'::"text", 'Manager'::"text", 'CEO'::"text", 'Super Admin'::"text"])))),
    CONSTRAINT "user_access_profiles_role_check" CHECK (("role" = ANY (ARRAY['employee'::"text", 'manager'::"text", 'hr'::"text", 'finance'::"text", 'company_reader'::"text", 'super_admin'::"text", 'admin'::"text"]))),
    CONSTRAINT "user_access_profiles_scope_type_check" CHECK ((("scope_type" IS NULL) OR ("scope_type" = ANY (ARRAY['SELF'::"text", 'TEAM'::"text", 'HIERARCHY'::"text", 'LINE'::"text", 'DEPARTMENT'::"text", 'COMPANY_READ'::"text", 'FINANCE'::"text", 'HR'::"text", 'SUPER_ADMIN'::"text"]))))
);


ALTER TABLE "public"."user_access_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "user_id" "uuid" NOT NULL,
    "role_id" bigint NOT NULL,
    "assigned_by_user_id" "uuid",
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."user_roles" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "employee_hr_id" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "last_login_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "hr_id" "text",
    "username" "text",
    "password_hash" "text",
    "line" "text" DEFAULT 'Other'::"text" NOT NULL,
    "manager_hr_id" "text",
    "sales_scope_override" "text"
);

ALTER TABLE ONLY "public"."users" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_active_organogram" WITH ("security_invoker"='true') AS
 SELECT "e"."hr_id",
    "e"."full_name",
    "e"."name_ar",
    "e"."job_title",
    "e"."manager_hr_id",
    "m"."full_name" AS "manager_name",
    "e"."department_id",
    "d"."name" AS "department_name",
    "e"."line_id",
    "l"."name" AS "line_name",
    "e"."area_id",
    "a"."name" AS "area_name",
    "e"."team_id",
    "t"."name" AS "team_name",
    "e"."position_id",
    "p"."title" AS "position_title",
    "e"."hire_date",
    "e"."employment_status",
    "e"."payroll_eligible",
    "e"."organogram_visible"
   FROM (((((("public"."employees" "e"
     LEFT JOIN "public"."employees" "m" ON (("m"."hr_id" = "e"."manager_hr_id")))
     LEFT JOIN "public"."departments" "d" ON (("d"."id" = "e"."department_id")))
     LEFT JOIN "public"."lines" "l" ON (("l"."id" = "e"."line_id")))
     LEFT JOIN "public"."areas" "a" ON (("a"."id" = "e"."area_id")))
     LEFT JOIN "public"."teams" "t" ON (("t"."id" = "e"."team_id")))
     LEFT JOIN "public"."positions" "p" ON (("p"."id" = "e"."position_id")))
  WHERE ((COALESCE("e"."organogram_visible", true) = true) AND (COALESCE("e"."employment_status", 'active'::"text") = 'active'::"text"));


ALTER VIEW "public"."v_active_organogram" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_employee_locations_masked" WITH ("security_invoker"='true') AS
 SELECT "id",
    "employee_hr_id",
        CASE
            WHEN ("private"."phx_can_manage_workforce"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))) THEN "residence_address"
            ELSE NULL::"text"
        END AS "residence_address",
    "residence_city",
    "residence_area",
        CASE
            WHEN ("private"."phx_can_manage_workforce"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))) THEN "residence_latitude"
            ELSE ("round"(("residence_latitude")::numeric, 2))::double precision
        END AS "residence_latitude",
        CASE
            WHEN ("private"."phx_can_manage_workforce"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))) THEN "residence_longitude"
            ELSE ("round"(("residence_longitude")::numeric, 2))::double precision
        END AS "residence_longitude",
    "geocode_status",
    "updated_at",
    "created_at"
   FROM "public"."employee_locations" "el"
  WHERE ("private"."phx_can_access_employee"("employee_hr_id") AND "private"."log_sensitive_data_access_event"('employee_locations'::"text", "employee_hr_id", 'select'::"text", 'v_employee_locations_masked'::"text"));


ALTER VIEW "public"."v_employee_locations_masked" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_employee_portal_payslips" WITH ("security_invoker"='true') AS
 SELECT "sr"."id",
    "sr"."batch_id",
    "sr"."hr_id",
    COALESCE("e"."full_name", "sr"."full_name") AS "employee_name",
    COALESCE("e"."job_title", "sr"."job_title") AS "job_title",
    COALESCE("l"."name", "sr"."line") AS "line_name",
    COALESCE("a"."name", "sr"."area") AS "area_name",
    "sb"."year",
    "sb"."month",
    "sb"."status" AS "batch_status",
    "sr"."gross_salary",
    "sr"."expenses",
    "sr"."incentive",
    "sr"."overtime",
    "sr"."bonus",
    "sr"."extra_cost_of_living",
    "sr"."fuel_allowance",
    "sr"."other_additions",
    "sr"."total_additions",
    "sr"."social_insurance",
    "sr"."employment_income_tax",
    "sr"."crm",
    "sr"."finger_print",
    "sr"."unpaid_vacations",
    "sr"."medical_insurance",
    "sr"."loans",
    "sr"."other_deductions",
    "sr"."total_deductions",
    "sr"."net_salary",
    "sr"."first_part",
    "sr"."second_part",
    "sr"."created_at"
   FROM (((("public"."salary_records" "sr"
     JOIN "public"."salary_batches" "sb" ON (("sb"."id" = "sr"."batch_id")))
     LEFT JOIN "public"."employees" "e" ON (("e"."hr_id" = "sr"."hr_id")))
     LEFT JOIN "public"."lines" "l" ON (("l"."id" = "e"."line_id")))
     LEFT JOIN "public"."areas" "a" ON (("a"."id" = "e"."area_id")));


ALTER VIEW "public"."v_employee_portal_payslips" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_employee_portal_salary_history" WITH ("security_invoker"='true') AS
 SELECT "r"."hr_id",
    "r"."batch_id",
    "b"."month",
    "b"."year",
    "r"."gross_salary",
    "r"."net_salary",
    "r"."total_additions",
    "r"."total_deductions",
    "r"."created_at"
   FROM ("public"."salary_records" "r"
     JOIN "public"."salary_batches" "b" ON (("r"."batch_id" = "b"."id")))
  WHERE ("b"."status" = 'approved'::"text");


ALTER VIEW "public"."v_employee_portal_salary_history" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_employee_portal_sales" WITH ("security_invoker"='true') AS
 SELECT "id",
    "batch_id",
    COALESCE("employee_hr_id", "manager_hr_id") AS "hr_id",
    "employee_hr_id",
    "employee_name",
    "manager_hr_id",
    "employee_crm_id",
    "employee_lookup_key",
    "line",
    "territory",
    "sales_type",
    "family",
    "product",
    "month",
    "year",
    "factory_price",
    "sales_units",
    "sales_value",
    "target_units",
    "target_value",
        CASE
            WHEN ("target_value" > (0)::numeric) THEN "round"((("sales_value" / "target_value") * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS "achievement_value_percent",
        CASE
            WHEN ("target_units" > (0)::numeric) THEN "round"((("sales_units" / "target_units") * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS "achievement_units_percent",
    "validation_state",
    "link_status",
    "link_confidence",
    "created_at"
   FROM "public"."sales_records"
  WHERE (("employee_hr_id" IS NOT NULL) OR ("manager_hr_id" IS NOT NULL));


ALTER VIEW "public"."v_employee_portal_sales" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_employee_portal_sales_filters" WITH ("security_invoker"='true') AS
 SELECT DISTINCT "employee_hr_id" AS "hr_id",
    "year",
    "month",
    "line",
    "territory",
    "sales_type",
    "family",
    "product"
   FROM "public"."sales_records"
  WHERE ("employee_hr_id" IS NOT NULL);


ALTER VIEW "public"."v_employee_portal_sales_filters" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_hr_id_orphan_audit" WITH ("security_invoker"='true') AS
 WITH "employee_index" AS (
         SELECT "lower"(TRIM(BOTH FROM "employees"."hr_id")) AS "normalized_hr_id"
           FROM "public"."employees"
          WHERE (("employees"."hr_id" IS NOT NULL) AND (TRIM(BOTH FROM "employees"."hr_id") <> ''::"text"))
        ), "orphan_rows" AS (
         SELECT 'sales_records.employee_hr_id'::"text" AS "source",
            "sr"."employee_hr_id" AS "hr_id",
            "count"(*) AS "rows_count",
            "min"(NULLIF(TRIM(BOTH FROM "sr"."employee_name"), ''::"text")) AS "sample_name"
           FROM ("public"."sales_records" "sr"
             LEFT JOIN "employee_index" "ei" ON (("ei"."normalized_hr_id" = "lower"(TRIM(BOTH FROM "sr"."employee_hr_id")))))
          WHERE (("sr"."employee_hr_id" IS NOT NULL) AND (TRIM(BOTH FROM "sr"."employee_hr_id") <> ''::"text") AND ("ei"."normalized_hr_id" IS NULL))
          GROUP BY "sr"."employee_hr_id"
        UNION ALL
         SELECT 'sales_records.manager_hr_id'::"text" AS "source",
            "sr"."manager_hr_id" AS "hr_id",
            "count"(*) AS "rows_count",
            "min"(NULLIF(TRIM(BOTH FROM "sr"."employee_name"), ''::"text")) AS "sample_name"
           FROM ("public"."sales_records" "sr"
             LEFT JOIN "employee_index" "ei" ON (("ei"."normalized_hr_id" = "lower"(TRIM(BOTH FROM "sr"."manager_hr_id")))))
          WHERE (("sr"."manager_hr_id" IS NOT NULL) AND (TRIM(BOTH FROM "sr"."manager_hr_id") <> ''::"text") AND ("ei"."normalized_hr_id" IS NULL))
          GROUP BY "sr"."manager_hr_id"
        UNION ALL
         SELECT 'salary_flags.hr_id'::"text" AS "source",
            "sf"."hr_id",
            "count"(*) AS "rows_count",
            NULL::"text" AS "sample_name"
           FROM ("public"."salary_flags" "sf"
             LEFT JOIN "employee_index" "ei" ON (("ei"."normalized_hr_id" = "lower"(TRIM(BOTH FROM "sf"."hr_id")))))
          WHERE (("sf"."hr_id" IS NOT NULL) AND (TRIM(BOTH FROM "sf"."hr_id") <> ''::"text") AND ("ei"."normalized_hr_id" IS NULL))
          GROUP BY "sf"."hr_id"
        UNION ALL
         SELECT 'payroll_expenses.hr_id'::"text" AS "source",
            "pe"."hr_id",
            "count"(*) AS "rows_count",
            "min"(NULLIF(TRIM(BOTH FROM "pe"."specialist"), ''::"text")) AS "sample_name"
           FROM ("public"."payroll_expenses" "pe"
             LEFT JOIN "employee_index" "ei" ON (("ei"."normalized_hr_id" = "lower"(TRIM(BOTH FROM "pe"."hr_id")))))
          WHERE (("pe"."hr_id" IS NOT NULL) AND (TRIM(BOTH FROM "pe"."hr_id") <> ''::"text") AND ("ei"."normalized_hr_id" IS NULL))
          GROUP BY "pe"."hr_id"
        )
 SELECT "source",
    "hr_id",
    "rows_count",
    "sample_name"
   FROM "orphan_rows"
  ORDER BY "source", "hr_id";


ALTER VIEW "public"."v_hr_id_orphan_audit" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_lifecycle_dashboard" WITH ("security_invoker"='true') AS
 SELECT "hr_id",
    "full_name",
    "job_title",
    "employment_status",
    "hire_date",
    "probation_end_date",
    "contract_renewal_date",
    "birth_date",
    "resignation_date",
    "last_working_date",
    "payroll_eligible",
    "organogram_visible",
        CASE
            WHEN ("employment_status" = 'resigned'::"text") THEN 'resigned'::"text"
            WHEN (("probation_end_date" IS NOT NULL) AND ("probation_end_date" >= CURRENT_DATE)) THEN 'on_probation'::"text"
            WHEN (("contract_renewal_date" IS NOT NULL) AND (("contract_renewal_date" >= CURRENT_DATE) AND ("contract_renewal_date" <= (CURRENT_DATE + 60)))) THEN 'contract_due_soon'::"text"
            ELSE 'active'::"text"
        END AS "lifecycle_state"
   FROM "public"."employees" "e";


ALTER VIEW "public"."v_lifecycle_dashboard" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_payroll_eligible_employees" WITH ("security_invoker"='true') AS
 SELECT "hr_id",
    "full_name",
    "name_ar",
    "crm_id",
    "crm_username",
    "work_email",
    "mobile_number",
    "job_title",
    "hire_date",
    "employment_status",
    "education",
    "manager_hr_id",
    "department_id",
    "line_id",
    "area_id",
    "team_id",
    "position_id",
    "created_at",
    "updated_at",
    "region_name",
    "contract_signed_date",
    "contract_renewal_date",
    "probation_end_date",
    "contract_start_date",
    "contract_day",
    "contract_month_number",
    "contract_month_clean",
    "birth_date",
    "onboarding_source",
    "onboarding_status",
    "resignation_date",
    "last_working_date",
    "exit_reason",
    "exit_status",
    "payroll_eligible",
    "organogram_visible"
   FROM "public"."employees"
  WHERE ((COALESCE("payroll_eligible", true) = true) AND (COALESCE("employment_status", 'active'::"text") = 'active'::"text"));


ALTER VIEW "public"."v_payroll_eligible_employees" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_probation_tracker" WITH ("security_barrier"='true', "security_invoker"='true') AS
 SELECT "e"."hr_id",
    "e"."crm_id",
    "e"."full_name",
    "e"."job_title",
    "l"."name" AS "line_name",
    "a"."name" AS "area_name",
    "e"."hire_date",
    "e"."probation_end_date",
    "e"."employment_status",
    GREATEST(0, ("e"."probation_end_date" - CURRENT_DATE)) AS "days_remaining"
   FROM (("public"."employees" "e"
     LEFT JOIN "public"."lines" "l" ON (("l"."id" = "e"."line_id")))
     LEFT JOIN "public"."areas" "a" ON (("a"."id" = "e"."area_id")))
  WHERE (("e"."probation_end_date" IS NOT NULL) AND ("e"."hire_date" IS NOT NULL) AND ("e"."probation_end_date" >= CURRENT_DATE));


ALTER VIEW "public"."v_probation_tracker" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_unified_audit_logs" AS
 SELECT 'audit_logs'::"text" AS "source",
    ("audit_logs"."id")::"text" AS "id",
    "audit_logs"."actor_login_id" AS "actor_id",
    'system'::"text" AS "actor_type",
    "audit_logs"."entity_type",
    "audit_logs"."entity_id",
    "audit_logs"."summary" AS "action",
    "audit_logs"."summary",
    "audit_logs"."new_values" AS "metadata",
    "audit_logs"."created_at",
        CASE
            WHEN ("audit_logs"."summary" ~~* '%reject%'::"text") THEN 'rejected'::"text"
            WHEN (("audit_logs"."summary" ~~* '%fail%'::"text") OR ("audit_logs"."summary" ~~* '%error%'::"text")) THEN 'failed'::"text"
            WHEN ("audit_logs"."summary" ~~* '%approve%'::"text") THEN 'approved'::"text"
            WHEN (("audit_logs"."summary" ~~* '%success%'::"text") OR ("audit_logs"."summary" ~~* '%succeed%'::"text") OR ("audit_logs"."summary" ~~* '%sent%'::"text") OR ("audit_logs"."summary" ~~* '%accepted%'::"text")) THEN 'succeeded'::"text"
            ELSE 'changed'::"text"
        END AS "status",
        CASE
            WHEN ("audit_logs"."entity_type" = 'auth_session'::"text") THEN 'auth'::"text"
            WHEN ("audit_logs"."entity_type" = ANY (ARRAY['permission_override'::"text", 'salary_flag'::"text", 'user'::"text"])) THEN 'access'::"text"
            WHEN ("audit_logs"."entity_type" = 'coaching_report'::"text") THEN 'coaching'::"text"
            ELSE 'governance'::"text"
        END AS "module"
   FROM "public"."audit_logs"
UNION ALL
 SELECT 'sales_audit_logs'::"text" AS "source",
    ("sales_audit_logs"."id")::"text" AS "id",
    COALESCE("sales_audit_logs"."actor_username", 'system'::"text") AS "actor_id",
    'user'::"text" AS "actor_type",
    'sales_import'::"text" AS "entity_type",
    ("sales_audit_logs"."batch_id")::"text" AS "entity_id",
    "sales_audit_logs"."action",
    "sales_audit_logs"."action" AS "summary",
    ("sales_audit_logs"."metadata" || "jsonb_build_object"('line', "sales_audit_logs"."line", 'period', "sales_audit_logs"."period")) AS "metadata",
    "sales_audit_logs"."created_at",
        CASE
            WHEN ("sales_audit_logs"."action" ~~* '%reject%'::"text") THEN 'rejected'::"text"
            WHEN (("sales_audit_logs"."action" ~~* '%fail%'::"text") OR ("sales_audit_logs"."action" ~~* '%error%'::"text")) THEN 'failed'::"text"
            WHEN ("sales_audit_logs"."action" ~~* '%approve%'::"text") THEN 'approved'::"text"
            ELSE 'succeeded'::"text"
        END AS "status",
    'sales'::"text" AS "module"
   FROM "public"."sales_audit_logs"
UNION ALL
 SELECT 'job_offer_audit_logs'::"text" AS "source",
    ("job_offer_audit_logs"."id")::"text" AS "id",
    "job_offer_audit_logs"."actor_reference" AS "actor_id",
    "job_offer_audit_logs"."actor_type",
    'job_offer'::"text" AS "entity_type",
    ("job_offer_audit_logs"."offer_id")::"text" AS "entity_id",
    "job_offer_audit_logs"."action",
    "job_offer_audit_logs"."action" AS "summary",
    "job_offer_audit_logs"."details" AS "metadata",
    "job_offer_audit_logs"."created_at",
        CASE
            WHEN ("job_offer_audit_logs"."action" ~~* '%reject%'::"text") THEN 'rejected'::"text"
            WHEN (("job_offer_audit_logs"."action" ~~* '%fail%'::"text") OR ("job_offer_audit_logs"."action" ~~* '%error%'::"text")) THEN 'failed'::"text"
            WHEN ("job_offer_audit_logs"."action" ~~* '%approve%'::"text") THEN 'approved'::"text"
            ELSE 'succeeded'::"text"
        END AS "status",
    'recruitment'::"text" AS "module"
   FROM "public"."job_offer_audit_logs"
UNION ALL
 SELECT 'coaching_report_audit_logs'::"text" AS "source",
    ("coaching_report_audit_logs"."id")::"text" AS "id",
    "coaching_report_audit_logs"."actor_hr_id" AS "actor_id",
    'employee'::"text" AS "actor_type",
    'coaching_report'::"text" AS "entity_type",
    ("coaching_report_audit_logs"."report_id")::"text" AS "entity_id",
    "coaching_report_audit_logs"."action",
    "coaching_report_audit_logs"."action" AS "summary",
    ("coaching_report_audit_logs"."metadata" || "jsonb_build_object"('old_values', "coaching_report_audit_logs"."old_values", 'new_values', "coaching_report_audit_logs"."new_values")) AS "metadata",
    "coaching_report_audit_logs"."created_at",
        CASE
            WHEN ("coaching_report_audit_logs"."action" ~~* '%reject%'::"text") THEN 'rejected'::"text"
            WHEN (("coaching_report_audit_logs"."action" ~~* '%fail%'::"text") OR ("coaching_report_audit_logs"."action" ~~* '%error%'::"text")) THEN 'failed'::"text"
            WHEN ("coaching_report_audit_logs"."action" ~~* '%approve%'::"text") THEN 'approved'::"text"
            ELSE 'succeeded'::"text"
        END AS "status",
    'coaching'::"text" AS "module"
   FROM "public"."coaching_report_audit_logs"
UNION ALL
 SELECT 'outstation_location_audit_logs'::"text" AS "source",
    ("outstation_location_audit_logs"."id")::"text" AS "id",
    "outstation_location_audit_logs"."employee_hr_id" AS "actor_id",
    'employee'::"text" AS "actor_type",
    'outstation_location'::"text" AS "entity_type",
    ("outstation_location_audit_logs"."expense_request_id")::"text" AS "entity_id",
    "outstation_location_audit_logs"."validation_result" AS "action",
    "outstation_location_audit_logs"."validation_reason" AS "summary",
    "outstation_location_audit_logs"."fraud_flags_json" AS "metadata",
    "outstation_location_audit_logs"."created_at",
    "outstation_location_audit_logs"."validation_result" AS "status",
    'outstation'::"text" AS "module"
   FROM "public"."outstation_location_audit_logs";


ALTER VIEW "public"."v_unified_audit_logs" OWNER TO "postgres";


ALTER TABLE ONLY "internal"."phoenix_date_offset_repair_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"internal"."phoenix_date_offset_repair_audit_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."areas" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."areas_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."departments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."departments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."employee_contracts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."employee_contracts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."employee_history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."employee_history_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."employee_probation" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."employee_probation_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lines" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lines_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."permissions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."permissions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."position_vacancies" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."position_vacancies_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."positions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."positions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."roles" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."roles_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sales_audit_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sales_audit_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sales_records" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sales_records_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."teams" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."teams_id_seq"'::"regclass");



ALTER TABLE ONLY "internal"."phoenix_date_offset_repair_audit"
    ADD CONSTRAINT "phoenix_date_offset_repair_au_repair_key_table_name_primary_key" UNIQUE ("repair_key", "table_name", "primary_key", "column_name");



ALTER TABLE ONLY "internal"."phoenix_date_offset_repair_audit"
    ADD CONSTRAINT "phoenix_date_offset_repair_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "private"."security_definer_function_exceptions"
    ADD CONSTRAINT "security_definer_function_exceptions_pkey" PRIMARY KEY ("function_signature");



ALTER TABLE ONLY "public"."access_scopes"
    ADD CONSTRAINT "access_scopes_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."access_scopes"
    ADD CONSTRAINT "access_scopes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_auth_users"
    ADD CONSTRAINT "app_auth_users_pkey" PRIMARY KEY ("login_id");



ALTER TABLE ONLY "public"."areas"
    ADD CONSTRAINT "areas_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."areas"
    ADD CONSTRAINT "areas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_login_attempts"
    ADD CONSTRAINT "auth_login_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brick_reference_imports"
    ADD CONSTRAINT "brick_reference_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brick_reference_rows"
    ADD CONSTRAINT "brick_reference_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaching_report_acknowledgments"
    ADD CONSTRAINT "coaching_report_acknowledgments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaching_report_audit_logs"
    ADD CONSTRAINT "coaching_report_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_report_number_key" UNIQUE ("report_number");



ALTER TABLE "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_zone_check" CHECK ((("performance_zone" IS NULL) OR ("performance_zone" = ANY (ARRAY['critical_red'::"text", 'red_zone'::"text", 'yellow_zone'::"text", 'green_zone'::"text", 'excellence_zone'::"text"])))) NOT VALID;



ALTER TABLE ONLY "public"."coaching_score_items"
    ADD CONSTRAINT "coaching_score_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coaching_score_items"
    ADD CONSTRAINT "coaching_score_items_report_key_unique" UNIQUE ("report_id", "score_item_key");



ALTER TABLE ONLY "public"."contract_renewal_history"
    ADD CONSTRAINT "contract_renewal_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contract_renewal_requests"
    ADD CONSTRAINT "contract_renewal_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_notification_policies"
    ADD CONSTRAINT "email_notification_policies_pkey" PRIMARY KEY ("notification_type");



ALTER TABLE ONLY "public"."employee_compensation"
    ADD CONSTRAINT "employee_compensation_pkey" PRIMARY KEY ("employee_hr_id");



ALTER TABLE ONLY "public"."employee_contracts"
    ADD CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_leave_balances"
    ADD CONSTRAINT "employee_leave_balances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_leave_balances"
    ADD CONSTRAINT "employee_leave_balances_unique" UNIQUE ("employee_hr_id", "leave_type_id", "policy_id", "year");



ALTER TABLE ONLY "public"."employee_locations"
    ADD CONSTRAINT "employee_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_probation"
    ADD CONSTRAINT "employee_probation_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_resignations"
    ADD CONSTRAINT "employee_resignations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("hr_id");



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_work_email_key" UNIQUE ("work_email");



ALTER TABLE ONLY "public"."geo_bricks"
    ADD CONSTRAINT "geo_bricks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."geo_locations"
    ADD CONSTRAINT "geo_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."geo_trip_routes"
    ADD CONSTRAINT "geo_trip_routes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_offer_audit_logs"
    ADD CONSTRAINT "job_offer_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_offer_code_key" UNIQUE ("offer_code");



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_secure_token_hash_key" UNIQUE ("secure_token_hash");



ALTER TABLE ONLY "public"."leave_accrual_runs"
    ADD CONSTRAINT "leave_accrual_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_approvals"
    ADD CONSTRAINT "leave_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_attachment_objects"
    ADD CONSTRAINT "leave_attachment_objects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_audit_logs"
    ADD CONSTRAINT "leave_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_notification_attempts"
    ADD CONSTRAINT "leave_notification_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_policies"
    ADD CONSTRAINT "leave_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_request_events"
    ADD CONSTRAINT "leave_request_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_transactions"
    ADD CONSTRAINT "leave_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_types"
    ADD CONSTRAINT "leave_types_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."leave_types"
    ADD CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lines"
    ADD CONSTRAINT "lines_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."lines"
    ADD CONSTRAINT "lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_delivery_logs"
    ADD CONSTRAINT "notification_delivery_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_event_key_key" UNIQUE ("event_key");



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_outbox"
    ADD CONSTRAINT "notification_outbox_dedupe_key_key" UNIQUE ("dedupe_key");



ALTER TABLE ONLY "public"."notification_outbox"
    ADD CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outstation_expense_requests"
    ADD CONSTRAINT "outstation_expense_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outstation_location_audit_logs"
    ADD CONSTRAINT "outstation_location_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outstation_policy_rules"
    ADD CONSTRAINT "outstation_policy_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."password_setup_tokens"
    ADD CONSTRAINT "password_setup_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."password_setup_tokens"
    ADD CONSTRAINT "password_setup_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."payroll_expense_reports"
    ADD CONSTRAINT "payroll_expense_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_expenses"
    ADD CONSTRAINT "payroll_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_expenses"
    ADD CONSTRAINT "payroll_expenses_trip_id_key" UNIQUE ("trip_id");



ALTER TABLE ONLY "public"."payroll_resignation_candidates"
    ADD CONSTRAINT "payroll_resignation_candidates_hr_id_key" UNIQUE ("hr_id");



ALTER TABLE ONLY "public"."payroll_resignation_candidates"
    ADD CONSTRAINT "payroll_resignation_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_resource_action_unique" UNIQUE ("resource", "action");



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_vacancy_code_key" UNIQUE ("vacancy_code");



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."public_holidays"
    ADD CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."public_holidays"
    ADD CONSTRAINT "public_holidays_unique" UNIQUE ("country", "date");



ALTER TABLE ONLY "public"."role_permission_overrides"
    ADD CONSTRAINT "role_permission_overrides_pkey" PRIMARY KEY ("role_name", "resource", "action");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_name_unique" UNIQUE ("name");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_batches"
    ADD CONSTRAINT "salary_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_flags"
    ADD CONSTRAINT "salary_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_records"
    ADD CONSTRAINT "salary_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_audit_logs"
    ADD CONSTRAINT "sales_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_import_batches"
    ADD CONSTRAINT "sales_import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_role_overrides"
    ADD CONSTRAINT "sales_role_overrides_pkey" PRIMARY KEY ("hr_id");



ALTER TABLE ONLY "public"."sensitive_data_access_audit"
    ADD CONSTRAINT "sensitive_data_access_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_audit_logs"
    ADD CONSTRAINT "system_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."thread_members"
    ADD CONSTRAINT "thread_members_pkey" PRIMARY KEY ("thread_id", "user_id");



ALTER TABLE ONLY "public"."threads"
    ADD CONSTRAINT "threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_access_profiles"
    ADD CONSTRAINT "user_access_profiles_hr_id_key" UNIQUE ("hr_id");



ALTER TABLE ONLY "public"."user_access_profiles"
    ADD CONSTRAINT "user_access_profiles_pkey" PRIMARY KEY ("auth_user_id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "app_auth_users_auth_email_idx" ON "public"."app_auth_users" USING "btree" ("auth_email") WHERE ("auth_email" IS NOT NULL);



CREATE UNIQUE INDEX "app_auth_users_auth_user_id_idx" ON "public"."app_auth_users" USING "btree" ("auth_user_id") WHERE ("auth_user_id" IS NOT NULL);



CREATE INDEX "app_auth_users_hr_id_idx" ON "public"."app_auth_users" USING "btree" ("hr_id");



CREATE INDEX "app_auth_users_line_idx" ON "public"."app_auth_users" USING "btree" ("line");



CREATE INDEX "app_auth_users_locked_until_idx" ON "public"."app_auth_users" USING "btree" ("locked_until") WHERE ("locked_until" IS NOT NULL);



CREATE UNIQUE INDEX "app_auth_users_login_id_lower_idx" ON "public"."app_auth_users" USING "btree" ("lower"("login_id"));



CREATE INDEX "app_auth_users_login_lockout_idx" ON "public"."app_auth_users" USING "btree" ("login_id", "locked_until");



CREATE INDEX "app_auth_users_role_idx" ON "public"."app_auth_users" USING "btree" ("role") WHERE ("is_active" = true);



CREATE INDEX "audit_logs_created_at_idx" ON "public"."audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "auth_login_attempts_attempted_at_idx" ON "public"."auth_login_attempts" USING "btree" ("attempted_at" DESC);



CREATE INDEX "auth_login_attempts_login_ip_idx" ON "public"."auth_login_attempts" USING "btree" ("login_id", "ip", "attempted_at" DESC);



CREATE INDEX "brick_reference_imports_line_created_idx" ON "public"."brick_reference_imports" USING "btree" ("line", "created_at" DESC);



CREATE INDEX "brick_reference_rows_dsm_hr_id_idx" ON "public"."brick_reference_rows" USING "btree" ("dsm_hr_id");



CREATE INDEX "brick_reference_rows_import_idx" ON "public"."brick_reference_rows" USING "btree" ("import_id");



CREATE INDEX "brick_reference_rows_line_area_idx" ON "public"."brick_reference_rows" USING "btree" ("line", "area");



CREATE INDEX "brick_reference_rows_line_brick_idx" ON "public"."brick_reference_rows" USING "btree" ("line", "brick_name_normalized");



CREATE INDEX "coaching_report_acknowledgments_employee_hr_id_idx" ON "public"."coaching_report_acknowledgments" USING "btree" ("employee_hr_id");



CREATE INDEX "coaching_report_acknowledgments_report_id_idx" ON "public"."coaching_report_acknowledgments" USING "btree" ("report_id");



CREATE UNIQUE INDEX "coaching_report_acknowledgments_report_id_unique_idx" ON "public"."coaching_report_acknowledgments" USING "btree" ("report_id");



CREATE INDEX "coaching_report_audit_logs_actor_hr_id_idx" ON "public"."coaching_report_audit_logs" USING "btree" ("actor_hr_id", "created_at" DESC);



CREATE INDEX "coaching_report_audit_logs_report_id_idx" ON "public"."coaching_report_audit_logs" USING "btree" ("report_id", "created_at" DESC);



CREATE INDEX "coaching_reports_coach_hr_id_idx" ON "public"."coaching_reports" USING "btree" ("coach_hr_id");



CREATE INDEX "coaching_reports_coaching_date_idx" ON "public"."coaching_reports" USING "btree" ("coaching_date");



CREATE INDEX "coaching_reports_line_area_team_idx" ON "public"."coaching_reports" USING "btree" ("line_id", "area_id", "team_id");



CREATE INDEX "coaching_reports_medical_rep_hr_id_idx" ON "public"."coaching_reports" USING "btree" ("medical_rep_hr_id");



CREATE INDEX "coaching_reports_month_year_idx" ON "public"."coaching_reports" USING "btree" ("coaching_year", "coaching_month");



CREATE INDEX "coaching_reports_performance_zone_idx" ON "public"."coaching_reports" USING "btree" ("performance_zone");



CREATE INDEX "coaching_reports_rep_period_idx" ON "public"."coaching_reports" USING "btree" ("medical_rep_hr_id", "coaching_year", "coaching_quarter");



CREATE INDEX "coaching_reports_status_idx" ON "public"."coaching_reports" USING "btree" ("status");



CREATE INDEX "coaching_reports_year_quarter_idx" ON "public"."coaching_reports" USING "btree" ("coaching_year", "coaching_quarter");



CREATE INDEX "coaching_score_items_category_idx" ON "public"."coaching_score_items" USING "btree" ("parameter_category");



CREATE INDEX "coaching_score_items_report_category_key_idx" ON "public"."coaching_score_items" USING "btree" ("report_id", "parameter_category", "score_item_key");



CREATE INDEX "coaching_score_items_report_id_idx" ON "public"."coaching_score_items" USING "btree" ("report_id");



CREATE INDEX "contract_renewal_history_employee_hr_id_idx" ON "public"."contract_renewal_history" USING "btree" ("employee_hr_id", "created_at" DESC);



CREATE INDEX "contract_renewal_requests_employee_hr_id_idx" ON "public"."contract_renewal_requests" USING "btree" ("employee_hr_id");



CREATE INDEX "contract_renewal_requests_requested_date_idx" ON "public"."contract_renewal_requests" USING "btree" ("requested_renewal_date");



CREATE INDEX "contract_renewal_requests_status_idx" ON "public"."contract_renewal_requests" USING "btree" ("status");



CREATE INDEX "departments_is_active_idx" ON "public"."departments" USING "btree" ("is_active");



CREATE INDEX "employee_compensation_hr_mode_idx" ON "public"."employee_compensation" USING "btree" ("employee_hr_id", "payment_mode");



CREATE INDEX "employee_contracts_employee_hr_id_idx" ON "public"."employee_contracts" USING "btree" ("employee_hr_id");



CREATE INDEX "employee_contracts_renewal_date_idx" ON "public"."employee_contracts" USING "btree" ("contract_renewal_date");



CREATE INDEX "employee_documents_employee_hr_id_idx" ON "public"."employee_documents" USING "btree" ("employee_hr_id");



CREATE INDEX "employee_documents_uploaded_by_user_id_idx" ON "public"."employee_documents" USING "btree" ("uploaded_by_user_id");



CREATE INDEX "employee_history_area_id_idx" ON "public"."employee_history" USING "btree" ("area_id");



CREATE INDEX "employee_history_changed_by_user_id_idx" ON "public"."employee_history" USING "btree" ("changed_by_user_id");



CREATE INDEX "employee_history_department_id_idx" ON "public"."employee_history" USING "btree" ("department_id");



CREATE INDEX "employee_history_hr_id_idx" ON "public"."employee_history" USING "btree" ("employee_hr_id");



CREATE INDEX "employee_history_line_id_idx" ON "public"."employee_history" USING "btree" ("line_id");



CREATE INDEX "employee_history_position_id_idx" ON "public"."employee_history" USING "btree" ("position_id");



CREATE INDEX "employee_history_team_id_idx" ON "public"."employee_history" USING "btree" ("team_id");



CREATE INDEX "employee_history_type_idx" ON "public"."employee_history" USING "btree" ("change_type");



CREATE UNIQUE INDEX "employee_locations_employee_hr_id_uidx" ON "public"."employee_locations" USING "btree" ("employee_hr_id");



CREATE INDEX "employee_resignations_effective_date_idx" ON "public"."employee_resignations" USING "btree" ("effective_date");



CREATE INDEX "employee_resignations_employee_hr_id_idx" ON "public"."employee_resignations" USING "btree" ("employee_hr_id");



CREATE INDEX "employee_resignations_last_working_date_idx" ON "public"."employee_resignations" USING "btree" ("last_working_date");



CREATE INDEX "employee_resignations_status_idx" ON "public"."employee_resignations" USING "btree" ("status");



CREATE INDEX "employee_resignations_submitted_by_hr_id_idx" ON "public"."employee_resignations" USING "btree" ("submitted_by_hr_id");



CREATE INDEX "employee_resignations_vacancy_id_idx" ON "public"."employee_resignations" USING "btree" ("vacancy_id");



CREATE INDEX "employees_area_id_idx" ON "public"."employees" USING "btree" ("area_id");



CREATE UNIQUE INDEX "employees_crm_id_unique_idx" ON "public"."employees" USING "btree" ("crm_id") WHERE (("crm_id" IS NOT NULL) AND (TRIM(BOTH FROM "crm_id") <> ''::"text"));



CREATE UNIQUE INDEX "employees_crm_username_unique_idx" ON "public"."employees" USING "btree" ("lower"("crm_username")) WHERE (("crm_username" IS NOT NULL) AND (TRIM(BOTH FROM "crm_username") <> ''::"text"));



CREATE INDEX "employees_hr_id_idx" ON "public"."employees" USING "btree" ("hr_id");



CREATE INDEX "employees_job_title_idx" ON "public"."employees" USING "btree" ("job_title");



CREATE INDEX "employees_line_id_idx" ON "public"."employees" USING "btree" ("line_id");



CREATE INDEX "employees_manager_hr_id_idx" ON "public"."employees" USING "btree" ("manager_hr_id");



CREATE INDEX "employees_pending_manager_replacement_for_hr_id_idx" ON "public"."employees" USING "btree" ("pending_manager_replacement_for_hr_id");



CREATE INDEX "employees_position_id_idx" ON "public"."employees" USING "btree" ("position_id");



CREATE INDEX "employees_status_idx" ON "public"."employees" USING "btree" ("employment_status");



CREATE INDEX "employees_team_id_idx" ON "public"."employees" USING "btree" ("team_id");



CREATE UNIQUE INDEX "geo_bricks_code_idx" ON "public"."geo_bricks" USING "btree" ("brick_code");



CREATE INDEX "geo_bricks_line_area_idx" ON "public"."geo_bricks" USING "btree" ("line", "area");



CREATE INDEX "geo_locations_address_idx" ON "public"."geo_locations" USING "btree" ("address_text");



CREATE UNIQUE INDEX "geo_locations_source_key_idx" ON "public"."geo_locations" USING "btree" ("source_type", "source_key");



CREATE INDEX "geo_trip_routes_employee_idx" ON "public"."geo_trip_routes" USING "btree" ("employee_hr_id");



CREATE INDEX "geo_trip_routes_month_status_idx" ON "public"."geo_trip_routes" USING "btree" ("source_file_month", "status");



CREATE INDEX "idx_areas_line_id" ON "public"."areas" USING "btree" ("line_id");



CREATE INDEX "idx_audit_logs_actor_entity" ON "public"."audit_logs" USING "btree" ("actor_login_id", "entity_type", "entity_id");



CREATE INDEX "idx_coaching_audit_report" ON "public"."coaching_report_audit_logs" USING "btree" ("report_id");



CREATE INDEX "idx_employee_contracts_hr_id" ON "public"."employee_contracts" USING "btree" ("hr_id");



CREATE INDEX "idx_employee_contracts_renewal" ON "public"."employee_contracts" USING "btree" ("contract_renewal_date") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_employee_probation_end" ON "public"."employee_probation" USING "btree" ("probation_end_date") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_employee_probation_hr_id" ON "public"."employee_probation" USING "btree" ("hr_id");



CREATE INDEX "idx_employees_birth_date" ON "public"."employees" USING "btree" ("birth_date");



CREATE INDEX "idx_employees_composite_search" ON "public"."employees" USING "btree" ("full_name", "hr_id", "employment_status");



CREATE INDEX "idx_employees_contract_renewal_date" ON "public"."employees" USING "btree" ("contract_renewal_date");



CREATE INDEX "idx_employees_manager_status" ON "public"."employees" USING "btree" ("manager_hr_id", "employment_status");



CREATE INDEX "idx_employees_org" ON "public"."employees" USING "btree" ("department_id", "line_id", "area_id", "position_id");



CREATE INDEX "idx_job_offers_status_expires" ON "public"."job_offers" USING "btree" ("status", "expires_at");



CREATE INDEX "idx_lines_department_id" ON "public"."lines" USING "btree" ("department_id");



CREATE INDEX "idx_notification_events_category" ON "public"."notification_events" USING "btree" ("category");



CREATE INDEX "idx_notification_events_employee_hr_id" ON "public"."notification_events" USING "btree" ("employee_hr_id");



CREATE INDEX "idx_notification_events_scheduled_for" ON "public"."notification_events" USING "btree" ("scheduled_for");



CREATE INDEX "idx_outstation_requests_status_hr" ON "public"."outstation_expense_requests" USING "btree" ("status", "employee_hr_id");



CREATE INDEX "idx_position_vacancies_manager_hr_id" ON "public"."position_vacancies" USING "btree" ("manager_hr_id");



CREATE INDEX "idx_position_vacancies_org" ON "public"."position_vacancies" USING "btree" ("department_id", "line_id", "area_id", "position_id");



CREATE INDEX "idx_positions_org" ON "public"."positions" USING "btree" ("department_id", "line_id", "area_id");



CREATE INDEX "idx_salary_flags_unresolved" ON "public"."salary_flags" USING "btree" ("resolved_at") WHERE ("resolved_at" IS NULL);



CREATE INDEX "idx_salary_records_batch_gross_net" ON "public"."salary_records" USING "btree" ("batch_id", "gross_salary", "net_salary");



CREATE INDEX "idx_salary_records_hr_created" ON "public"."salary_records" USING "btree" ("hr_id", "created_at" DESC);



CREATE INDEX "idx_sales_audit_batch" ON "public"."sales_audit_logs" USING "btree" ("batch_id");



CREATE INDEX "idx_sales_audit_logs_batch_id" ON "public"."sales_audit_logs" USING "btree" ("batch_id");



CREATE INDEX "idx_sales_import_batches_duplicate_hash" ON "public"."sales_import_batches" USING "btree" ("duplicate_hash");



CREATE INDEX "idx_sales_import_batches_status_period" ON "public"."sales_import_batches" USING "btree" ("status", "year", "month");



CREATE INDEX "idx_sales_records_batch_id" ON "public"."sales_records" USING "btree" ("batch_id");



CREATE INDEX "idx_sales_records_batch_values" ON "public"."sales_records" USING "btree" ("batch_id", "sales_value", "target_value");



CREATE INDEX "idx_sales_records_employee_hr_id" ON "public"."sales_records" USING "btree" ("employee_hr_id");



CREATE INDEX "idx_sales_records_employee_period" ON "public"."sales_records" USING "btree" ("employee_hr_id", "year", "month");



CREATE INDEX "idx_sales_records_manager_hr_id" ON "public"."sales_records" USING "btree" ("manager_hr_id");



CREATE INDEX "idx_sales_records_period" ON "public"."sales_records" USING "btree" ("year", "month");



CREATE INDEX "job_offer_audit_logs_offer_id_idx" ON "public"."job_offer_audit_logs" USING "btree" ("offer_id");



CREATE INDEX "job_offers_area_id_idx" ON "public"."job_offers" USING "btree" ("area_id");



CREATE INDEX "job_offers_candidate_email_idx" ON "public"."job_offers" USING "btree" ("lower"("candidate_email"));



CREATE INDEX "job_offers_created_by_hr_id_idx" ON "public"."job_offers" USING "btree" ("created_by_hr_id");



CREATE INDEX "job_offers_department_id_idx" ON "public"."job_offers" USING "btree" ("department_id");



CREATE INDEX "job_offers_employee_hr_id_idx" ON "public"."job_offers" USING "btree" ("employee_hr_id");



CREATE INDEX "job_offers_expires_at_idx" ON "public"."job_offers" USING "btree" ("expires_at");



CREATE INDEX "job_offers_line_id_idx" ON "public"."job_offers" USING "btree" ("line_id");



CREATE INDEX "job_offers_manager_hr_id_idx" ON "public"."job_offers" USING "btree" ("manager_hr_id");



CREATE INDEX "job_offers_position_id_idx" ON "public"."job_offers" USING "btree" ("position_id");



CREATE INDEX "job_offers_status_idx" ON "public"."job_offers" USING "btree" ("status");



CREATE INDEX "leave_accrual_runs_period_idx" ON "public"."leave_accrual_runs" USING "btree" ("period", "created_at" DESC);



CREATE INDEX "leave_approvals_request_idx" ON "public"."leave_approvals" USING "btree" ("request_id", "created_at");



CREATE INDEX "leave_attachment_objects_employee_idx" ON "public"."leave_attachment_objects" USING "btree" ("employee_hr_id", "created_at" DESC);



CREATE INDEX "leave_attachment_objects_request_idx" ON "public"."leave_attachment_objects" USING "btree" ("request_id");



CREATE INDEX "leave_audit_logs_correlation_idx" ON "public"."leave_audit_logs" USING "btree" ("correlation_id", "created_at");



CREATE INDEX "leave_audit_logs_created_idx" ON "public"."leave_audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "leave_audit_logs_request_idx" ON "public"."leave_audit_logs" USING "btree" ("request_id", "created_at");



CREATE INDEX "leave_notification_attempts_request_id_idx" ON "public"."leave_notification_attempts" USING "btree" ("request_id", "created_at" DESC);



CREATE UNIQUE INDEX "leave_policies_default_active_uidx" ON "public"."leave_policies" USING "btree" ("country") WHERE (("is_default" = true) AND ("is_active" = true));



CREATE INDEX "leave_request_events_request_id_idx" ON "public"."leave_request_events" USING "btree" ("request_id", "created_at" DESC);



CREATE INDEX "leave_requests_created_at_idx" ON "public"."leave_requests" USING "btree" ("created_at" DESC);



CREATE INDEX "leave_requests_dates_idx" ON "public"."leave_requests" USING "btree" ("start_date", "end_date");



CREATE INDEX "leave_requests_employee_hr_id_idx" ON "public"."leave_requests" USING "btree" ("employee_hr_id");



CREATE INDEX "leave_requests_employee_idx" ON "public"."leave_requests" USING "btree" ("employee_hr_id", "requested_at" DESC);



CREATE INDEX "leave_requests_lineup_idx" ON "public"."leave_requests" USING "btree" ("leave_type_id", "policy_id", "employee_hr_id", "status");



CREATE INDEX "leave_requests_status_dates_idx" ON "public"."leave_requests" USING "btree" ("status", "start_date", "end_date");



CREATE INDEX "leave_requests_status_idx" ON "public"."leave_requests" USING "btree" ("status", "requested_at" DESC);



CREATE INDEX "leave_transactions_balance_idx" ON "public"."leave_transactions" USING "btree" ("employee_hr_id", "leave_type_id", "policy_id", "created_at");



CREATE UNIQUE INDEX "leave_transactions_monthly_accrual_uidx" ON "public"."leave_transactions" USING "btree" ("employee_hr_id", "leave_type_id", "policy_id", "transaction_type", "notes") WHERE (("transaction_type" = 'accrual'::"text") AND ("notes" ~~ 'monthly-accrual:%'::"text"));



CREATE INDEX "leave_transactions_request_idx" ON "public"."leave_transactions" USING "btree" ("request_id");



CREATE UNIQUE INDEX "leave_transactions_request_type_uidx" ON "public"."leave_transactions" USING "btree" ("request_id", "transaction_type") WHERE (("request_id" IS NOT NULL) AND ("transaction_type" = ANY (ARRAY['pending'::"text", 'pending_reversal'::"text", 'consumed'::"text", 'consumed_reversal'::"text"])));



CREATE INDEX "leave_transactions_type_notes_idx" ON "public"."leave_transactions" USING "btree" ("transaction_type", "notes", "created_at" DESC);



CREATE INDEX "messages_sender_id_idx" ON "public"."messages" USING "btree" ("sender_id");



CREATE INDEX "messages_thread_id_created_at_idx" ON "public"."messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "notification_outbox_created_at_idx" ON "public"."notification_outbox" USING "btree" ("created_at" DESC);



CREATE INDEX "notification_outbox_status_next_attempt_idx" ON "public"."notification_outbox" USING "btree" ("status", "next_attempt_at", "created_at");



CREATE INDEX "outstation_expense_requests_employee_idx" ON "public"."outstation_expense_requests" USING "btree" ("employee_hr_id");



CREATE INDEX "outstation_expense_requests_line_area_idx" ON "public"."outstation_expense_requests" USING "btree" ("line", "area", "to_city", "to_area");



CREATE INDEX "outstation_expense_requests_status_idx" ON "public"."outstation_expense_requests" USING "btree" ("status", "eligibility_status");



CREATE INDEX "outstation_location_audit_employee_idx" ON "public"."outstation_location_audit_logs" USING "btree" ("employee_hr_id", "created_at" DESC);



CREATE UNIQUE INDEX "outstation_policy_rules_role_name_uidx" ON "public"."outstation_policy_rules" USING "btree" ("role_name");



CREATE INDEX "password_setup_tokens_active_idx" ON "public"."password_setup_tokens" USING "btree" ("login_id", "expires_at") WHERE ("used_at" IS NULL);



CREATE INDEX "password_setup_tokens_login_id_idx" ON "public"."password_setup_tokens" USING "btree" ("login_id", "created_at" DESC);



CREATE INDEX "payroll_expenses_hr_id_idx" ON "public"."payroll_expenses" USING "btree" ("hr_id");



CREATE INDEX "payroll_expenses_payout_idx" ON "public"."payroll_expenses" USING "btree" ("payout_year", "payout_month");



CREATE INDEX "payroll_expenses_report_idx" ON "public"."payroll_expenses" USING "btree" ("report_id");



CREATE INDEX "payroll_resignation_candidates_line_idx" ON "public"."payroll_resignation_candidates" USING "btree" ("line_name");



CREATE INDEX "payroll_resignation_candidates_payout_idx" ON "public"."payroll_resignation_candidates" USING "btree" ("last_payout_year" DESC, "last_payout_month" DESC);



CREATE INDEX "platform_settings_updated_by_user_id_idx" ON "public"."platform_settings" USING "btree" ("updated_by_user_id");



CREATE INDEX "position_vacancies_area_id_idx" ON "public"."position_vacancies" USING "btree" ("area_id");



CREATE INDEX "position_vacancies_department_idx" ON "public"."position_vacancies" USING "btree" ("department_id");



CREATE INDEX "position_vacancies_filled_by_hr_id_idx" ON "public"."position_vacancies" USING "btree" ("filled_by_hr_id");



CREATE INDEX "position_vacancies_line_idx" ON "public"."position_vacancies" USING "btree" ("line_id");



CREATE INDEX "position_vacancies_manager_replacement_for_hr_id_idx" ON "public"."position_vacancies" USING "btree" ("manager_replacement_for_hr_id");



CREATE INDEX "position_vacancies_position_id_idx" ON "public"."position_vacancies" USING "btree" ("position_id");



CREATE INDEX "position_vacancies_replacement_for_hr_id_idx" ON "public"."position_vacancies" USING "btree" ("replacement_for_hr_id");



CREATE INDEX "position_vacancies_status_idx" ON "public"."position_vacancies" USING "btree" ("status");



CREATE INDEX "position_vacancies_team_id_idx" ON "public"."position_vacancies" USING "btree" ("team_id");



CREATE INDEX "positions_area_id_idx" ON "public"."positions" USING "btree" ("area_id");



CREATE INDEX "positions_line_id_idx" ON "public"."positions" USING "btree" ("line_id");



CREATE INDEX "positions_team_id_idx" ON "public"."positions" USING "btree" ("team_id");



CREATE INDEX "public_holidays_country_year_idx" ON "public"."public_holidays" USING "btree" ("country", "year");



CREATE INDEX "salary_batches_period_idx" ON "public"."salary_batches" USING "btree" ("year", "month");



CREATE INDEX "salary_batches_status_idx" ON "public"."salary_batches" USING "btree" ("status");



CREATE UNIQUE INDEX "salary_batches_year_month_unique_idx" ON "public"."salary_batches" USING "btree" ("year", "month");



CREATE INDEX "salary_flags_batch_id_idx" ON "public"."salary_flags" USING "btree" ("batch_id");



CREATE INDEX "salary_flags_hr_id_idx" ON "public"."salary_flags" USING "btree" ("hr_id");



CREATE INDEX "salary_flags_severity_idx" ON "public"."salary_flags" USING "btree" ("severity");



CREATE INDEX "salary_records_area_idx" ON "public"."salary_records" USING "btree" ("area");



CREATE INDEX "salary_records_batch_hr_idx" ON "public"."salary_records" USING "btree" ("batch_id", "hr_id");



CREATE INDEX "salary_records_batch_id_idx" ON "public"."salary_records" USING "btree" ("batch_id");



CREATE INDEX "salary_records_hr_id_idx" ON "public"."salary_records" USING "btree" ("hr_id");



CREATE INDEX "salary_records_line_idx" ON "public"."salary_records" USING "btree" ("line");



CREATE INDEX "sales_records_hr_period_idx" ON "public"."sales_records" USING "btree" ("employee_hr_id", "year", "month");



CREATE INDEX "sales_records_link_status_idx" ON "public"."sales_records" USING "btree" ("link_status");



CREATE INDEX "sensitive_data_access_audit_actor_created_idx" ON "public"."sensitive_data_access_audit" USING "btree" ("actor_hr_id", "created_at" DESC);



CREATE INDEX "sensitive_data_access_audit_table_created_idx" ON "public"."sensitive_data_access_audit" USING "btree" ("table_name", "created_at" DESC);



CREATE INDEX "system_audit_logs_actor_user_id_idx" ON "public"."system_audit_logs" USING "btree" ("actor_user_id");



CREATE INDEX "teams_area_id_idx" ON "public"."teams" USING "btree" ("area_id");



CREATE UNIQUE INDEX "teams_code_unique_idx" ON "public"."teams" USING "btree" ("lower"(TRIM(BOTH FROM "code"))) WHERE (NULLIF(TRIM(BOTH FROM COALESCE("code", ''::"text")), ''::"text") IS NOT NULL);



CREATE INDEX "teams_is_active_idx" ON "public"."teams" USING "btree" ("is_active");



CREATE INDEX "thread_members_user_id_idx" ON "public"."thread_members" USING "btree" ("user_id");



CREATE INDEX "user_access_profiles_hr_id_idx" ON "public"."user_access_profiles" USING "btree" ("hr_id");



CREATE INDEX "user_access_profiles_login_id_idx" ON "public"."user_access_profiles" USING "btree" ("login_id");



CREATE INDEX "user_access_profiles_manager_hr_id_idx" ON "public"."user_access_profiles" USING "btree" ("manager_hr_id");



CREATE INDEX "user_access_profiles_role_idx" ON "public"."user_access_profiles" USING "btree" ("role") WHERE ("is_active" = true);



CREATE INDEX "user_roles_assigned_by_user_id_idx" ON "public"."user_roles" USING "btree" ("assigned_by_user_id");



CREATE INDEX "user_roles_role_id_idx" ON "public"."user_roles" USING "btree" ("role_id");



CREATE INDEX "users_employee_hr_id_idx" ON "public"."users" USING "btree" ("employee_hr_id");



CREATE INDEX "users_hr_id_idx" ON "public"."users" USING "btree" ("hr_id");



CREATE INDEX "users_line_idx" ON "public"."users" USING "btree" ("line");



CREATE INDEX "users_manager_hr_id_idx" ON "public"."users" USING "btree" ("manager_hr_id");



CREATE OR REPLACE TRIGGER "phx_employee_insert_autofill_replacement_vacancy" AFTER INSERT ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."phx_autofill_replacement_vacancy_from_employee_insert"();



CREATE OR REPLACE TRIGGER "phx_employee_terminal_release_manager_ownership" AFTER UPDATE OF "employment_status", "payroll_eligible", "organogram_visible" ON "public"."employees" FOR EACH ROW WHEN ((("lower"(COALESCE("new"."employment_status", 'active'::"text")) = ANY (ARRAY['resigned'::"text", 'terminated'::"text", 'inactive'::"text"])) AND (("lower"(COALESCE("old"."employment_status", 'active'::"text")) <> ALL (ARRAY['resigned'::"text", 'terminated'::"text", 'inactive'::"text"])) OR ("old"."payroll_eligible" IS DISTINCT FROM "new"."payroll_eligible") OR ("old"."organogram_visible" IS DISTINCT FROM "new"."organogram_visible")))) EXECUTE FUNCTION "public"."phx_release_terminal_manager_ownership_trigger"();



CREATE OR REPLACE TRIGGER "phx_employees_prevent_hr_id_update" BEFORE UPDATE OF "hr_id" ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."phx_prevent_employee_hr_id_update"();



CREATE OR REPLACE TRIGGER "phx_prevent_closed_salary_batch_delete" BEFORE DELETE ON "public"."salary_batches" FOR EACH ROW EXECUTE FUNCTION "public"."phx_prevent_closed_salary_batch_delete"();



CREATE OR REPLACE TRIGGER "phx_prevent_closed_salary_batch_update" BEFORE UPDATE ON "public"."salary_batches" FOR EACH ROW EXECUTE FUNCTION "public"."phx_prevent_closed_salary_batch_update"();



CREATE OR REPLACE TRIGGER "phx_prevent_closed_salary_flags_mutation" BEFORE INSERT OR DELETE OR UPDATE ON "public"."salary_flags" FOR EACH ROW EXECUTE FUNCTION "public"."phx_prevent_closed_salary_detail_mutation"();



CREATE OR REPLACE TRIGGER "phx_prevent_closed_salary_records_mutation" BEFORE INSERT OR DELETE OR UPDATE ON "public"."salary_records" FOR EACH ROW EXECUTE FUNCTION "public"."phx_prevent_closed_salary_detail_mutation"();



CREATE OR REPLACE TRIGGER "phx_prevent_duplicate_salary_period" BEFORE INSERT OR UPDATE OF "month", "year", "status" ON "public"."salary_batches" FOR EACH ROW EXECUTE FUNCTION "public"."phx_prevent_duplicate_salary_period"();



CREATE OR REPLACE TRIGGER "set_coaching_reports_updated_at" BEFORE UPDATE ON "public"."coaching_reports" FOR EACH ROW EXECUTE FUNCTION "public"."set_coaching_updated_at"();



CREATE OR REPLACE TRIGGER "set_coaching_score_items_updated_at" BEFORE UPDATE ON "public"."coaching_score_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_coaching_updated_at"();



ALTER TABLE ONLY "public"."app_auth_users"
    ADD CONSTRAINT "app_auth_users_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."app_auth_users"
    ADD CONSTRAINT "app_auth_users_hr_id_fkey" FOREIGN KEY ("hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."areas"
    ADD CONSTRAINT "areas_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."brick_reference_rows"
    ADD CONSTRAINT "brick_reference_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."brick_reference_imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coaching_report_acknowledgments"
    ADD CONSTRAINT "coaching_report_acknowledgments_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."coaching_report_acknowledgments"
    ADD CONSTRAINT "coaching_report_acknowledgments_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."coaching_reports"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coaching_report_audit_logs"
    ADD CONSTRAINT "coaching_report_audit_logs_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."coaching_reports"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_coach_hr_id_fkey" FOREIGN KEY ("coach_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_medical_rep_hr_id_fkey" FOREIGN KEY ("medical_rep_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."coaching_reports"
    ADD CONSTRAINT "coaching_reports_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coaching_score_items"
    ADD CONSTRAINT "coaching_score_items_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."coaching_reports"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contract_renewal_history"
    ADD CONSTRAINT "contract_renewal_history_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contract_renewal_history"
    ADD CONSTRAINT "contract_renewal_history_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."contract_renewal_requests"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contract_renewal_requests"
    ADD CONSTRAINT "contract_renewal_requests_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_compensation"
    ADD CONSTRAINT "employee_compensation_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_contracts"
    ADD CONSTRAINT "employee_contracts_hr_id_fkey" FOREIGN KEY ("hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_history"
    ADD CONSTRAINT "employee_history_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_leave_balances"
    ADD CONSTRAINT "employee_leave_balances_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_leave_balances"
    ADD CONSTRAINT "employee_leave_balances_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."employee_leave_balances"
    ADD CONSTRAINT "employee_leave_balances_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."leave_policies"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."employee_locations"
    ADD CONSTRAINT "employee_locations_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_probation"
    ADD CONSTRAINT "employee_probation_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_probation"
    ADD CONSTRAINT "employee_probation_hr_id_fkey" FOREIGN KEY ("hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."employee_resignations"
    ADD CONSTRAINT "employee_resignations_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."employee_resignations"
    ADD CONSTRAINT "employee_resignations_submitted_by_hr_id_fkey" FOREIGN KEY ("submitted_by_hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."employee_resignations"
    ADD CONSTRAINT "employee_resignations_vacancy_id_fkey" FOREIGN KEY ("vacancy_id") REFERENCES "public"."position_vacancies"("id");



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_manager_hr_id_fkey" FOREIGN KEY ("manager_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."geo_bricks"
    ADD CONSTRAINT "geo_bricks_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."geo_trip_routes"
    ADD CONSTRAINT "geo_trip_routes_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offer_audit_logs"
    ADD CONSTRAINT "job_offer_audit_logs_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "public"."job_offers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_created_by_hr_id_fkey" FOREIGN KEY ("created_by_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_manager_hr_id_fkey" FOREIGN KEY ("manager_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_offers"
    ADD CONSTRAINT "job_offers_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leave_approvals"
    ADD CONSTRAINT "leave_approvals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_attachment_objects"
    ADD CONSTRAINT "leave_attachment_objects_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_attachment_objects"
    ADD CONSTRAINT "leave_attachment_objects_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leave_audit_logs"
    ADD CONSTRAINT "leave_audit_logs_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leave_audit_logs"
    ADD CONSTRAINT "leave_audit_logs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leave_notification_attempts"
    ADD CONSTRAINT "leave_notification_attempts_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_request_events"
    ADD CONSTRAINT "leave_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_balance_leave_type_id_fkey" FOREIGN KEY ("balance_leave_type_id") REFERENCES "public"."leave_types"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."leave_policies"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."leave_transactions"
    ADD CONSTRAINT "leave_transactions_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_transactions"
    ADD CONSTRAINT "leave_transactions_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."leave_transactions"
    ADD CONSTRAINT "leave_transactions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."leave_policies"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."leave_transactions"
    ADD CONSTRAINT "leave_transactions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lines"
    ADD CONSTRAINT "lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."outstation_expense_requests"
    ADD CONSTRAINT "outstation_expense_requests_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."outstation_location_audit_logs"
    ADD CONSTRAINT "outstation_location_audit_logs_expense_request_id_fkey" FOREIGN KEY ("expense_request_id") REFERENCES "public"."outstation_expense_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."password_setup_tokens"
    ADD CONSTRAINT "password_setup_tokens_created_by_login_id_fkey" FOREIGN KEY ("created_by_login_id") REFERENCES "public"."app_auth_users"("login_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."password_setup_tokens"
    ADD CONSTRAINT "password_setup_tokens_login_id_fkey" FOREIGN KEY ("login_id") REFERENCES "public"."app_auth_users"("login_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payroll_expenses"
    ADD CONSTRAINT "payroll_expenses_hr_id_fkey" FOREIGN KEY ("hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."payroll_expenses"
    ADD CONSTRAINT "payroll_expenses_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."payroll_expense_reports"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_manager_hr_id_fkey" FOREIGN KEY ("manager_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_vacancies"
    ADD CONSTRAINT "position_vacancies_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."salary_flags"
    ADD CONSTRAINT "salary_flags_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."salary_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."salary_records"
    ADD CONSTRAINT "salary_records_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."salary_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."sales_import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_manager_hr_id_fkey" FOREIGN KEY ("manager_hr_id") REFERENCES "public"."employees"("hr_id");



ALTER TABLE ONLY "public"."system_audit_logs"
    ADD CONSTRAINT "system_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."thread_members"
    ADD CONSTRAINT "thread_members_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_members"
    ADD CONSTRAINT "thread_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_access_profiles"
    ADD CONSTRAINT "user_access_profiles_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_access_profiles"
    ADD CONSTRAINT "user_access_profiles_hr_id_fkey" FOREIGN KEY ("hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_employee_hr_id_fkey" FOREIGN KEY ("employee_hr_id") REFERENCES "public"."employees"("hr_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_hr_id_fkey" FOREIGN KEY ("hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_manager_hr_id_fkey" FOREIGN KEY ("manager_hr_id") REFERENCES "public"."employees"("hr_id") ON UPDATE CASCADE ON DELETE SET NULL;



CREATE POLICY "Members can delete own messages" ON "public"."messages" FOR DELETE TO "authenticated" USING (("sender_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Members can insert messages" ON "public"."messages" FOR INSERT TO "authenticated" WITH CHECK ((("sender_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."thread_members" "tm"
  WHERE (("tm"."thread_id" = "messages"."thread_id") AND ("tm"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "Members can view messages" ON "public"."messages" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."thread_members" "tm"
  WHERE (("tm"."thread_id" = "messages"."thread_id") AND ("tm"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Thread member can remove self from thread" ON "public"."thread_members" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Thread members can view threads" ON "public"."threads" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."thread_members" "tm"
  WHERE (("tm"."thread_id" = "threads"."id") AND ("tm"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Users can join threads they are added to" ON "public"."thread_members" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."threads" "t"
  WHERE ("t"."id" = "thread_members"."thread_id")))));



CREATE POLICY "Users can view their thread memberships" ON "public"."thread_members" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."access_scopes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_auth_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_auth_users_select_own" ON "public"."app_auth_users" FOR SELECT TO "authenticated" USING (("auth_user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "app_auth_users_update_own" ON "public"."app_auth_users" FOR UPDATE TO "authenticated" USING (("auth_user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("auth_user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."areas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."auth_login_attempts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "auth_login_attempts_service_role_all" ON "public"."auth_login_attempts" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."brick_reference_imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brick_reference_imports_select_access" ON "public"."brick_reference_imports" FOR SELECT TO "authenticated" USING (("private"."phx_has_company_access"() OR "private"."phx_can_access_line"("line")));



CREATE POLICY "brick_reference_imports_service_role" ON "public"."brick_reference_imports" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "brick_reference_imports_write_access" ON "public"."brick_reference_imports" TO "authenticated" USING ("private"."phx_can_manage_geo"()) WITH CHECK ("private"."phx_can_manage_geo"());



ALTER TABLE "public"."brick_reference_rows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brick_reference_rows_select_access" ON "public"."brick_reference_rows" FOR SELECT TO "authenticated" USING (("private"."phx_has_company_access"() OR "private"."phx_can_access_line"("line") OR "private"."phx_can_access_employee"("dsm_hr_id")));



CREATE POLICY "brick_reference_rows_service_role" ON "public"."brick_reference_rows" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "brick_reference_rows_write_access" ON "public"."brick_reference_rows" TO "authenticated" USING ("private"."phx_can_manage_geo"()) WITH CHECK ("private"."phx_can_manage_geo"());



ALTER TABLE "public"."coaching_report_acknowledgments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coaching_report_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coaching_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coaching_score_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contract_renewal_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contract_renewal_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deny_all_job_offer_audit_logs" ON "public"."job_offer_audit_logs" TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "departments_read" ON "public"."departments" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."email_notification_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emp_docs_delete_own" ON "public"."employee_documents" FOR DELETE TO "authenticated" USING ((("uploaded_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_docs_insert_own" ON "public"."employee_documents" FOR INSERT TO "authenticated" WITH CHECK ((("uploaded_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_docs_select_own" ON "public"."employee_documents" FOR SELECT TO "authenticated" USING ((("uploaded_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_docs_update_own" ON "public"."employee_documents" FOR UPDATE TO "authenticated" USING ((("uploaded_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid")))))) WITH CHECK ((("uploaded_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_hist_delete_own" ON "public"."employee_history" FOR DELETE TO "authenticated" USING ((("changed_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_hist_insert_own" ON "public"."employee_history" FOR INSERT TO "authenticated" WITH CHECK ((("changed_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_hist_select_own" ON "public"."employee_history" FOR SELECT TO "authenticated" USING ((("changed_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "emp_hist_update_own" ON "public"."employee_history" FOR UPDATE TO "authenticated" USING ((("changed_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid")))))) WITH CHECK ((("changed_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("employee_hr_id" = ( SELECT "u"."hr_id"
   FROM "public"."users" "u"
  WHERE ("u"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."employee_compensation" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee_compensation_hr_admin_delete" ON "public"."employee_compensation" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_employees"());



CREATE POLICY "employee_compensation_hr_admin_insert" ON "public"."employee_compensation" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "employee_compensation_hr_admin_update" ON "public"."employee_compensation" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_employees"()) WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "employee_compensation_payroll_delete" ON "public"."employee_compensation" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_payroll"());



CREATE POLICY "employee_compensation_payroll_insert" ON "public"."employee_compensation" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "employee_compensation_payroll_update" ON "public"."employee_compensation" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_payroll"()) WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "employee_compensation_select_access" ON "public"."employee_compensation" FOR SELECT TO "authenticated" USING (("public"."current_access_can_manage_payroll"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text")))));



ALTER TABLE "public"."employee_contracts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_leave_balances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee_leave_balances_manage" ON "public"."employee_leave_balances" TO "authenticated" USING ("private"."phx_can_manage_leave"()) WITH CHECK ("private"."phx_can_manage_leave"());



CREATE POLICY "employee_leave_balances_select_access" ON "public"."employee_leave_balances" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_leave"() OR "private"."phx_can_access_employee"("employee_hr_id")));



ALTER TABLE "public"."employee_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee_locations_delete_access" ON "public"."employee_locations" FOR DELETE TO "authenticated" USING ("private"."phx_can_manage_workforce"());



CREATE POLICY "employee_locations_insert_access" ON "public"."employee_locations" FOR INSERT TO "authenticated" WITH CHECK (("private"."phx_can_manage_workforce"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



CREATE POLICY "employee_locations_select_access" ON "public"."employee_locations" FOR SELECT TO "authenticated" USING ("private"."phx_can_access_employee"("employee_hr_id"));



CREATE POLICY "employee_locations_service_role" ON "public"."employee_locations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "employee_locations_update_access" ON "public"."employee_locations" FOR UPDATE TO "authenticated" USING (("private"."phx_can_manage_workforce"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text"))))) WITH CHECK (("private"."phx_can_manage_workforce"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



ALTER TABLE "public"."employee_probation" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee_probation_delete_access" ON "public"."employee_probation" FOR DELETE TO "authenticated" USING ("private"."phx_can_manage_workforce"());



CREATE POLICY "employee_probation_insert_access" ON "public"."employee_probation" FOR INSERT TO "authenticated" WITH CHECK ("private"."phx_can_manage_workforce"());



CREATE POLICY "employee_probation_select_access" ON "public"."employee_probation" FOR SELECT TO "authenticated" USING ("private"."phx_can_access_employee"("employee_hr_id"));



CREATE POLICY "employee_probation_service_role" ON "public"."employee_probation" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "employee_probation_update_access" ON "public"."employee_probation" FOR UPDATE TO "authenticated" USING ("private"."phx_can_manage_workforce"()) WITH CHECK ("private"."phx_can_manage_workforce"());



ALTER TABLE "public"."employee_resignations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employees_delete_hr" ON "public"."employees" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_employees"());



CREATE POLICY "employees_dynamic_read" ON "public"."employees" FOR SELECT TO "authenticated" USING ("public"."current_access_can_see_employee"("hr_id", "manager_hr_id"));



CREATE POLICY "employees_insert_hr" ON "public"."employees" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "employees_update_hr" ON "public"."employees" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_employees"()) WITH CHECK ("public"."current_access_can_manage_employees"());



ALTER TABLE "public"."geo_bricks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "geo_bricks_select_access" ON "public"."geo_bricks" FOR SELECT TO "authenticated" USING (("private"."phx_has_company_access"() OR "private"."phx_can_access_line"("line") OR "private"."phx_can_access_employee"("employee_hr_id")));



CREATE POLICY "geo_bricks_service_role" ON "public"."geo_bricks" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "geo_bricks_write_access" ON "public"."geo_bricks" TO "authenticated" USING ("private"."phx_can_manage_geo"()) WITH CHECK ("private"."phx_can_manage_geo"());



ALTER TABLE "public"."geo_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "geo_locations_select_access" ON "public"."geo_locations" FOR SELECT TO "authenticated" USING (("private"."phx_has_company_access"() OR "private"."phx_can_access_line"("line")));



CREATE POLICY "geo_locations_service_role" ON "public"."geo_locations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "geo_locations_write_access" ON "public"."geo_locations" TO "authenticated" USING ("private"."phx_can_manage_geo"()) WITH CHECK ("private"."phx_can_manage_geo"());



ALTER TABLE "public"."geo_trip_routes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "geo_trip_routes_select_access" ON "public"."geo_trip_routes" FOR SELECT TO "authenticated" USING (("private"."phx_has_company_access"() OR "private"."phx_can_access_employee"("employee_hr_id")));



CREATE POLICY "geo_trip_routes_service_role" ON "public"."geo_trip_routes" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "geo_trip_routes_write_access" ON "public"."geo_trip_routes" TO "authenticated" USING ("private"."phx_can_manage_geo"()) WITH CHECK ("private"."phx_can_manage_geo"());



ALTER TABLE "public"."job_offer_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_offers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leave_accrual_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_accrual_runs_manage_select" ON "public"."leave_accrual_runs" FOR SELECT TO "authenticated" USING ("private"."phx_can_manage_leave"());



CREATE POLICY "leave_accrual_runs_service_role" ON "public"."leave_accrual_runs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."leave_approvals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_approvals_insert_access" ON "public"."leave_approvals" FOR INSERT TO "authenticated" WITH CHECK (("private"."phx_can_manage_leave"() OR ("lower"("approver_hr_id") = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



CREATE POLICY "leave_approvals_select_access" ON "public"."leave_approvals" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_leave"() OR ("lower"("approver_hr_id") = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text"))) OR (EXISTS ( SELECT 1
   FROM "public"."leave_requests" "lr"
  WHERE (("lr"."id" = "leave_approvals"."request_id") AND "private"."phx_can_access_employee"("lr"."employee_hr_id"))))));



ALTER TABLE "public"."leave_attachment_objects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_attachment_objects_select_access" ON "public"."leave_attachment_objects" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_leave"() OR "private"."phx_can_access_employee"("employee_hr_id")));



CREATE POLICY "leave_attachment_objects_service_role" ON "public"."leave_attachment_objects" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."leave_audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_audit_logs_manage_select" ON "public"."leave_audit_logs" FOR SELECT TO "authenticated" USING ("private"."phx_can_manage_leave"());



CREATE POLICY "leave_audit_logs_service_role" ON "public"."leave_audit_logs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."leave_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_policies_manage" ON "public"."leave_policies" TO "authenticated" USING ("private"."phx_can_manage_leave"()) WITH CHECK ("private"."phx_can_manage_leave"());



CREATE POLICY "leave_policies_select_active" ON "public"."leave_policies" FOR SELECT TO "authenticated" USING (("is_active" OR "private"."phx_can_manage_leave"()));



ALTER TABLE "public"."leave_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_requests_insert_self" ON "public"."leave_requests" FOR INSERT TO "authenticated" WITH CHECK (("private"."phx_can_manage_leave"() OR (("lower"("employee_hr_id") = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text"))) AND ("status" = ANY (ARRAY['draft'::"text", 'pending_manager'::"text"])) AND ("manager_status" = ANY (ARRAY['pending'::"text", 'not_required'::"text"])) AND ("hr_status" = ANY (ARRAY['pending'::"text", 'not_required'::"text"])) AND ("payroll_status" = ANY (ARRAY['not_required'::"text", 'pending'::"text"])))));



CREATE POLICY "leave_requests_select_access" ON "public"."leave_requests" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_leave"() OR "private"."phx_can_access_employee"("employee_hr_id") OR ("private"."phx_can_process_leave_payroll"() AND ("payroll_status" = ANY (ARRAY['pending'::"text", 'processed'::"text"])))));



CREATE POLICY "leave_requests_update_access" ON "public"."leave_requests" FOR UPDATE TO "authenticated" USING (("private"."phx_can_manage_leave"() OR "private"."phx_can_access_employee"("employee_hr_id") OR ("lower"("employee_hr_id") = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text"))))) WITH CHECK (("private"."phx_can_manage_leave"() OR "private"."phx_can_access_employee"("employee_hr_id") OR ("lower"("employee_hr_id") = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



ALTER TABLE "public"."leave_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_transactions_manage" ON "public"."leave_transactions" TO "authenticated" USING ("private"."phx_can_manage_leave"()) WITH CHECK ("private"."phx_can_manage_leave"());



CREATE POLICY "leave_transactions_select_access" ON "public"."leave_transactions" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_leave"() OR "private"."phx_can_access_employee"("employee_hr_id") OR ("private"."phx_can_process_leave_payroll"() AND (EXISTS ( SELECT 1
   FROM "public"."leave_requests" "lr"
  WHERE (("lr"."id" = "leave_transactions"."request_id") AND ("lr"."payroll_status" = ANY (ARRAY['pending'::"text", 'processed'::"text"]))))))));



ALTER TABLE "public"."leave_types" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leave_types_manage" ON "public"."leave_types" TO "authenticated" USING ("private"."phx_can_manage_leave"()) WITH CHECK ("private"."phx_can_manage_leave"());



CREATE POLICY "leave_types_select_active" ON "public"."leave_types" FOR SELECT TO "authenticated" USING (("is_active" OR "private"."phx_can_manage_leave"()));



ALTER TABLE "public"."lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_delivery_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_outbox" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."outstation_expense_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "outstation_expense_requests_delete_access" ON "public"."outstation_expense_requests" FOR DELETE TO "authenticated" USING ("private"."phx_can_manage_outstation"());



CREATE POLICY "outstation_expense_requests_insert_access" ON "public"."outstation_expense_requests" FOR INSERT TO "authenticated" WITH CHECK (("private"."phx_can_manage_outstation"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



CREATE POLICY "outstation_expense_requests_select_access" ON "public"."outstation_expense_requests" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_outstation"() OR "private"."phx_can_access_employee"("employee_hr_id")));



CREATE POLICY "outstation_expense_requests_service_role" ON "public"."outstation_expense_requests" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "outstation_expense_requests_update_access" ON "public"."outstation_expense_requests" FOR UPDATE TO "authenticated" USING (("private"."phx_can_manage_outstation"() OR (("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text"))) AND ("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text"]))))) WITH CHECK (("private"."phx_can_manage_outstation"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



ALTER TABLE "public"."outstation_location_audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "outstation_location_audit_logs_delete_access" ON "public"."outstation_location_audit_logs" FOR DELETE TO "authenticated" USING ("private"."phx_can_manage_outstation"());



CREATE POLICY "outstation_location_audit_logs_insert_access" ON "public"."outstation_location_audit_logs" FOR INSERT TO "authenticated" WITH CHECK (("private"."phx_can_manage_outstation"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("private"."phx_current_hr_id"(), ''::"text")))));



CREATE POLICY "outstation_location_audit_logs_select_access" ON "public"."outstation_location_audit_logs" FOR SELECT TO "authenticated" USING (("private"."phx_can_manage_outstation"() OR "private"."phx_can_access_employee"("employee_hr_id")));



CREATE POLICY "outstation_location_audit_logs_service_role" ON "public"."outstation_location_audit_logs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "outstation_location_audit_logs_update_access" ON "public"."outstation_location_audit_logs" FOR UPDATE TO "authenticated" USING ("private"."phx_can_manage_outstation"()) WITH CHECK ("private"."phx_can_manage_outstation"());



ALTER TABLE "public"."outstation_policy_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "outstation_policy_rules_select_access" ON "public"."outstation_policy_rules" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "outstation_policy_rules_service_role" ON "public"."outstation_policy_rules" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "outstation_policy_rules_write_access" ON "public"."outstation_policy_rules" TO "authenticated" USING ("private"."phx_can_manage_outstation"()) WITH CHECK ("private"."phx_can_manage_outstation"());



ALTER TABLE "public"."password_setup_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "password_setup_tokens_service_role" ON "public"."password_setup_tokens" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."payroll_expense_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_expense_reports_scoped_delete" ON "public"."payroll_expense_reports" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_payroll"());



CREATE POLICY "payroll_expense_reports_scoped_insert" ON "public"."payroll_expense_reports" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "payroll_expense_reports_scoped_update" ON "public"."payroll_expense_reports" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_payroll"()) WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "payroll_expense_reports_select_access" ON "public"."payroll_expense_reports" FOR SELECT TO "authenticated" USING (("public"."current_access_can_manage_payroll"() OR (EXISTS ( SELECT 1
   FROM "public"."payroll_expenses" "pe"
  WHERE (("pe"."report_id" = "payroll_expense_reports"."id") AND (("lower"(COALESCE("pe"."hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text"))) OR (EXISTS ( SELECT 1
           FROM "public"."employees" "e"
          WHERE (("lower"(COALESCE("e"."hr_id", ''::"text")) = "lower"(COALESCE("pe"."hr_id", ''::"text"))) AND "public"."current_access_can_see_employee"("e"."hr_id", "e"."manager_hr_id"))))))))));



ALTER TABLE "public"."payroll_expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_expenses_scoped_delete" ON "public"."payroll_expenses" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_payroll"());



CREATE POLICY "payroll_expenses_scoped_insert" ON "public"."payroll_expenses" FOR INSERT TO "authenticated" WITH CHECK (("public"."current_access_can_manage_payroll"() OR (("public"."current_phoenix_role"() = ANY (ARRAY['Employee'::"text", 'Medical Rep'::"text"])) AND ("lower"(COALESCE("hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text"))))));



CREATE POLICY "payroll_expenses_scoped_update" ON "public"."payroll_expenses" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_payroll"()) WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "payroll_expenses_select_access" ON "public"."payroll_expenses" FOR SELECT TO "authenticated" USING (("public"."current_access_can_manage_payroll"() OR ("lower"(COALESCE("hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text"))) OR (EXISTS ( SELECT 1
   FROM "public"."employees" "e"
  WHERE (("lower"("e"."hr_id") = "lower"("payroll_expenses"."hr_id")) AND "public"."current_access_can_see_employee"("e"."hr_id", "e"."manager_hr_id"))))));



ALTER TABLE "public"."payroll_resignation_candidates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payroll_resignation_candidates_service_role_all" ON "public"."payroll_resignation_candidates" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "phx_access_scopes_service_role" ON "public"."access_scopes" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_app_auth_users_service_role" ON "public"."app_auth_users" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_areas_service_role" ON "public"."areas" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_audit_logs_service_role" ON "public"."audit_logs" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_coaching_report_acknowledgments_service_role" ON "public"."coaching_report_acknowledgments" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_coaching_report_audit_logs_service_role" ON "public"."coaching_report_audit_logs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_coaching_reports_service_role" ON "public"."coaching_reports" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_coaching_score_items_service_role" ON "public"."coaching_score_items" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_contract_renewal_history_service_role" ON "public"."contract_renewal_history" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_contract_renewal_requests_service_role" ON "public"."contract_renewal_requests" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_departments_service_role" ON "public"."departments" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_email_notification_policies_service_role" ON "public"."email_notification_policies" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_employee_contracts_service_role" ON "public"."employee_contracts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_employee_documents_service_role" ON "public"."employee_documents" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_employee_history_service_role" ON "public"."employee_history" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_employee_leave_balances_service_role" ON "public"."employee_leave_balances" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_employee_resignations_service_role" ON "public"."employee_resignations" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_job_offer_audit_logs_service_role" ON "public"."job_offer_audit_logs" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_job_offers_service_role" ON "public"."job_offers" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_leave_approvals_service_role" ON "public"."leave_approvals" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_leave_policies_service_role" ON "public"."leave_policies" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_leave_requests_service_role" ON "public"."leave_requests" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_leave_transactions_service_role" ON "public"."leave_transactions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_leave_types_service_role" ON "public"."leave_types" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_lines_service_role" ON "public"."lines" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_notification_delivery_logs_service_role" ON "public"."notification_delivery_logs" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_notification_events_service_role" ON "public"."notification_events" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_notification_outbox_service_role" ON "public"."notification_outbox" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_permissions_service_role" ON "public"."permissions" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_platform_settings_service_role" ON "public"."platform_settings" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_position_vacancies_service_role" ON "public"."position_vacancies" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_positions_service_role" ON "public"."positions" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_public_holidays_service_role" ON "public"."public_holidays" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "phx_role_permission_overrides_service_role" ON "public"."role_permission_overrides" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_roles_service_role" ON "public"."roles" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_sales_audit_logs_service_role" ON "public"."sales_audit_logs" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_sales_import_batches_service_role" ON "public"."sales_import_batches" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_sales_records_service_role" ON "public"."sales_records" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_sales_role_overrides_service_role" ON "public"."sales_role_overrides" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_system_audit_logs_service_role" ON "public"."system_audit_logs" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_teams_service_role" ON "public"."teams" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_user_roles_service_role" ON "public"."user_roles" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "phx_users_service_role" ON "public"."users" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



ALTER TABLE "public"."platform_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."position_vacancies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."positions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_holidays" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_holidays_manage" ON "public"."public_holidays" TO "authenticated" USING ("private"."phx_can_manage_leave"()) WITH CHECK ("private"."phx_can_manage_leave"());



CREATE POLICY "public_holidays_select_active" ON "public"."public_holidays" FOR SELECT TO "authenticated" USING (("is_active" OR "private"."phx_can_manage_leave"()));



ALTER TABLE "public"."role_permission_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."salary_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "salary_batches_hr_admin_delete" ON "public"."salary_batches" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_batches_hr_admin_insert" ON "public"."salary_batches" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_batches_hr_admin_update" ON "public"."salary_batches" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_employees"()) WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_batches_payroll_delete" ON "public"."salary_batches" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_batches_payroll_insert" ON "public"."salary_batches" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_batches_payroll_update" ON "public"."salary_batches" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_payroll"()) WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_batches_select_access" ON "public"."salary_batches" FOR SELECT TO "authenticated" USING (("public"."current_access_can_manage_payroll"() OR (EXISTS ( SELECT 1
   FROM "public"."salary_records" "sr"
  WHERE (("sr"."batch_id" = "salary_batches"."id") AND (("lower"(COALESCE("sr"."hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text"))) OR (EXISTS ( SELECT 1
           FROM "public"."employees" "e"
          WHERE (("lower"(COALESCE("e"."hr_id", ''::"text")) = "lower"(COALESCE("sr"."hr_id", ''::"text"))) AND "public"."current_access_can_see_employee"("e"."hr_id", "e"."manager_hr_id"))))))))));



ALTER TABLE "public"."salary_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "salary_flags_hr_admin_delete" ON "public"."salary_flags" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_flags_hr_admin_insert" ON "public"."salary_flags" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_flags_hr_admin_update" ON "public"."salary_flags" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_employees"()) WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_flags_payroll_delete" ON "public"."salary_flags" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_flags_payroll_insert" ON "public"."salary_flags" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_flags_payroll_update" ON "public"."salary_flags" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_payroll"()) WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_flags_select_access" ON "public"."salary_flags" FOR SELECT TO "authenticated" USING (("public"."current_access_can_manage_payroll"() OR ("lower"(COALESCE("hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text")))));



ALTER TABLE "public"."salary_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "salary_records_hr_admin_delete" ON "public"."salary_records" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_records_hr_admin_insert" ON "public"."salary_records" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_records_hr_admin_update" ON "public"."salary_records" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_employees"()) WITH CHECK ("public"."current_access_can_manage_employees"());



CREATE POLICY "salary_records_payroll_delete" ON "public"."salary_records" FOR DELETE TO "authenticated" USING ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_records_payroll_insert" ON "public"."salary_records" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_records_payroll_update" ON "public"."salary_records" FOR UPDATE TO "authenticated" USING ("public"."current_access_can_manage_payroll"()) WITH CHECK ("public"."current_access_can_manage_payroll"());



CREATE POLICY "salary_records_select_access" ON "public"."salary_records" FOR SELECT TO "authenticated" USING (("public"."current_access_can_manage_payroll"() OR ("lower"(COALESCE("hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text")))));



ALTER TABLE "public"."sales_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_import_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_records_hr_delete" ON "public"."sales_records" FOR DELETE TO "authenticated" USING (("public"."current_access_is_super_admin"() OR "public"."current_access_is_hr"()));



CREATE POLICY "sales_records_hr_insert" ON "public"."sales_records" FOR INSERT TO "authenticated" WITH CHECK (("public"."current_access_is_super_admin"() OR "public"."current_access_is_hr"()));



CREATE POLICY "sales_records_hr_update" ON "public"."sales_records" FOR UPDATE TO "authenticated" USING (("public"."current_access_is_super_admin"() OR "public"."current_access_is_hr"())) WITH CHECK (("public"."current_access_is_super_admin"() OR "public"."current_access_is_hr"()));



CREATE POLICY "sales_records_select_access" ON "public"."sales_records" FOR SELECT TO "authenticated" USING (("public"."current_access_is_super_admin"() OR "public"."current_access_is_company_reader"() OR "public"."current_access_is_hr"() OR ("lower"(COALESCE("employee_hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text"))) OR ("lower"(COALESCE("manager_hr_id", ''::"text")) = "lower"(COALESCE("public"."current_access_hr_id"(), ''::"text")))));



ALTER TABLE "public"."sales_role_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sensitive_data_access_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sensitive_data_access_audit_insert_own" ON "public"."sensitive_data_access_audit" FOR INSERT TO "authenticated" WITH CHECK (("actor_auth_user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "sensitive_data_access_audit_select_privileged" ON "public"."sensitive_data_access_audit" FOR SELECT TO "authenticated" USING ("private"."phx_can_manage_workforce"());



CREATE POLICY "sensitive_data_access_audit_service_role" ON "public"."sensitive_data_access_audit" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."system_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."thread_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_access_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_access_profiles_read_self_or_super_admin" ON "public"."user_access_profiles" FOR SELECT TO "authenticated" USING ((("auth_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."current_access_is_super_admin"()));



CREATE POLICY "user_access_profiles_super_admin_delete" ON "public"."user_access_profiles" FOR DELETE TO "authenticated" USING ("public"."current_access_is_super_admin"());



CREATE POLICY "user_access_profiles_super_admin_insert" ON "public"."user_access_profiles" FOR INSERT TO "authenticated" WITH CHECK ("public"."current_access_is_super_admin"());



CREATE POLICY "user_access_profiles_update_self_or_super_admin" ON "public"."user_access_profiles" FOR UPDATE TO "authenticated" USING ("public"."current_access_is_super_admin"()) WITH CHECK ("public"."current_access_is_super_admin"());



ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_select_own" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "users_update_own" ON "public"."users" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



GRANT USAGE ON SCHEMA "private" TO "authenticated";
GRANT USAGE ON SCHEMA "private" TO "service_role";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "private"."log_sensitive_data_access"("p_table_name" "text", "p_row_ref" "text", "p_action" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "private"."log_sensitive_data_access"("p_table_name" "text", "p_row_ref" "text", "p_action" "text", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "private"."log_sensitive_data_access_event"("p_table_name" "text", "p_row_ref" "text", "p_action" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "private"."log_sensitive_data_access_event"("p_table_name" "text", "p_row_ref" "text", "p_action" "text", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_access_employee"("target_hr_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_access_employee"("target_hr_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_access_line"("target_line" "text") TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_access_line"("target_line" "text") TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_manage_geo"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_manage_geo"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_manage_leave"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_manage_leave"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_manage_outstation"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_manage_outstation"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_manage_workforce"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_manage_workforce"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_can_process_leave_payroll"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_can_process_leave_payroll"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_current_hr_id"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_current_hr_id"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_current_role"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_current_role"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_current_scope"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_current_scope"() TO "service_role";



GRANT ALL ON FUNCTION "private"."phx_has_company_access"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."phx_has_company_access"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_offer_and_create_employee"("p_offer_id" "uuid", "p_hr_id" "text", "p_hire_date" "date", "p_birth_date" "date", "p_contract_start_date" "date", "p_contract_renewal_date" "date", "p_probation_end_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_offer_and_create_employee"("p_offer_id" "uuid", "p_hr_id" "text", "p_hire_date" "date", "p_birth_date" "date", "p_contract_start_date" "date", "p_contract_renewal_date" "date", "p_probation_end_date" "date") TO "service_role";



GRANT ALL ON SEQUENCE "public"."coaching_report_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."coaching_report_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."coaching_report_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."coaching_reports" TO "service_role";



REVOKE ALL ON FUNCTION "public"."acknowledge_coaching_report"("p_report_id" "uuid", "p_employee_hr_id" "text", "p_acknowledgment_text" "text", "p_ip_address" "text", "p_user_agent" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."acknowledge_coaching_report"("p_report_id" "uuid", "p_employee_hr_id" "text", "p_acknowledgment_text" "text", "p_ip_address" "text", "p_user_agent" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_lifecycle_notification_event"("p_category" "text", "p_employee_hr_id" "text", "p_scheduled_for" "date", "p_subject" "text", "p_metadata" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_lifecycle_notification_event"("p_category" "text", "p_employee_hr_id" "text", "p_scheduled_for" "date", "p_subject" "text", "p_metadata" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_access_can_manage_employees"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_can_manage_employees"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_can_manage_employees"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_can_manage_payroll"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_can_manage_payroll"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_access_can_manage_payroll"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_access_can_see_employee"("employee_hr_id" "text", "employee_manager_hr_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_can_see_employee"("employee_hr_id" "text", "employee_manager_hr_id" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_can_see_employee"("employee_hr_id" "text", "employee_manager_hr_id" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_hr_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_hr_id"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_hr_id"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_is_admin"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_is_admin"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_is_company_reader"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_is_company_reader"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_access_is_company_reader"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_access_is_finance"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_is_finance"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_access_is_finance"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_access_is_hr"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_is_hr"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_access_is_hr"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_access_is_super_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_is_super_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_access_is_super_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_access_line"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_line"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_line"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_manager_hr_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_manager_hr_id"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_manager_hr_id"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_role"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_access_role"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_access_scope"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_access_scope"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_access_scope"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_hr_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_hr_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_phoenix_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_phoenix_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_phoenix_role"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."finalize_manual_employee_lifecycle"("p_employee_hr_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_manual_employee_lifecycle"("p_employee_hr_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_get_admin_command_center_data"("p_access_scope" "text", "p_access_role" "text", "p_access_hr_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_get_admin_command_center_data"("p_access_scope" "text", "p_access_role" "text", "p_access_hr_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_get_audit_module_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_get_audit_module_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_get_broken_auth_accounts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_get_broken_auth_accounts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_get_command_center_metrics"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_get_command_center_metrics"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_get_employee_directory_paginated"("p_search" "text", "p_line_id" bigint, "p_area_id" bigint, "p_department_id" bigint, "p_team_id" bigint, "p_status" "text", "p_page" integer, "p_page_size" integer, "p_access_scope" "text", "p_access_role" "text", "p_access_hr_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_get_employee_directory_paginated"("p_search" "text", "p_line_id" bigint, "p_area_id" bigint, "p_department_id" bigint, "p_team_id" bigint, "p_status" "text", "p_page" integer, "p_page_size" integer, "p_access_scope" "text", "p_access_role" "text", "p_access_hr_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_get_employee_hierarchy"("p_root_hr_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_get_employee_hierarchy"("p_root_hr_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."generate_employee_lifecycle_notifications"("p_employee_hr_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_employee_lifecycle_notifications"("p_employee_hr_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_approve_accepted_offer"("p_offer_id" "uuid", "p_approved_by_hr_id" "text", "p_employee_hr_id" "text", "p_gross_salary" numeric, "p_fuel_allowance" numeric, "p_extra_cost_of_living" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_approve_accepted_offer"("p_offer_id" "uuid", "p_approved_by_hr_id" "text", "p_employee_hr_id" "text", "p_gross_salary" numeric, "p_fuel_allowance" numeric, "p_extra_cost_of_living" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."phx_autofill_replacement_vacancy_from_employee_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."phx_autofill_replacement_vacancy_from_employee_insert"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_create_salary_batch"("p_month" integer, "p_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_created_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_create_salary_batch"("p_month" integer, "p_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_created_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_delete_salary_batch"("p_batch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_delete_salary_batch"("p_batch_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_import_approved_expenses_to_payroll"("p_month" integer, "p_year" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_import_approved_expenses_to_payroll"("p_month" integer, "p_year" integer) TO "service_role";



GRANT ALL ON TABLE "public"."employee_leave_balances" TO "service_role";
GRANT SELECT ON TABLE "public"."employee_leave_balances" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."phx_leave_adjust_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_amount" numeric, "p_reason" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_adjust_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_amount" numeric, "p_reason" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_available"("p_opening" numeric, "p_accrued" numeric, "p_adjusted" numeric, "p_carry_forward" numeric, "p_consumed" numeric, "p_pending" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_available"("p_opening" numeric, "p_accrued" numeric, "p_adjusted" numeric, "p_carry_forward" numeric, "p_consumed" numeric, "p_pending" numeric) TO "service_role";



GRANT ALL ON TABLE "public"."leave_requests" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."leave_requests" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."phx_leave_cancel_request_atomic"("p_request_id" "uuid", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_cancel_request_atomic"("p_request_id" "uuid", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_consume_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_consume_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_ensure_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_ensure_balance_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_hr_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_decision" "text", "p_correlation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_hr_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_decision" "text", "p_correlation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_manager_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_manager_decision_atomic"("p_request_id" "uuid", "p_decision" "text", "p_comment" "text", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_record_delta_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_transaction_type" "text", "p_amount" numeric, "p_request_id" "uuid", "p_notes" "text", "p_created_by" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_record_delta_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_transaction_type" "text", "p_amount" numeric, "p_request_id" "uuid", "p_notes" "text", "p_created_by" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_release_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_release_pending_atomic"("p_request" "public"."leave_requests", "p_actor_hr_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_run_accrual_atomic"("p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_month" integer, "p_entries" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_run_accrual_atomic"("p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_year" integer, "p_month" integer, "p_entries" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_correlation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_leave_submit_request_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_total_calendar_days" numeric, "p_total_working_days" numeric, "p_reason" "text", "p_attachment_url" "text", "p_status" "text", "p_manager_status" "text", "p_hr_status" "text", "p_payroll_status" "text", "p_should_consume" boolean, "p_allow_negative_balance" boolean, "p_accruals" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_leave_type_id" "uuid", "p_payment_status" "text", "p_payment_reason" "text", "p_duration_unit" "text", "p_correlation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_leave_submit_request_atomic"("p_employee_hr_id" "text", "p_leave_type_id" "uuid", "p_policy_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_total_calendar_days" numeric, "p_total_working_days" numeric, "p_reason" "text", "p_attachment_url" "text", "p_status" "text", "p_manager_status" "text", "p_hr_status" "text", "p_payroll_status" "text", "p_should_consume" boolean, "p_allow_negative_balance" boolean, "p_accruals" "jsonb", "p_actor_hr_id" "text", "p_actor_role" "text", "p_balance_leave_type_id" "uuid", "p_payment_status" "text", "p_payment_reason" "text", "p_duration_unit" "text", "p_correlation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_prevent_closed_salary_batch_delete"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_prevent_closed_salary_batch_delete"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_prevent_closed_salary_batch_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_prevent_closed_salary_batch_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_prevent_closed_salary_detail_mutation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_prevent_closed_salary_detail_mutation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_prevent_duplicate_salary_period"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_prevent_duplicate_salary_period"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_prevent_employee_hr_id_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_prevent_employee_hr_id_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_reassign_replacement_ownership"("p_previous_hr_id" "text", "p_replacement_hr_id" "text", "p_effective_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_reassign_replacement_ownership"("p_previous_hr_id" "text", "p_replacement_hr_id" "text", "p_effective_date" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_release_terminal_manager_ownership"("p_previous_hr_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_release_terminal_manager_ownership"("p_previous_hr_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."phx_release_terminal_manager_ownership_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."phx_release_terminal_manager_ownership_trigger"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_replace_salary_batch"("p_batch_id" "uuid", "p_expected_month" integer, "p_expected_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_updated_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_replace_salary_batch"("p_batch_id" "uuid", "p_expected_month" integer, "p_expected_year" integer, "p_file_name" "text", "p_uploaded_by" "text", "p_records" "jsonb", "p_flags" "jsonb", "p_updated_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."phx_resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_effective_date" "date", "p_submitted_date" "date", "p_employee_status" "text", "p_reason" "text", "p_workflow_notes" "text", "p_actor" "text", "p_submitted_by_hr_id" "text", "p_vacancy_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phx_resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_effective_date" "date", "p_submitted_date" "date", "p_employee_status" "text", "p_reason" "text", "p_workflow_notes" "text", "p_actor" "text", "p_submitted_by_hr_id" "text", "p_vacancy_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_resignation_date" "date", "p_last_working_date" "date", "p_reason" "text", "p_notes" "text", "p_submitted_by_hr_id" "text", "p_create_vacancy" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resign_employee_and_open_vacancy"("p_employee_hr_id" "text", "p_resignation_date" "date", "p_last_working_date" "date", "p_reason" "text", "p_notes" "text", "p_submitted_by_hr_id" "text", "p_create_vacancy" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_coaching_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_coaching_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_coaching_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_coaching_report"("p_report_id" "uuid", "p_actor_hr_id" "text", "p_area_of_development" "text", "p_strength_points" "text", "p_general_remarks" "text", "p_scores" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_coaching_report"("p_report_id" "uuid", "p_actor_hr_id" "text", "p_area_of_development" "text", "p_strength_points" "text", "p_general_remarks" "text", "p_scores" "jsonb") TO "service_role";



GRANT SELECT ON TABLE "private"."security_definer_function_exceptions" TO "service_role";



GRANT ALL ON TABLE "public"."access_scopes" TO "service_role";



GRANT ALL ON TABLE "public"."app_auth_users" TO "service_role";



GRANT ALL ON TABLE "public"."areas" TO "service_role";



GRANT ALL ON SEQUENCE "public"."areas_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."areas_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."areas_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."auth_login_attempts" TO "anon";
GRANT ALL ON TABLE "public"."auth_login_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."auth_login_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."brick_reference_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."brick_reference_imports" TO "service_role";



GRANT ALL ON SEQUENCE "public"."brick_reference_imports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."brick_reference_imports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."brick_reference_imports_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."brick_reference_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."brick_reference_rows" TO "service_role";



GRANT ALL ON SEQUENCE "public"."brick_reference_rows_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."brick_reference_rows_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."brick_reference_rows_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."coaching_quarterly_summary" TO "service_role";



GRANT ALL ON TABLE "public"."coaching_report_acknowledgments" TO "service_role";



GRANT ALL ON TABLE "public"."coaching_report_audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."employees" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."employees" TO "authenticated";



GRANT ALL ON TABLE "public"."lines" TO "service_role";



GRANT ALL ON TABLE "public"."teams" TO "service_role";



GRANT ALL ON TABLE "public"."coaching_reports_summary" TO "service_role";



GRANT ALL ON TABLE "public"."coaching_score_items" TO "service_role";



GRANT ALL ON TABLE "public"."contract_renewal_history" TO "service_role";



GRANT ALL ON TABLE "public"."contract_renewal_requests" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."departments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."departments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."departments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."email_notification_policies" TO "service_role";



GRANT ALL ON TABLE "public"."employee_compensation" TO "service_role";
GRANT SELECT ON TABLE "public"."employee_compensation" TO "authenticated";



GRANT ALL ON TABLE "public"."employee_contracts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."employee_contracts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_contracts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_contracts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."employee_documents" TO "service_role";



GRANT ALL ON TABLE "public"."employee_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."employee_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."employee_linkage_health" TO "anon";
GRANT ALL ON TABLE "public"."employee_linkage_health" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_linkage_health" TO "service_role";



GRANT ALL ON TABLE "public"."employee_linkage_health_summary" TO "anon";
GRANT ALL ON TABLE "public"."employee_linkage_health_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_linkage_health_summary" TO "service_role";



GRANT ALL ON TABLE "public"."employee_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_locations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."employee_locations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_locations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_locations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."employee_probation" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_probation" TO "service_role";



GRANT ALL ON SEQUENCE "public"."employee_probation_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_probation_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_probation_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."employee_resignations" TO "service_role";



GRANT ALL ON TABLE "public"."geo_bricks" TO "authenticated";
GRANT ALL ON TABLE "public"."geo_bricks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."geo_bricks_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."geo_bricks_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."geo_bricks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."geo_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."geo_locations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."geo_locations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."geo_locations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."geo_locations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."geo_trip_routes" TO "authenticated";
GRANT ALL ON TABLE "public"."geo_trip_routes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."geo_trip_routes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."geo_trip_routes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."geo_trip_routes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."job_offer_audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."job_offer_audit_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."job_offer_audit_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."job_offer_audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."job_offers" TO "service_role";



GRANT ALL ON TABLE "public"."leave_accrual_runs" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_accrual_runs" TO "authenticated";



GRANT ALL ON TABLE "public"."leave_approvals" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_approvals" TO "authenticated";



GRANT ALL ON TABLE "public"."leave_attachment_objects" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_attachment_objects" TO "authenticated";



GRANT ALL ON TABLE "public"."leave_audit_logs" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_audit_logs" TO "authenticated";



GRANT ALL ON TABLE "public"."leave_notification_attempts" TO "anon";
GRANT ALL ON TABLE "public"."leave_notification_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."leave_notification_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."leave_policies" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_policies" TO "authenticated";



GRANT ALL ON TABLE "public"."leave_request_events" TO "anon";
GRANT ALL ON TABLE "public"."leave_request_events" TO "authenticated";
GRANT ALL ON TABLE "public"."leave_request_events" TO "service_role";



GRANT ALL ON TABLE "public"."leave_transactions" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_transactions" TO "authenticated";



GRANT ALL ON TABLE "public"."leave_types" TO "service_role";
GRANT SELECT ON TABLE "public"."leave_types" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."lines_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lines_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lines_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."notification_delivery_logs" TO "service_role";



GRANT ALL ON TABLE "public"."notification_events" TO "service_role";



GRANT ALL ON TABLE "public"."notification_outbox" TO "service_role";



GRANT ALL ON TABLE "public"."outstation_expense_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."outstation_expense_requests" TO "service_role";



GRANT ALL ON SEQUENCE "public"."outstation_expense_requests_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."outstation_expense_requests_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."outstation_expense_requests_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."outstation_location_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."outstation_location_audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."outstation_location_audit_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."outstation_location_audit_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."outstation_location_audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."outstation_policy_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."outstation_policy_rules" TO "service_role";



GRANT ALL ON SEQUENCE "public"."outstation_policy_rules_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."outstation_policy_rules_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."outstation_policy_rules_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."password_setup_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_expense_reports" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payroll_expense_reports" TO "authenticated";



GRANT ALL ON TABLE "public"."payroll_expenses" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payroll_expenses" TO "authenticated";



GRANT ALL ON TABLE "public"."payroll_resignation_candidates" TO "anon";
GRANT ALL ON TABLE "public"."payroll_resignation_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_resignation_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."platform_settings" TO "service_role";



GRANT ALL ON TABLE "public"."position_vacancies" TO "service_role";



GRANT ALL ON SEQUENCE "public"."position_vacancies_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."position_vacancies_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."position_vacancies_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."positions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."positions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."positions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."positions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."public_holidays" TO "service_role";
GRANT SELECT ON TABLE "public"."public_holidays" TO "authenticated";



GRANT ALL ON TABLE "public"."role_permission_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."salary_batches" TO "service_role";
GRANT SELECT ON TABLE "public"."salary_batches" TO "authenticated";



GRANT ALL ON TABLE "public"."salary_flags" TO "service_role";
GRANT SELECT ON TABLE "public"."salary_flags" TO "authenticated";



GRANT ALL ON TABLE "public"."salary_records" TO "service_role";
GRANT SELECT ON TABLE "public"."salary_records" TO "authenticated";



GRANT ALL ON TABLE "public"."sales_audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sales_audit_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sales_audit_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sales_audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sales_import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."sales_records" TO "service_role";
GRANT SELECT ON TABLE "public"."sales_records" TO "authenticated";



GRANT ALL ON TABLE "public"."sales_role_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."sales_employee_linkage_health" TO "anon";
GRANT ALL ON TABLE "public"."sales_employee_linkage_health" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_employee_linkage_health" TO "service_role";



GRANT ALL ON TABLE "public"."sales_employee_linkage_health_summary" TO "anon";
GRANT ALL ON TABLE "public"."sales_employee_linkage_health_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_employee_linkage_health_summary" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sales_records_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sales_records_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sales_records_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sensitive_data_access_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."sensitive_data_access_audit" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sensitive_data_access_audit_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sensitive_data_access_audit_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sensitive_data_access_audit_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."system_audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."teams_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."teams_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."teams_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."thread_members" TO "anon";
GRANT ALL ON TABLE "public"."thread_members" TO "authenticated";
GRANT ALL ON TABLE "public"."thread_members" TO "service_role";



GRANT ALL ON TABLE "public"."threads" TO "anon";
GRANT ALL ON TABLE "public"."threads" TO "authenticated";
GRANT ALL ON TABLE "public"."threads" TO "service_role";



GRANT ALL ON TABLE "public"."user_access_profiles" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_access_profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."v_active_organogram" TO "anon";
GRANT ALL ON TABLE "public"."v_active_organogram" TO "authenticated";
GRANT ALL ON TABLE "public"."v_active_organogram" TO "service_role";



GRANT ALL ON TABLE "public"."v_employee_locations_masked" TO "authenticated";
GRANT ALL ON TABLE "public"."v_employee_locations_masked" TO "service_role";



GRANT ALL ON TABLE "public"."v_employee_portal_payslips" TO "anon";
GRANT ALL ON TABLE "public"."v_employee_portal_payslips" TO "authenticated";
GRANT ALL ON TABLE "public"."v_employee_portal_payslips" TO "service_role";



GRANT ALL ON TABLE "public"."v_employee_portal_salary_history" TO "anon";
GRANT ALL ON TABLE "public"."v_employee_portal_salary_history" TO "authenticated";
GRANT ALL ON TABLE "public"."v_employee_portal_salary_history" TO "service_role";



GRANT ALL ON TABLE "public"."v_employee_portal_sales" TO "anon";
GRANT ALL ON TABLE "public"."v_employee_portal_sales" TO "authenticated";
GRANT ALL ON TABLE "public"."v_employee_portal_sales" TO "service_role";



GRANT ALL ON TABLE "public"."v_employee_portal_sales_filters" TO "anon";
GRANT ALL ON TABLE "public"."v_employee_portal_sales_filters" TO "authenticated";
GRANT ALL ON TABLE "public"."v_employee_portal_sales_filters" TO "service_role";



GRANT ALL ON TABLE "public"."v_hr_id_orphan_audit" TO "anon";
GRANT ALL ON TABLE "public"."v_hr_id_orphan_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."v_hr_id_orphan_audit" TO "service_role";



GRANT ALL ON TABLE "public"."v_lifecycle_dashboard" TO "anon";
GRANT ALL ON TABLE "public"."v_lifecycle_dashboard" TO "authenticated";
GRANT ALL ON TABLE "public"."v_lifecycle_dashboard" TO "service_role";



GRANT ALL ON TABLE "public"."v_payroll_eligible_employees" TO "anon";
GRANT ALL ON TABLE "public"."v_payroll_eligible_employees" TO "authenticated";
GRANT ALL ON TABLE "public"."v_payroll_eligible_employees" TO "service_role";



GRANT ALL ON TABLE "public"."v_probation_tracker" TO "anon";
GRANT ALL ON TABLE "public"."v_probation_tracker" TO "authenticated";
GRANT ALL ON TABLE "public"."v_probation_tracker" TO "service_role";



GRANT ALL ON TABLE "public"."v_unified_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."v_unified_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."v_unified_audit_logs" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







